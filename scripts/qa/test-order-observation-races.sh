#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ -z "$project_id" ]] \
  || [[ ! "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "order observation race QA requires disposable local Supabase" >&2
  exit 1
fi
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 1
fi

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-order-observation-race.XXXXXX"
)"
observer_pid=""
finalizer_pid=""
growth_backup_hex=""
growth_fixture_installed="false"
admin_id=""
stale_user=""
stale_order=""
record_user=""
record_order=""

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" "$@"
}

db_value() {
  db_psql -Atq -c "$1"
}

cleanup() {
  original_status=$?
  set +e
  exec 3>&-
  restore_failed=0
  cleanup_failed=0
  cleanup_remaining=""
  for pid in "$observer_pid" "$finalizer_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$admin_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$stale_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$stale_order" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$record_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$record_order" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      delete from public.credit_ledger
       where ref_order_uuid in (
         '$stale_order'::uuid,
         '$record_order'::uuid
       );
      delete from public.credit_lots
       where order_uuid in (
         '$stale_order'::uuid,
         '$record_order'::uuid
       )
          or user_id in ('$stale_user'::uuid, '$record_user'::uuid);
      delete from public.orders
       where order_uuid in (
         '$stale_order'::uuid,
         '$record_order'::uuid
       );
      delete from public.member_accounts
       where user_id in (
         '$admin_id'::uuid,
         '$stale_user'::uuid,
         '$record_user'::uuid
       );
      delete from auth.users
       where id in (
         '$admin_id'::uuid,
         '$stale_user'::uuid,
         '$record_user'::uuid
       );
      commit;
    " >"$qa_tmp_dir/cleanup.out" 2>&1; then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        select
          (
            select pg_catalog.count(*)
              from public.credit_ledger
             where ref_order_uuid in (
               '$stale_order'::uuid,
               '$record_order'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.credit_lots
             where order_uuid in (
               '$stale_order'::uuid,
               '$record_order'::uuid
             )
                or user_id in (
                  '$stale_user'::uuid,
                  '$record_user'::uuid
                )
          )
          + (
            select pg_catalog.count(*)
              from public.checkout_withdrawal_acceptance_evidence
             where order_uuid in (
               '$stale_order'::uuid,
               '$record_order'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.orders
             where order_uuid in (
               '$stale_order'::uuid,
               '$record_order'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in (
               '$admin_id'::uuid,
               '$stale_user'::uuid,
               '$record_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in (
               '$admin_id'::uuid,
               '$stale_user'::uuid,
               '$record_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in (
               '$admin_id'::uuid,
               '$stale_user'::uuid,
               '$record_user'::uuid
             )
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
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
      " >>"$qa_tmp_dir/cleanup.out" 2>&1 || restore_failed=1
    elif [[ -z "$growth_backup_hex" ]]; then
      db_psql -q -c "
        delete from public.app_settings where key = 'growth_levers';
      " >>"$qa_tmp_dir/cleanup.out" 2>&1 || restore_failed=1
    else
      restore_failed=1
    fi
    restored_growth_hex="$(
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
      " 2>>"$qa_tmp_dir/cleanup.out"
    )" || restore_failed=1
    if [[ "$restored_growth_hex" != "$growth_backup_hex" ]]; then
      restore_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "order observation race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
  fi
  if (( cleanup_failed != 0 || restore_failed != 0 )) \
    && [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
    tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
  fi
  rm -f "$qa_tmp_dir"/*
  rmdir "$qa_tmp_dir" >/dev/null 2>&1
  if (( restore_failed != 0 )); then
    echo "order observation race QA failed to restore growth_levers" >&2
    if (( original_status == 0 )); then
      exit 1
    fi
  fi
  if (( cleanup_failed != 0 && original_status == 0 )); then
    exit 1
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "order observation race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "output: $(basename "$output")" >&2
      tail -n 40 "$output" >&2
    fi
  done
  exit 1
}

# 세션 동기화는 공용 lib — 상한 120s(러너 속도 무관)·타임아웃 시 세션 스냅샷 덤프.
source scripts/qa/lib/wait-sync.sh

function_ready="$(
  db_value "
    select (
      pg_catalog.to_regprocedure(
        'public.record_unsettled_order_observation(uuid,text,text,text,text,text,jsonb)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.mark_paid_and_grant(uuid,text,integer,jsonb,timestamptz,text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.bp_008905_create_or_reuse_pending_order_impl(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text)'
      ) is not null
    )::text;
  "
)"
[[ "$function_ready" == "true" ]] \
  || fail "008899 observation CAS is not applied; run npm run qa:db:apply first"

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
db_psql -q >/dev/null <<'SQL'
insert into public.app_settings(key, value, version, updated_by, updated_at)
values (
  'growth_levers',
  pg_catalog.jsonb_build_object(
    'signupBonusCredits', 0,
    'creditsEnabled', true,
    'products', pg_catalog.jsonb_build_array(
      pg_catalog.jsonb_build_object(
        'productId', 'qa_observation_3',
        'goodname', 'QA observation race product',
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
SQL
growth_fixture_installed="true"

deadlocks_before="$(
  db_value "
    select deadlocks
      from pg_catalog.pg_stat_database
     where datname = '$db_name';
  "
)"

admin_id="$(db_value "select pg_catalog.gen_random_uuid();")"
stale_user="$(db_value "select pg_catalog.gen_random_uuid();")"
stale_order="$(db_value "select pg_catalog.gen_random_uuid();")"
stale_payment="${stale_order//-/}"
stale_tx="tx-$stale_payment"
stale_paid_at="$(db_value "select pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())::text;")"

db_psql -q >/dev/null <<SQL
insert into auth.users (id, email)
values ('$admin_id'::uuid, 'observation-race-admin-$admin_id@test.local');
insert into public.member_accounts (user_id, gen_credits, email)
values (
  '$admin_id'::uuid,
  0,
  'observation-race-admin-$admin_id@test.local'
);
insert into auth.users (id, email)
values ('$stale_user'::uuid, 'observation-race-stale-$stale_user@test.local');
insert into public.member_accounts (user_id, gen_credits, email)
values (
  '$stale_user'::uuid,
  0,
  'observation-race-stale-$stale_user@test.local'
);
select public.bp_008905_create_or_reuse_pending_order_impl(
  '$stale_user'::uuid,
  '$stale_order'::uuid,
  'qa_observation_3',
  1000,
  3,
  '$stale_payment',
  'portone',
  'card',
  false,
  'store-qa',
  'KRW',
  'channel-card-live'
);
select public.record_unsettled_order_observation(
  '$stale_order'::uuid,
  'pending',
  null,
  'provider_state',
  null,
  'READY',
  '{"verified_status":"READY","origin":"stale-initial"}'::jsonb
);
SQL

# Session A reads the nonterminal provider state and pauses outside a DB
# transaction, exactly like an HTTP handler paused on its provider response.
# Session B commits PAID first. A's stale CAS must then return terminal.
stale_app="bp_qa_observation_stale_$$"
stale_fifo="$qa_tmp_dir/stale-observer.fifo"
stale_out="$qa_tmp_dir/stale-observer.out"
mkfifo "$stale_fifo"
db_psql -qAt <"$stale_fifo" >"$stale_out" 2>&1 &
observer_pid="$!"
exec 3>"$stale_fifo"
printf "%s\n" "
  set application_name = '$stale_app';
  set statement_timeout = '20s';
  set lock_timeout = '15s';
  select status || '|' || pg_status || '|' || coalesce(error_message, 'NULL')
    from public.orders
   where order_uuid = '$stale_order'::uuid;
" >&3
wait_for_activity "$stale_app" "state = 'idle' and xact_start is null" \
  "stale observer after READY read"

stale_finalize_out="$qa_tmp_dir/stale-finalizer.out"
db_psql -qAt -c "
  select public.mark_paid_and_grant(
    '$stale_order'::uuid,
    '$stale_tx',
    1000,
    pg_catalog.jsonb_build_object(
      'id', '$stale_payment',
      'status', 'PAID',
      'transactionId', '$stale_tx',
      'paidAt', '$stale_paid_at'::timestamptz,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'LIVE',
        'key', 'channel-card-live'
      )
    ),
    '$stale_paid_at'::timestamptz,
    null
  );
" >"$stale_finalize_out" 2>&1 \
  || fail "stale-first paid finalizer failed"

stale_before="$(
  db_value "
    select status || '|' || pg_status || '|' ||
           coalesce(error_message, 'NULL') || '|' ||
           pg_catalog.md5(raw::text) || '|' ||
           (select gen_credits::text
              from public.member_accounts
             where user_id = '$stale_user'::uuid) || '|' ||
           (select pg_catalog.count(*)::text
              from public.credit_lots
             where order_uuid = '$stale_order'::uuid
               and source = 'purchase'
               and expired_at is null) || '|' ||
           (select pg_catalog.count(*)::text
              from public.credit_ledger
             where ref_order_uuid = '$stale_order'::uuid
               and event_type = 'purchase')
      from public.orders
     where order_uuid = '$stale_order'::uuid;
  "
)"

printf "%s\n" "
  select public.record_unsettled_order_observation(
    '$stale_order'::uuid,
    'pending',
    null,
    'provider_state',
    null,
    'READY',
    '{\"verified_status\":\"READY\",\"origin\":\"stale-resume\"}'::jsonb
  )->>'outcome';
  \\q
" >&3
exec 3>&-
wait "$observer_pid" || fail "stale observer failed"
observer_pid=""

stale_after="$(
  db_value "
    select status || '|' || pg_status || '|' ||
           coalesce(error_message, 'NULL') || '|' ||
           pg_catalog.md5(raw::text) || '|' ||
           (select gen_credits::text
              from public.member_accounts
             where user_id = '$stale_user'::uuid) || '|' ||
           (select pg_catalog.count(*)::text
              from public.credit_lots
             where order_uuid = '$stale_order'::uuid
               and source = 'purchase'
               and expired_at is null) || '|' ||
           (select pg_catalog.count(*)::text
              from public.credit_ledger
             where ref_order_uuid = '$stale_order'::uuid
               and event_type = 'purchase')
      from public.orders
     where order_uuid = '$stale_order'::uuid;
  "
)"
grep -Fqx "pending|READY|NULL" "$stale_out" \
  || fail "stale observer did not read the READY origin"
grep -Fqx "terminal" "$stale_out" \
  || fail "stale observer did not return terminal after PAID won"
[[ "$stale_before" == "$stale_after" ]] \
  || fail "stale observer changed the completed PAID row"
[[ "$stale_after" == paid\|PAID\|NULL\|*\|3\|1\|1 ]] \
  || fail "stale-first invariant mismatch ($stale_after)"

# Reverse order: the observation CAS records READY and holds the row lock.
# The paid finalizer must wait, then overwrite the operational evidence with
# its canonical PAID evidence while granting exactly once.
record_user="$(db_value "select pg_catalog.gen_random_uuid();")"
record_order="$(db_value "select pg_catalog.gen_random_uuid();")"
record_payment="${record_order//-/}"
record_tx="tx-$record_payment"
record_paid_at="$(db_value "select pg_catalog.date_trunc('milliseconds', pg_catalog.clock_timestamp())::text;")"
db_psql -q >/dev/null <<SQL
insert into auth.users (id, email)
values ('$record_user'::uuid, 'observation-race-record-$record_user@test.local');
insert into public.member_accounts (user_id, gen_credits, email)
values (
  '$record_user'::uuid,
  0,
  'observation-race-record-$record_user@test.local'
);
select public.bp_008905_create_or_reuse_pending_order_impl(
  '$record_user'::uuid,
  '$record_order'::uuid,
  'qa_observation_3',
  1000,
  3,
  '$record_payment',
  'portone',
  'card',
  false,
  'store-qa',
  'KRW',
  'channel-card-live'
);
SQL

record_owner_app="bp_qa_observation_owner_$$"
record_waiter_app="bp_qa_observation_finalizer_$$"
record_fifo="$qa_tmp_dir/record-observer.fifo"
record_out="$qa_tmp_dir/record-observer.out"
record_finalizer_out="$qa_tmp_dir/record-finalizer.out"
mkfifo "$record_fifo"
db_psql -qAt <"$record_fifo" >"$record_out" 2>&1 &
observer_pid="$!"
exec 3>"$record_fifo"
printf "%s\n" "
  set application_name = '$record_owner_app';
  set statement_timeout = '20s';
  set lock_timeout = '15s';
  begin;
  select public.record_unsettled_order_observation(
    '$record_order'::uuid,
    'pending',
    null,
    'provider_state',
    null,
    'READY',
    '{\"verified_status\":\"READY\",\"origin\":\"record-first\"}'::jsonb
  )->>'outcome';
" >&3
wait_for_activity \
  "$record_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "record-first observer transaction"

db_psql -qAt -c "
  set application_name = '$record_waiter_app';
  set statement_timeout = '20s';
  set lock_timeout = '15s';
  select public.mark_paid_and_grant(
    '$record_order'::uuid,
    '$record_tx',
    1000,
    pg_catalog.jsonb_build_object(
      'id', '$record_payment',
      'status', 'PAID',
      'transactionId', '$record_tx',
      'paidAt', '$record_paid_at'::timestamptz,
      'amount', pg_catalog.jsonb_build_object('total', 1000),
      'storeId', 'store-qa',
      'currency', 'KRW',
      'channel', pg_catalog.jsonb_build_object(
        'type', 'LIVE',
        'key', 'channel-card-live'
      )
    ),
    '$record_paid_at'::timestamptz,
    null
  );
" >"$record_finalizer_out" 2>&1 &
finalizer_pid="$!"
wait_for_activity \
  "$record_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "paid finalizer waiting on observation row lock"

blocker_count="$(
  db_value "
    select pg_catalog.cardinality(pg_catalog.pg_blocking_pids(pid))
      from pg_catalog.pg_stat_activity
     where datname = '$db_name'
       and application_name = '$record_waiter_app';
  "
)"
[[ "$blocker_count" == "1" ]] \
  || fail "record-first finalizer did not have exactly one blocker"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$observer_pid" || fail "record-first observer failed"
observer_pid=""
wait "$finalizer_pid" || fail "record-first finalizer failed"
finalizer_pid=""

grep -Fqx "recorded" "$record_out" \
  || fail "record-first observation was not recorded"
grep -Fqx "t" "$record_finalizer_out" \
  || fail "record-first paid finalizer did not grant"

record_state="$(
  db_value "
    select o.status || '|' || o.pg_status || '|' ||
           coalesce(o.error_message, 'NULL') || '|' ||
           coalesce(o.raw->>'transactionId', 'NULL') || '|' ||
           m.gen_credits::text || '|' ||
           (select pg_catalog.count(*)::text
              from public.credit_lots
             where order_uuid = o.order_uuid
               and source = 'purchase'
               and expired_at is null) || '|' ||
           (select pg_catalog.count(*)::text
              from public.credit_ledger
             where ref_order_uuid = o.order_uuid
               and event_type = 'purchase')
      from public.orders o
      join public.member_accounts m on m.user_id = o.user_id
     where o.order_uuid = '$record_order'::uuid;
  "
)"
[[ "$record_state" == "paid|PAID|NULL|$record_tx|3|1|1" ]] \
  || fail "record-first invariant mismatch ($record_state)"

deadlocks_after="$(
  db_value "
    select deadlocks
      from pg_catalog.pg_stat_database
     where datname = '$db_name';
  "
)"
[[ "$deadlocks_after" == "$deadlocks_before" ]] \
  || fail "deadlock counter changed ($deadlocks_before -> $deadlocks_after)"

echo "order observation race QA passed: both commit orders, exact PAID grant, deadlocks=0"
