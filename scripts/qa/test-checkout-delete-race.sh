#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
if [[ -z "$project_id" ]]; then
  echo "supabase project_id is missing" >&2
  exit 1
fi

db_container="supabase_db_${project_id}"
if [[ "$db_container" != supabase_db_* ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-checkout-delete-race.XXXXXX")"
checkout_pid=""
delete_pid=""
checkout_waiter_pid=""
delete_owner_pid=""
active_user=""
deleted_user=""
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

cleanup() {
  original_status=$?
  set +e
  exec 3>&-
  restore_failed=0
  for pid in "$checkout_pid" "$delete_pid" "$checkout_waiter_pid" "$delete_owner_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$active_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$deleted_user" =~ ^[0-9a-f-]{36}$ ]]; then
    db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      delete from public.orders
       where user_id in ('$active_user'::uuid, '$deleted_user'::uuid);
      delete from public.account_deletion_cleanup_jobs
       where user_id in ('$active_user'::uuid, '$deleted_user'::uuid);
      delete from auth.users
       where id in ('$active_user'::uuid, '$deleted_user'::uuid);
      commit;
    " >/dev/null 2>&1
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
  if [[ "$growth_fixture_installed" == "true" ]]; then
    if [[ -n "$growth_backup_hex" ]]; then
      if [[ "$growth_backup_hex" =~ ^[0-9a-f]+$ ]]; then
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
      else
        restore_failed=1
      fi
    else
      db_psql -q -c "
        delete from public.app_settings where key = 'growth_levers';
      " >/dev/null 2>&1 || restore_failed=1
    fi
  fi
  rm -f \
    "$qa_tmp_dir/checkout-first.fifo" \
    "$qa_tmp_dir/delete-first.fifo" \
    "$qa_tmp_dir/checkout-first.out" \
    "$qa_tmp_dir/delete-waiter.out" \
    "$qa_tmp_dir/delete-first.out" \
    "$qa_tmp_dir/checkout-waiter.out" \
    "$qa_tmp_dir/direct-insert.out"
  rmdir "$qa_tmp_dir" >/dev/null 2>&1
  if (( restore_failed != 0 )); then
    echo "checkout/delete race QA failed to restore growth_levers" >&2
    if (( original_status == 0 )); then
      exit 1
    fi
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "checkout/delete race QA failed: $*" >&2
  for output in \
    "$qa_tmp_dir/checkout-first.out" \
    "$qa_tmp_dir/delete-waiter.out" \
    "$qa_tmp_dir/delete-first.out" \
    "$qa_tmp_dir/checkout-waiter.out" \
    "$qa_tmp_dir/direct-insert.out"; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
      tail -n 20 "$output" >&2
    fi
  done
  exit 1
}

wait_for_activity() {
  app_name="$1"
  predicate="$2"
  description="$3"
  for _ in $(seq 1 160); do
    count="$(
      db_value "
        select count(*)
          from pg_catalog.pg_stat_activity
         where application_name = '$app_name'
           and backend_type = 'client backend'
           and ($predicate);
      "
    )"
    if [[ "$count" == "1" ]]; then
      return 0
    fi
    sleep 0.05
  done
  fail "timed out waiting for $description"
}

catalog_ok="$(
  db_value "
    select (
      to_regprocedure(
        'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)'
      ) is not null
      and exists (
        select 1
          from pg_catalog.pg_trigger
         where tgrelid = 'public.orders'::regclass
           and tgname = 'trg_orders_account_lifecycle_guard'
           and tgenabled = 'O'
           and not tgisinternal
      )
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "0087 atomic checkout is not applied; run npm run qa:db:apply first"

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
      'signupBonusCredits', 1,
      'creditsEnabled', false,
      'products', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'qa_checkout_race',
          'goodname', 'QA checkout race product',
          'price', 1000,
          'credits', 3,
          'active', true
        )
      )
    ),
    1,
    null,
    pg_catalog.now()
  )
  on conflict (key) do update
    set value = excluded.value;
" >/dev/null
growth_fixture_installed="true"

product="$(
  db_value "
    select elem->>'productId'
           || '|' || (elem->>'price')
           || '|' || (elem->>'credits')
      from public.app_settings s
           cross join lateral pg_catalog.jsonb_array_elements(s.value->'products') elem
     where s.key = 'growth_levers'
       and coalesce((elem->>'active')::boolean, false)
     order by elem->>'productId'
     limit 1;
  "
)"
IFS='|' read -r product_id amount credits <<<"$product"
[[ "$product_id" =~ ^[A-Za-z0-9_-]+$ ]] || fail "active product id missing/invalid"
[[ "$amount" =~ ^[1-9][0-9]*$ ]] || fail "active product amount missing/invalid"
[[ "$credits" =~ ^[1-9][0-9]*$ ]] || fail "active product credits missing/invalid"

active_user="$(db_value "select gen_random_uuid();")"
deleted_user="$(db_value "select gen_random_uuid();")"
checkout_first_order="$(db_value "select gen_random_uuid();")"
delete_first_order="$(db_value "select gen_random_uuid();")"
direct_order="$(db_value "select gen_random_uuid();")"
checkout_first_request="$(db_value "select gen_random_uuid();")"
delete_first_request="$(db_value "select gen_random_uuid();")"
withdrawal_offer_id="$(db_value "select gen_random_uuid();")"
for id in \
  "$active_user" "$deleted_user" "$checkout_first_order" \
  "$delete_first_order" "$direct_order" "$checkout_first_request" \
  "$delete_first_request" "$withdrawal_offer_id"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || fail "PostgreSQL returned an invalid UUID"
done

db_psql -q -c "
  insert into auth.users(id, email) values
    ('$active_user'::uuid, 'checkout-first-$active_user@test.local'),
    ('$deleted_user'::uuid, 'delete-first-$deleted_user@test.local');
" >/dev/null

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
      'copyVersion', 'credits-offer-2026-07-30-v1',
      'surface', 'credits_offer',
      'payMode', 'live',
      'products', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'qa_checkout_race',
          'goodname', 'QA checkout race product',
          'priceKrwVatIncluded', 1000,
          'credits', 3
        )
      ),
      'channels', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'method', 'card',
          'label', '카드'
        )
      ),
      'displayCopy', pg_catalog.jsonb_build_object(
        'summary',
          '캐릭터 1명을 만들 때 생성권 1개가 쓰여요. 많이 담을수록 개당 가격이 내려가요.',
        'supply',
          '생성권은 결제 완료 즉시 지급되어 바로 사용할 수 있어요.',
        'validity',
          '구매일(지급일)로부터 1년이에요. 무료로 지급된 생성권도 동일해요.',
        'refund',
          '미사용 생성권은 환불받을 수 있어요(무료로 지급받은 생성권은 제외). 일부만 사용했더라도 남은 수량만큼 환불돼요. 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한돼요.',
        'refundReferencePrefix',
          '정확한 산정 기준·차감 순서·절차는',
        'termsLinkLabel', '이용약관 제10조',
        'refundReferenceSuffix', '를 확인해주세요.',
        'price', '표시 가격은 부가세 포함 최종 결제 금액이에요.'
      )
    ),
    pg_catalog.clock_timestamp() - interval '6 months 1 day'
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

checkout_first_payment="${checkout_first_order//-/}"
delete_first_payment="${delete_first_order//-/}"
direct_payment="${direct_order//-/}"
checkout_app="bp_qa_checkout_first_$$"
delete_waiter_app="bp_qa_delete_waiter_$$"
delete_owner_app="bp_qa_delete_first_$$"
checkout_waiter_app="bp_qa_checkout_waiter_$$"

# A) checkout-first: canonical user lock + profile KEY SHARE + complete pending
#    INSERT가 먼저 commit 대기. delete는 같은 boundary에서 실제 Lock wait 후,
#    commit된 pending을 보고 payment_pending.
mkfifo "$qa_tmp_dir/checkout-first.fifo"
db_psql -qAt <"$qa_tmp_dir/checkout-first.fifo" \
  >"$qa_tmp_dir/checkout-first.out" 2>&1 &
checkout_pid="$!"
exec 3>"$qa_tmp_dir/checkout-first.fifo"
printf "%s\n" "
  set application_name = '$checkout_app';
  set statement_timeout = '15s';
  begin;
  select public.create_or_reuse_pending_order(
    '$active_user'::uuid,
    '$checkout_first_order'::uuid,
    '$product_id',
    $amount,
    $credits,
    '$checkout_first_payment',
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live',
    '$checkout_first_request'::uuid,
    'QA checkout race product',
    '$withdrawal_offer_id'::uuid,
    '$withdrawal_offer_hash',
    'checkout-withdrawal-limit-2026-07-30-v1',
    '구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.',
    true
  );
" >&3
wait_for_activity \
  "$checkout_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "checkout-first transaction to hold profile/order locks"

db_psql -q -c "
  set application_name = '$delete_waiter_app';
  set statement_timeout = '15s';
  select public.admin_soft_delete_account('$active_user'::uuid);
" >"$qa_tmp_dir/delete-waiter.out" 2>&1 &
delete_pid="$!"
wait_for_activity \
  "$delete_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "account delete to block behind checkout profile KEY SHARE"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$checkout_pid" || fail "checkout-first owner transaction failed"
checkout_pid=""
if wait "$delete_pid"; then
  fail "checkout-first delete unexpectedly succeeded"
fi
delete_pid=""
grep -F "payment_pending" "$qa_tmp_dir/delete-waiter.out" >/dev/null \
  || fail "checkout-first delete did not fail with payment_pending"

checkout_first_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|' || count(o.*)::text
           || '|' || (
             select pg_catalog.count(*)::text
               from public.checkout_withdrawal_acceptance_evidence e
              where e.user_id = '$active_user'::uuid
           )
      from public.profiles p
      left join public.orders o
        on o.user_id = p.id
       and o.order_uuid = '$checkout_first_order'::uuid
       and o.status = 'pending'
     where p.id = '$active_user'::uuid
     group by p.deleted_at;
  "
)"
[[ "$checkout_first_state" == "false|1|1" ]] \
  || fail "checkout-first final state is not active + one order + one evidence"

# B) delete-first: admin_soft_delete_account holds the canonical user boundary
#    and profile FOR UPDATE. Checkout waits, then sees account_deleted with no
#    order after the delete commits.
mkfifo "$qa_tmp_dir/delete-first.fifo"
db_psql -qAt <"$qa_tmp_dir/delete-first.fifo" \
  >"$qa_tmp_dir/delete-first.out" 2>&1 &
delete_owner_pid="$!"
exec 3>"$qa_tmp_dir/delete-first.fifo"
printf "%s\n" "
  set application_name = '$delete_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_soft_delete_account('$deleted_user'::uuid);
" >&3
wait_for_activity \
  "$delete_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "delete-first transaction to hold profile FOR UPDATE"

db_psql -q -c "
  set application_name = '$checkout_waiter_app';
  set statement_timeout = '15s';
  select public.create_or_reuse_pending_order(
    '$deleted_user'::uuid,
    '$delete_first_order'::uuid,
    '$product_id',
    $amount,
    $credits,
    '$delete_first_payment',
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live',
    '$delete_first_request'::uuid,
    'QA checkout race product',
    '$withdrawal_offer_id'::uuid,
    '$withdrawal_offer_hash',
    'checkout-withdrawal-limit-2026-07-30-v1',
    '구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.',
    true
  );
" >"$qa_tmp_dir/checkout-waiter.out" 2>&1 &
checkout_waiter_pid="$!"
wait_for_activity \
  "$checkout_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "checkout to block behind delete profile FOR UPDATE"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$delete_owner_pid" || fail "delete-first owner transaction failed"
delete_owner_pid=""
if wait "$checkout_waiter_pid"; then
  fail "delete-first checkout unexpectedly succeeded"
fi
checkout_waiter_pid=""
grep -F "account_deleted" "$qa_tmp_dir/checkout-waiter.out" >/dev/null \
  || fail "delete-first checkout did not fail with account_deleted"

delete_first_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|' || count(o.*)::text
           || '|' || (
             select pg_catalog.count(*)::text
               from public.checkout_withdrawal_acceptance_evidence e
              where e.user_id = '$deleted_user'::uuid
           )
      from public.profiles p
      left join public.orders o
        on o.user_id = p.id
       and o.order_uuid = '$delete_first_order'::uuid
     where p.id = '$deleted_user'::uuid
     group by p.deleted_at;
  "
)"
[[ "$delete_first_state" == "true|0|0" ]] \
  || fail "delete-first final state is not deleted + zero order/evidence"

# RPC 우회 direct INSERT도 같은 DB lifecycle trigger에서 차단한다.
if db_psql -q -c "
  insert into public.orders(
    order_uuid,user_id,product_id,amount,credits,status,
    provider,payment_id,is_test,pay_channel,
    expected_store_id,expected_currency,expected_channel_key
  ) values (
    '$direct_order'::uuid,
    '$deleted_user'::uuid,
    '$product_id',
    $amount,
    $credits,
    'pending',
    'portone',
    '$direct_payment',
    false,
    'card',
    'store-qa',
    'KRW',
    'channel-card-live'
  );
" >"$qa_tmp_dir/direct-insert.out" 2>&1; then
  fail "direct INSERT for deleted account unexpectedly succeeded"
fi
grep -F "account_deleted" "$qa_tmp_dir/direct-insert.out" >/dev/null \
  || fail "direct INSERT did not fail with account_deleted"

echo "checkout/delete race QA passed:"
echo "  checkout-first: delete waited; active + one pending + one evidence"
echo "  delete-first: checkout waited; deleted + zero order/evidence"
echo "  direct INSERT: account_deleted DB backstop"
