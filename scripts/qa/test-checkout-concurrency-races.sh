#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
if [[ -z "$project_id" ]] \
  || [[ ! "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database is unavailable" >&2
  exit 1
fi

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-checkout-convergence.XXXXXX")"
owner_pid=""
waiter_pid=""
qa_users=()
growth_backup_hex=""
growth_fixture_installed="false"
withdrawal_offer_id=""

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

db_value() {
  db_psql -Atq -c "$1"
}


# 같은 유저의 동시 checkout 이 단일 intent·단일 청약철회 증거로 수렴함을 증명한다
# — 최신(전체 마이그레이션 적용) 스키마 대상. 구 test-checkout-convergence-races.sh
# (구 시대 mixed-version 하네스, CI 단일 스키마 재설계로 폐기)의 시대 무관
# 케이스(A2: 영구 19-arg 경계의 owner/waiter 수렴 + response-loss retry)를 이식.
# 12-arg 시절 케이스는 오버로드가 0092 에서 드롭되어 재현 불가·불필요.

owner_pid=""
waiter_pid=""
qa_users=()
growth_backup_hex=""
growth_fixture_installed="false"
withdrawal_offer_id=""

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-checkout-concurrency.XXXXXX")"

cleanup() {
  original_status=$?
  set +e
  exec 3>&-
  for pid in "$owner_pid" "$waiter_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if (( ${#qa_users[@]} > 0 )); then
    user_sql=""
    for user_id in "${qa_users[@]}"; do
      if [[ "$user_id" =~ ^[0-9a-f-]{36}$ ]]; then
        if [[ -n "$user_sql" ]]; then user_sql+=","; fi
        user_sql+="'$user_id'::uuid"
      fi
    done
    if [[ -n "$user_sql" ]]; then
      db_psql -q -c "
        begin;
        select pg_catalog.set_config(
          'boss_paegi.privacy_retention_delete',
          '008904:v1',
          true
        );
        delete from public.orders where user_id in ($user_sql);
        delete from auth.users where id in ($user_sql);
        commit;
      " >/dev/null 2>&1
    fi
  fi
  if [[ "$withdrawal_offer_id" =~ ^[0-9a-f-]{36}$ ]]; then
    db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.commerce_display_evidence',
        'prune:008905:v1',
        true
      );
      delete from public.commerce_display_evidence
       where id = '$withdrawal_offer_id'::uuid;
      commit;
    " >/dev/null 2>&1
  fi
  restore_failed=0
  if [[ "$growth_fixture_installed" == "true" ]]; then
    if [[ -n "$growth_backup_hex" && "$growth_backup_hex" =~ ^[0-9a-f]+$ ]]; then
      db_psql -q -c "
        delete from public.app_settings where key = 'growth_levers';
        insert into public.app_settings
        select restored.*
          from pg_catalog.json_populate_record(
            null::public.app_settings,
            pg_catalog.convert_from(
              pg_catalog.decode('$growth_backup_hex', 'hex'),
              'UTF8'
            )::json
          ) as restored;
      " >/dev/null 2>&1 || restore_failed=1
    elif [[ -z "$growth_backup_hex" ]]; then
      db_psql -q -c "
        delete from public.app_settings where key = 'growth_levers';
      " >/dev/null 2>&1 || restore_failed=1
    else
      restore_failed=1
    fi
  fi
  for artifact in "$qa_tmp_dir"/*; do
    [[ -e "$artifact" ]] && rm -f "$artifact"
  done
  rmdir "$qa_tmp_dir" >/dev/null 2>&1
  if (( restore_failed != 0 )); then
    echo "checkout concurrency QA failed to restore growth_levers" >&2
    if (( original_status == 0 )); then exit 1; fi
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "checkout concurrency QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      tail -n 30 "$output" >&2
    fi
  done
  exit 1
}

# 세션 동기화는 공용 lib — 상한 120s(러너 속도 무관)·타임아웃 시 세션 스냅샷 덤프.
source scripts/qa/lib/wait-sync.sh

growth_backup_hex="$(
  db_value "
    select pg_catalog.encode(
             pg_catalog.convert_to(
               pg_catalog.row_to_json(s)::text,
               'UTF8'
             ),
             'hex'
           )
      from public.app_settings s
     where s.key = 'growth_levers';
  "
)"
[[ -z "$growth_backup_hex" || "$growth_backup_hex" =~ ^[0-9a-f]+$ ]] \
  || fail "could not safely back up growth_levers"

db_psql -q -c "
  insert into public.app_settings(key, value, version, updated_by, updated_at)
  values (
    'growth_levers',
    pg_catalog.jsonb_build_object(
      'creditsEnabled', false,
      'products', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'qa_atomic_checkout',
          'goodname', 'QA atomic checkout',
          'price', 1700,
          'credits', 7,
          'active', true
        )
      )
    ),
    1,
    null,
    pg_catalog.now()
  )
  on conflict (key) do update set value = excluded.value;
" >/dev/null
growth_fixture_installed="true"

product_id="qa_atomic_checkout"
amount="1700"
credits="7"
withdrawal_user="$(db_value "select pg_catalog.gen_random_uuid();")"
qa_users=("$withdrawal_user")
[[ "$withdrawal_user" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "PostgreSQL returned an invalid user UUID"
db_psql -q -c "
  insert into auth.users(id, email) values
    ('$withdrawal_user'::uuid, 'checkout-withdrawal-$withdrawal_user@test.local');
" >/dev/null

uuid_withdrawal_owner="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_withdrawal_waiter="$(db_value "select pg_catalog.gen_random_uuid();")"
withdrawal_request_id="$(db_value "select pg_catalog.gen_random_uuid();")"
withdrawal_offer_id="$(db_value "select pg_catalog.gen_random_uuid();")"
for order_id in \
  "$uuid_withdrawal_owner" "$uuid_withdrawal_waiter" \
  "$withdrawal_request_id" "$withdrawal_offer_id"; do
  [[ "$order_id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid fixture UUID"
done

db_psql -q >/dev/null <<SQL
begin;
select pg_catalog.set_config(
  'boss_paegi.commerce_display_evidence',
  'record:008905:v1',
  true
);
with offer(snapshot, displayed_at) as (
  select
    pg_catalog.jsonb_build_object(
      'schemaVersion', 1,
      'copyVersion', 'credits-offer-2026-08-19-v3',
      'surface', 'credits_offer',
      'payMode', 'live',
      'products', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'qa_atomic_checkout',
          'goodname', 'QA atomic checkout',
          'priceKrwVatIncluded', 1700,
          'credits', 7
        )
      ),
      'channels', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'method', 'card',
          'label', '카드'
        )
      ),
      'displayCopy', pg_catalog.jsonb_build_object(
        'supply',
          '생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.',
        'validity',
          '구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.',
        'refund',
          '미사용 생성권은 환불받을 수 있어요(무료 지급분 제외, 일부 사용 시 남은 수량만큼).',
        'refundReferencePrefix',
          '기준·차감 순서·절차는',
        'termsLinkLabel', '이용약관 제10조',
        'refundReferenceSuffix', '를 확인해주세요.'
      )
    ),
    pg_catalog.clock_timestamp()
)
insert into public.commerce_display_evidence(
  id,
  surface,
  snapshot,
  snapshot_sha256,
  display_kst_date,
  first_displayed_at,
  last_displayed_at
)
select
  '$withdrawal_offer_id'::uuid,
  'credits_offer',
  offer.snapshot,
  pg_catalog.encode(
    extensions.digest(
      pg_catalog.convert_to(offer.snapshot::text, 'UTF8'),
      'sha256'
    ),
    'hex'
  ),
  (offer.displayed_at at time zone 'Asia/Seoul')::date,
  offer.displayed_at,
  offer.displayed_at
from offer;
commit;
SQL
withdrawal_offer_hash="$(
  db_value "
    select snapshot_sha256
      from public.commerce_display_evidence
     where id = '$withdrawal_offer_id'::uuid;
  "
)"
[[ "$withdrawal_offer_hash" =~ ^[0-9a-f]{64}$ ]] \
  || fail "withdrawal offer evidence fixture hash is invalid"

# A2) 영구 19-arg checkout 경계: owner 가 주문+청약철회 증거를 한 트랜잭션으로
# 잡고 있는 동안, 같은 request id 의 response-loss retry(다른 후보 UUID)가
# user boundary 에서 실제로 대기했다가 첫 영수증으로 수렴해야 한다.
owner_app="bp_qa_checkout_withdrawal_owner_$$"
waiter_app="bp_qa_checkout_withdrawal_waiter_$$"
mkfifo "$qa_tmp_dir/withdrawal.fifo"
db_psql -qAt <"$qa_tmp_dir/withdrawal.fifo" \
  >"$qa_tmp_dir/withdrawal-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/withdrawal.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select concat_ws(
    '|',
    ack->>'outcome',
    ack->>'order_uuid',
    ack->>'withdrawal_evidence_id',
    ack->>'checkout_request_id'
  )
    from (
      select public.create_or_reuse_pending_order(
        '$withdrawal_user'::uuid,
        '$uuid_withdrawal_owner'::uuid,
        '$product_id',
        $amount,
        $credits,
        '${uuid_withdrawal_owner//-/}',
        'portone',
        'card',
        false,
        'store-qa',
        'KRW',
        'channel-card-live',
        '$withdrawal_request_id'::uuid,
        'QA atomic checkout',
        '$withdrawal_offer_id'::uuid,
        '$withdrawal_offer_hash',
        'checkout-withdrawal-limit-2026-08-19-v2',
        '이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.',
        true
      ) as ack
    ) created;
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "affirmative checkout owner to hold its atomic transaction"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select concat_ws(
    '|',
    ack->>'outcome',
    ack->>'order_uuid',
    ack->>'withdrawal_evidence_id',
    ack->>'checkout_request_id'
  )
    from (
      select public.create_or_reuse_pending_order(
        '$withdrawal_user'::uuid,
        '$uuid_withdrawal_waiter'::uuid,
        '$product_id',
        $amount,
        $credits,
        '${uuid_withdrawal_waiter//-/}',
        'portone',
        'card',
        false,
        'store-rotated',
        'KRW',
        'channel-card-rotated',
        '$withdrawal_request_id'::uuid,
        'QA atomic checkout',
        '$withdrawal_offer_id'::uuid,
        '$withdrawal_offer_hash',
        'checkout-withdrawal-limit-2026-08-19-v2',
        '이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.',
        true
      ) as ack
    ) replayed;
" >"$qa_tmp_dir/withdrawal-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "affirmative checkout retry to wait on the user boundary"
printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "affirmative checkout owner failed"
owner_pid=""
wait "$waiter_pid" || fail "affirmative checkout waiter failed"
waiter_pid=""

owner_receipt="$(tail -n 1 "$qa_tmp_dir/withdrawal-owner.out")"
waiter_receipt="$(tail -n 1 "$qa_tmp_dir/withdrawal-waiter.out")"
IFS='|' read -r \
  owner_outcome owner_order owner_evidence owner_request <<<"$owner_receipt"
[[ "$owner_outcome" == "ready" \
   && "$owner_order" == "$uuid_withdrawal_owner" \
   && "$owner_evidence" =~ ^[0-9a-f-]{36}$ \
   && "$owner_request" == "$withdrawal_request_id" ]] \
  || fail "affirmative checkout owner receipt is invalid"
[[ "$waiter_receipt" == \
     "reused|$uuid_withdrawal_owner|$owner_evidence|$withdrawal_request_id" ]] \
  || fail "affirmative checkout retry did not converge on one evidence receipt"
withdrawal_state="$(
  db_value "
    select
      (select pg_catalog.count(*)::text
         from public.orders
        where user_id = '$withdrawal_user'::uuid)
      || '|' ||
      (select pg_catalog.count(*)::text
         from public.checkout_withdrawal_acceptance_evidence
        where user_id = '$withdrawal_user'::uuid)
      || '|' ||
      (select (e.order_uuid = '$uuid_withdrawal_owner'::uuid)::text
                || '|' || e.confirmed::text
         from public.checkout_withdrawal_acceptance_evidence e
        where e.id = '$owner_evidence'::uuid);
  "
)"
[[ "$withdrawal_state" == "1|1|true|true" ]] \
  || fail "order and withdrawal evidence did not commit atomically"

echo "checkout concurrency QA passed: atomic checkout converged to one order and one withdrawal evidence"
