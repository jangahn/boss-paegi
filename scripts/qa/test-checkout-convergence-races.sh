#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
db_container="supabase_db_${project_id}"
if [[ -z "$project_id" ]] \
  || [[ "$db_container" != supabase_db_* ]] \
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
    echo "checkout convergence QA failed to restore growth_levers" >&2
    if (( original_status == 0 )); then exit 1; fi
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "checkout convergence race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      tail -n 30 "$output" >&2
    fi
  done
  exit 1
}

wait_for_activity() {
  app_name="$1"
  predicate="$2"
  description="$3"
  for _ in $(seq 1 200); do
    count="$(
      db_value "
        select count(*)
          from pg_catalog.pg_stat_activity
         where application_name = '$app_name'
           and backend_type = 'client backend'
           and ($predicate);
      "
    )"
    if [[ "$count" == "1" ]]; then return 0; fi
    sleep 0.05
  done
  fail "timed out waiting for $description"
}

catalog_ok="$(
  db_value "
    select (
      pg_catalog.to_regprocedure(
        'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.bp_rollout_compatibility_enabled(text)'
      ) is not null
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "atomic checkout migrations are not applied"

# B/C and D deliberately exercise the old-server compatibility window. The
# contract phase closes that window and makes the same-price/different-credit
# config publish in D safe, so running this harness after contract would report
# a false invariant failure. Prove the exact catalog stage before fixtures.
rollout_stage="$(
  db_value "
    select case
      when public.bp_rollout_compatibility_enabled(
             'legacy_checkout_reuse'
           )
       and pg_catalog.has_function_privilege(
             'service_role',
             'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
             'EXECUTE'
           )
       and pg_catalog.has_function_privilege(
             'service_role',
             'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)',
             'EXECUTE'
           )
       and pg_catalog.has_function_privilege(
             'service_role',
             'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
             'EXECUTE'
           )
       and pg_catalog.to_regprocedure(
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text)'
           ) is null
       and pg_catalog.to_regprocedure(
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'
           ) is not null
       and not exists (
             select 1
               from pg_catalog.pg_constraint c
              where c.conrelid = 'public.orders'::regclass
                and c.conname =
                      'orders_portone_payment_evidence_required_check'
           )
        then 'expand'
      when not public.bp_rollout_compatibility_enabled(
                 'legacy_checkout_reuse'
               )
       and not pg_catalog.has_function_privilege(
                 'service_role',
                 'public.create_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean)',
                 'EXECUTE'
               )
       and pg_catalog.to_regprocedure(
             'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
           ) is null
       and pg_catalog.has_function_privilege(
             'service_role',
             'public.create_or_reuse_pending_order(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean)',
             'EXECUTE'
           )
       and pg_catalog.to_regprocedure(
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text)'
           ) is null
       and pg_catalog.to_regprocedure(
             'public.backfill_portone_order_payment_evidence(uuid,text,integer,boolean,text,text,text,text)'
           ) is null
       and exists (
             select 1
               from pg_catalog.pg_constraint c
              where c.conrelid = 'public.orders'::regclass
                and c.conname =
                      'orders_portone_payment_evidence_required_check'
                and c.contype = 'c'
                and c.convalidated
           )
        then 'contract'
      else 'unknown'
    end;
  "
)"
if [[ "$rollout_stage" == "contract" ]]; then
  echo \
    "checkout convergence race QA is expand-only; detected contract stage" \
    >&2
  echo \
    "run it after qa:db:apply:expand and before qa:db:apply:contract" \
    >&2
  exit 2
fi
[[ "$rollout_stage" == "expand" ]] \
  || fail "checkout rollout catalog is neither a valid expand nor contract stage"

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
        ),
        pg_catalog.jsonb_build_object(
          'productId', 'qa_config_checkout',
          'goodname', 'QA config checkout',
          'price', 2300,
          'credits', 3,
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
new_new_user="$(db_value "select pg_catalog.gen_random_uuid();")"
old_first_user="$(db_value "select pg_catalog.gen_random_uuid();")"
new_first_user="$(db_value "select pg_catalog.gen_random_uuid();")"
checkout_config_user="$(db_value "select pg_catalog.gen_random_uuid();")"
config_first_user="$(db_value "select pg_catalog.gen_random_uuid();")"
withdrawal_user="$(db_value "select pg_catalog.gen_random_uuid();")"
qa_users=(
  "$new_new_user"
  "$old_first_user"
  "$new_first_user"
  "$checkout_config_user"
  "$config_first_user"
  "$withdrawal_user"
)

for user_id in "${qa_users[@]}"; do
  [[ "$user_id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid user UUID"
done
db_psql -q -c "
  insert into auth.users(id, email) values
    ('$new_new_user'::uuid, 'checkout-new-new-$new_new_user@test.local'),
    ('$old_first_user'::uuid, 'checkout-old-first-$old_first_user@test.local'),
    ('$new_first_user'::uuid, 'checkout-new-first-$new_first_user@test.local'),
    ('$checkout_config_user'::uuid, 'checkout-config-$checkout_config_user@test.local'),
    ('$config_first_user'::uuid, 'config-first-$config_first_user@test.local'),
    ('$withdrawal_user'::uuid, 'checkout-withdrawal-$withdrawal_user@test.local');
" >/dev/null

uuid_one="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_two="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_old_first="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_new_after_old="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_new_first="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_old_after_new="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_checkout_config="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_stale_config="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_fresh_config="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_withdrawal_owner="$(db_value "select pg_catalog.gen_random_uuid();")"
uuid_withdrawal_waiter="$(db_value "select pg_catalog.gen_random_uuid();")"
withdrawal_request_id="$(db_value "select pg_catalog.gen_random_uuid();")"
withdrawal_offer_id="$(db_value "select pg_catalog.gen_random_uuid();")"
for order_id in \
  "$uuid_one" "$uuid_two" "$uuid_old_first" \
  "$uuid_new_after_old" "$uuid_new_first" "$uuid_old_after_new" \
  "$uuid_checkout_config" "$uuid_stale_config" "$uuid_fresh_config" \
  "$uuid_withdrawal_owner" "$uuid_withdrawal_waiter" \
  "$withdrawal_request_id" "$withdrawal_offer_id"; do
  [[ "$order_id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid order UUID"
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
      'copyVersion', 'credits-offer-2026-07-30-v1',
      'surface', 'credits_offer',
      'payMode', 'live',
      'products', pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'productId', 'qa_atomic_checkout',
          'goodname', 'QA atomic checkout',
          'priceKrwVatIncluded', 1700,
          'credits', 7
        ),
        pg_catalog.jsonb_build_object(
          'productId', 'qa_config_checkout',
          'goodname', 'QA config checkout',
          'priceKrwVatIncluded', 2300,
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

# A) New↔new: the first transaction holds the member lock after insert. The
# second distinct candidate must actually block, then return the first receipt.
owner_app="bp_qa_checkout_new_owner_$$"
waiter_app="bp_qa_checkout_new_waiter_$$"
mkfifo "$qa_tmp_dir/new-new.fifo"
db_psql -qAt <"$qa_tmp_dir/new-new.fifo" \
  >"$qa_tmp_dir/new-new-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/new-new.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.create_or_reuse_pending_order(
    '$new_new_user'::uuid,
    '$uuid_one'::uuid,
    '$product_id',
    $amount,
    $credits,
    '${uuid_one//-/}',
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live'
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "first atomic checkout to hold its transaction"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select concat_ws(
    '|',
    ack->>'outcome',
    ack->>'order_uuid',
    ack->>'expected_store_id',
    ack->>'expected_channel_key'
  )
    from (
      select public.create_or_reuse_pending_order(
        '$new_new_user'::uuid,
        '$uuid_two'::uuid,
        '$product_id',
        $amount,
        $credits,
        '${uuid_two//-/}',
        'portone',
        'card',
        false,
        'store-rotated',
        'KRW',
        'channel-card-rotated'
      ) as ack
    ) reused;
" >"$qa_tmp_dir/new-new-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "second atomic checkout to wait on the member lock"
printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "new-new owner failed"
owner_pid=""
wait "$waiter_pid" || fail "new-new waiter failed"
waiter_pid=""

new_new_state="$(
  db_value "
    select count(*)::text || '|' || min(order_uuid::text)
      from public.orders
     where user_id = '$new_new_user'::uuid;
  "
)"
[[ "$new_new_state" == "1|$uuid_one" ]] \
  || fail "new-new requests did not converge to the first durable order"
waiter_receipt="$(tail -n 1 "$qa_tmp_dir/new-new-waiter.out")"
[[ "$waiter_receipt" == \
     "reused|$uuid_one|store-qa|channel-card-live" ]] \
  || fail "different-candidate reuse did not preserve the first namespace tuple"
retry_receipt="$(
  db_value "
    select concat_ws(
      '|',
      ack->>'outcome',
      ack->>'order_uuid',
      ack->>'expected_store_id',
      ack->>'expected_channel_key'
    )
      from (
        select public.create_or_reuse_pending_order(
          '$new_new_user'::uuid,
          '$uuid_one'::uuid,
          '$product_id',
          $amount,
          $credits,
          '${uuid_one//-/}',
          'portone',
          'card',
          false,
          'store-retry-rotated',
          'KRW',
          'channel-retry-rotated'
        ) as ack
      ) replayed;
  "
)"
[[ "$retry_receipt" == \
     "replayed|$uuid_one|store-qa|channel-card-live" ]] \
  || fail "same-candidate response-loss replay did not recover the first tuple"

# A2) The permanent 19-argument checkout boundary must converge both the
# charge-capable order and its affirmative withdrawal evidence. The waiter
# deliberately supplies a different candidate after the owner has inserted,
# but reuses the same request id as a response-loss retry.
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
        'checkout-withdrawal-limit-2026-07-30-v1',
        '구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.',
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
        'checkout-withdrawal-limit-2026-07-30-v1',
        '구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.',
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

# B0) Once expand is installed, the nine-argument RPC must never mint a new
# evidence-less order. A zero-inventory caller gets the explicit upgrade signal
# and leaves no durable row.
if db_psql -qAt -c "
  set statement_timeout = '15s';
  select public.create_pending_order(
    '$old_first_user'::uuid,
    '$uuid_old_first'::uuid,
    '$product_id',
    $amount,
    $credits,
    '${uuid_old_first//-/}',
    'portone',
    'card',
    false
  );
" >"$qa_tmp_dir/old-zero-candidate.out" 2>&1; then
  fail "zero-candidate legacy checkout minted a new order"
fi
grep -F "checkout_upgrade_required" \
  "$qa_tmp_dir/old-zero-candidate.out" >/dev/null \
  || fail "zero-candidate legacy checkout did not require an upgrade"
old_zero_count="$(
  db_value "
    select count(*)
      from public.orders
     where user_id = '$old_first_user'::uuid;
  "
)"
[[ "$old_zero_count" == "0" ]] \
  || fail "zero-candidate legacy checkout persisted an order"

# Recreate the sole kind of row an old server is allowed to replay during
# expand: one pre-expand, all-NULL evidence snapshot. This is a controlled
# fixture, not a post-expand minting path.
db_psql -q -c "
  insert into public.orders (
    order_uuid,
    user_id,
    product_id,
    amount,
    credits,
    status,
    provider,
    payment_id,
    is_test,
    pay_channel,
    expected_store_id,
    expected_currency,
    expected_channel_key
  )
  values (
    '$uuid_old_first'::uuid,
    '$old_first_user'::uuid,
    '$product_id',
    $amount,
    $credits,
    'pending',
    'portone',
    '${uuid_old_first//-/}',
    false,
    'card',
    null,
    null,
    null
  );
" >/dev/null

# B) Old↔new, old first: the old request may replay exactly that same payment
# ID and holds the member lock after doing so. The new RPC must wait, then
# refuse to guess historical store/channel evidence from current deployment
# configuration.
owner_app="bp_qa_checkout_old_owner_$$"
waiter_app="bp_qa_checkout_new_after_old_$$"
mkfifo "$qa_tmp_dir/old-first.fifo"
db_psql -qAt <"$qa_tmp_dir/old-first.fifo" \
  >"$qa_tmp_dir/old-first-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/old-first.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.create_pending_order(
    '$old_first_user'::uuid,
    '$uuid_old_first'::uuid,
    '$product_id',
    $amount,
    $credits,
    '${uuid_old_first//-/}',
    'portone',
    'card',
    false
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "legacy checkout to hold its transaction"
db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.create_or_reuse_pending_order(
    '$old_first_user'::uuid,
    '$uuid_new_after_old'::uuid,
    '$product_id',
    $amount,
    $credits,
    '${uuid_new_after_old//-/}',
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live'
  );
" >"$qa_tmp_dir/old-first-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "new checkout to wait behind legacy checkout"
printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "old-first owner failed"
owner_pid=""
grep -Fx "$uuid_old_first" "$qa_tmp_dir/old-first-owner.out" >/dev/null \
  || fail "legacy checkout did not replay its exact preexisting order"
if wait "$waiter_pid"; then
  fail "new-after-old waiter guessed evidence for a legacy order"
fi
waiter_pid=""
grep -F "legacy_checkout_refresh_required" \
  "$qa_tmp_dir/old-first-waiter.out" >/dev/null \
  || fail "new waiter did not fail with legacy_checkout_refresh_required"
old_first_state="$(
  db_value "
    select count(*)::text || '|' || min(order_uuid::text) || '|' ||
           pg_catalog.bool_and(
             expected_store_id is null
             and expected_currency is null
             and expected_channel_key is null
           )::text
      from public.orders
     where user_id = '$old_first_user'::uuid;
  "
)"
[[ "$old_first_state" == "1|$uuid_old_first|true" ]] \
  || fail "old-first requests did not preserve one all-NULL legacy order"
if db_psql -qAt -c "
  set statement_timeout = '15s';
  select public.create_or_reuse_pending_order(
    '$old_first_user'::uuid,
    '$uuid_old_first'::uuid,
    '$product_id',
    $amount,
    $credits,
    '${uuid_old_first//-/}',
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live'
  );
" >"$qa_tmp_dir/old-first-same-candidate.out" 2>&1; then
  fail "same-candidate new retry guessed evidence for a legacy order"
fi
grep -F "legacy_checkout_refresh_required" \
  "$qa_tmp_dir/old-first-same-candidate.out" >/dev/null \
  || fail "same-candidate legacy retry did not require checkout refresh"

# C) New↔old, new first: the old server cannot safely return another UUID, so
# after waiting it must fail with the exact reuse signal and expose no second
# payment parameters.
owner_app="bp_qa_checkout_new_first_$$"
waiter_app="bp_qa_checkout_old_after_new_$$"
mkfifo "$qa_tmp_dir/new-first.fifo"
db_psql -qAt <"$qa_tmp_dir/new-first.fifo" \
  >"$qa_tmp_dir/new-first-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/new-first.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.create_or_reuse_pending_order(
    '$new_first_user'::uuid,
    '$uuid_new_first'::uuid,
    '$product_id',
    $amount,
    $credits,
    '${uuid_new_first//-/}',
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live'
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "new checkout to hold its transaction"
db_psql -q -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.create_pending_order(
    '$new_first_user'::uuid,
    '$uuid_old_after_new'::uuid,
    '$product_id',
    $amount,
    $credits,
    '${uuid_old_after_new//-/}',
    'portone',
    'card',
    false
  );
" >"$qa_tmp_dir/new-first-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "legacy checkout to wait behind new checkout"
printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "new-first owner failed"
owner_pid=""
if wait "$waiter_pid"; then
  fail "legacy waiter unexpectedly exposed a second checkout"
fi
waiter_pid=""
grep -F "checkout_reuse_required" \
  "$qa_tmp_dir/new-first-waiter.out" >/dev/null \
  || fail "legacy waiter did not fail with checkout_reuse_required"
new_first_state="$(
  db_value "
    select count(*)::text || '|' || min(order_uuid::text)
      from public.orders
     where user_id = '$new_first_user'::uuid;
  "
)"
[[ "$new_first_state" == "1|$uuid_new_first" ]] \
  || fail "new-first mixed-version requests did not preserve one order"

# D) Checkout→config: checkout holds the statement-level config advisory
# boundary. A same-price/different-credit publish really waits, then the
# legacy-window guard rejects it after seeing the committed pending snapshot.
owner_app="bp_qa_checkout_before_config_$$"
waiter_app="bp_qa_config_after_checkout_$$"
mkfifo "$qa_tmp_dir/checkout-config.fifo"
db_psql -qAt <"$qa_tmp_dir/checkout-config.fifo" \
  >"$qa_tmp_dir/checkout-config-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/checkout-config.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.create_or_reuse_pending_order(
    '$checkout_config_user'::uuid,
    '$uuid_checkout_config'::uuid,
    '$product_id',
    $amount,
    $credits,
    '${uuid_checkout_config//-/}',
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live'
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "checkout to hold the growth config boundary"
db_psql -q -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  update public.app_settings
     set value = pg_catalog.jsonb_set(
       value,
       '{products,0,credits}',
       '8'::jsonb
     )
   where key = 'growth_levers';
" >"$qa_tmp_dir/checkout-config-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "config publish to wait behind checkout"
printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "checkout-before-config owner failed"
owner_pid=""
if wait "$waiter_pid"; then
  fail "unsafe same-price/different-credit config publish succeeded"
fi
waiter_pid=""
grep -F "checkout_config_change_pending" \
  "$qa_tmp_dir/checkout-config-waiter.out" >/dev/null \
  || fail "config publish did not fail with checkout_config_change_pending"
current_credits="$(
  db_value "
    select elem->>'credits'
      from public.app_settings s
      cross join lateral pg_catalog.jsonb_array_elements(
        s.value->'products'
      ) elem
     where s.key = 'growth_levers'
       and elem->>'productId' = '$product_id';
  "
)"
[[ "$current_credits" == "$credits" ]] \
  || fail "rejected config publish changed the canonical credits"

# E) Config→checkout: a safe update of a different product holds the same
# config boundary. A request carrying the stale snapshot waits, then must reject
# after the commit; a fresh request using the new snapshot succeeds.
owner_app="bp_qa_config_first_$$"
waiter_app="bp_qa_checkout_after_config_$$"
mkfifo "$qa_tmp_dir/config-first.fifo"
db_psql -qAt <"$qa_tmp_dir/config-first.fifo" \
  >"$qa_tmp_dir/config-first-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/config-first.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  update public.app_settings
     set value = pg_catalog.jsonb_set(
       value,
       '{products,1,credits}',
       '4'::jsonb
     )
   where key = 'growth_levers';
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "config publish to hold the checkout config boundary"
db_psql -q -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.create_or_reuse_pending_order(
    '$config_first_user'::uuid,
    '$uuid_stale_config'::uuid,
    'qa_config_checkout',
    2300,
    3,
    '${uuid_stale_config//-/}',
    'portone',
    'card',
    false,
    'store-qa',
    'KRW',
    'channel-card-live'
  );
" >"$qa_tmp_dir/config-first-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "stale checkout to wait behind config publish"
printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "config-first owner failed"
owner_pid=""
if wait "$waiter_pid"; then
  fail "stale checkout unexpectedly succeeded after config commit"
fi
waiter_pid=""
grep -F "product_amount_mismatch" \
  "$qa_tmp_dir/config-first-waiter.out" >/dev/null \
  || fail "stale checkout did not reject the committed config snapshot"
stale_count="$(
  db_value "
    select count(*)
      from public.orders
     where user_id = '$config_first_user'::uuid;
  "
)"
[[ "$stale_count" == "0" ]] \
  || fail "stale config checkout persisted an order"
fresh_config_id="$(
  db_value "
    select public.create_or_reuse_pending_order(
      '$config_first_user'::uuid,
      '$uuid_fresh_config'::uuid,
      'qa_config_checkout',
      2300,
      4,
      '${uuid_fresh_config//-/}',
      'portone',
      'card',
      false,
      'store-qa',
      'KRW',
      'channel-card-live'
    )->>'order_uuid';
  "
)"
[[ "$fresh_config_id" == "$uuid_fresh_config" ]] \
  || fail "fresh checkout did not use the committed config snapshot"

echo "checkout convergence race QA passed:"
echo "  new↔new: actual lock wait, config-rotated reuse preserved one tuple"
echo "  response loss: same candidate replayed its original immutable receipt"
echo "  affirmative retry: distinct candidates converged on one order + evidence"
echo "  old zero-candidate: upgrade required and no order minted"
echo "  old→new: exact old replay held; new request rejected all-NULL evidence"
echo "  new→old: old request failed closed with no second order"
echo "  checkout→config: publish waited and unsafe credit drift was rejected"
echo "  config→checkout: stale snapshot waited and failed; fresh snapshot succeeded"
