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

# The override is useful only for a second, disposable local Supabase stack.
# A Docker container remains mandatory; this harness never accepts a network
# DSN and therefore cannot be pointed at production.
db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ ! "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase DB container is not running: $db_container" >&2
  exit 1
fi
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 1
fi

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-admin-mutation-races.XXXXXX"
)"
active_owner_pid=""
active_waiter_pid=""
last_owner_out=""
last_waiter_out=""
admin_id=""
owner_id=""
reactivate_id=""
doll_id=""
score_id=""
order_id=""
legacy_auth_first_id=""
legacy_delete_first_id=""

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
  cleanup_failed=0
  cleanup_remaining=""
  exec 3>&-
  if [[ -n "$active_owner_pid" ]] \
    && kill -0 "$active_owner_pid" >/dev/null 2>&1; then
    kill "$active_owner_pid" >/dev/null 2>&1
    wait "$active_owner_pid" >/dev/null 2>&1
  fi
  if [[ -n "$active_waiter_pid" ]] \
    && kill -0 "$active_waiter_pid" >/dev/null 2>&1; then
    kill "$active_waiter_pid" >/dev/null 2>&1
    wait "$active_waiter_pid" >/dev/null 2>&1
  fi
  if [[ "$admin_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$owner_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$reactivate_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$doll_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$score_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$order_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$legacy_auth_first_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$legacy_delete_first_id" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      alter table public.account_reactivation_jobs
        disable trigger trg_account_reactivation_jobs_guard;
      alter table public.account_reactivation_legacy_repairs
        disable trigger trg_account_reactivation_legacy_repairs_guard;
      alter table public.admin_mutation_requests
        disable trigger trg_admin_mutation_requests_guard;

      delete from public.moderation_actions_ledger
       where target_id = '$doll_id'::uuid
          or admin_user_id = '$admin_id'::uuid;
      delete from public.content_report_submission_receipts
       where target_id = '$doll_id'::uuid
          or report_id in (
            select id
              from public.content_reports
             where target_id = '$doll_id'::uuid
          );
      delete from public.content_reports
       where target_id = '$doll_id'::uuid;
      delete from public.integrity_actions_ledger
       where target_id = '$score_id'::uuid
          or admin_user_id = '$admin_id'::uuid;
      delete from public.scores
       where id = '$score_id'::uuid
          or owner_id = '$owner_id'::uuid;
      delete from public.dolls
       where id = '$doll_id'::uuid
          or owner_id = '$owner_id'::uuid;

      delete from public.events_audit
       where admin_user_id = '$admin_id'::uuid
          or event_id in (
            select id
              from public.events
             where created_by = '$admin_id'::uuid
          );
      delete from public.events
       where created_by = '$admin_id'::uuid;

      delete from public.account_admin_actions_ledger
       where admin_user_id = '$admin_id'::uuid
          or target_user_id in (
            '$reactivate_id'::uuid,
            '$legacy_auth_first_id'::uuid,
            '$legacy_delete_first_id'::uuid
          );
      delete from public.account_reactivation_jobs
       where admin_user_id = '$admin_id'::uuid
          or user_id in (
            '$reactivate_id'::uuid,
            '$legacy_auth_first_id'::uuid,
            '$legacy_delete_first_id'::uuid
          );
      delete from public.account_reactivation_legacy_repairs
       where admin_user_id = '$admin_id'::uuid
          or user_id in (
            '$reactivate_id'::uuid,
            '$legacy_auth_first_id'::uuid,
            '$legacy_delete_first_id'::uuid
          );
      delete from public.account_deletion_cleanup_jobs
       where user_id in (
            '$reactivate_id'::uuid,
            '$legacy_auth_first_id'::uuid,
            '$legacy_delete_first_id'::uuid
          );
      delete from public.admin_mutation_requests
       where admin_user_id = '$admin_id'::uuid;

      alter table public.account_reactivation_jobs
        enable trigger trg_account_reactivation_jobs_guard;
      alter table public.account_reactivation_legacy_repairs
        enable trigger trg_account_reactivation_legacy_repairs_guard;
      alter table public.admin_mutation_requests
        enable trigger trg_admin_mutation_requests_guard;

      delete from public.admin_actions_ledger
       where admin_user_id = '$admin_id'::uuid
          or target_user_id = '$owner_id'::uuid
          or order_uuid = '$order_id'::uuid;
      delete from public.credit_ledger
       where user_id = '$owner_id'::uuid
          or ref_order_uuid = '$order_id'::uuid;
      delete from public.credit_lots
       where user_id = '$owner_id'::uuid
          or order_uuid = '$order_id'::uuid;
      delete from public.orders
       where order_uuid = '$order_id'::uuid
          or user_id = '$owner_id'::uuid;
      delete from public.member_accounts
       where user_id in (
            '$admin_id'::uuid,
            '$owner_id'::uuid,
            '$reactivate_id'::uuid,
            '$legacy_auth_first_id'::uuid,
            '$legacy_delete_first_id'::uuid
          );
      delete from auth.users
       where id in (
            '$admin_id'::uuid,
            '$owner_id'::uuid,
            '$reactivate_id'::uuid,
            '$legacy_auth_first_id'::uuid,
            '$legacy_delete_first_id'::uuid
          );
      commit;
    " >"$qa_tmp_dir/cleanup.out" 2>&1; then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        with fixture_users(id) as (
          values
            ('$admin_id'::uuid),
            ('$owner_id'::uuid),
            ('$reactivate_id'::uuid),
            ('$legacy_auth_first_id'::uuid),
            ('$legacy_delete_first_id'::uuid)
        )
        select
          (
            select pg_catalog.count(*)
              from public.moderation_actions_ledger
             where target_id = '$doll_id'::uuid
                or admin_user_id = '$admin_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.content_report_submission_receipts
             where target_id = '$doll_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.content_reports
             where target_id = '$doll_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.integrity_actions_ledger
             where target_id = '$score_id'::uuid
                or admin_user_id = '$admin_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.scores
             where id = '$score_id'::uuid
                or owner_id = '$owner_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.dolls
             where id = '$doll_id'::uuid
                or owner_id = '$owner_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.events
             where created_by = '$admin_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.events_audit
             where admin_user_id = '$admin_id'::uuid
                or event_id in (
                  select id from public.events
                   where created_by = '$admin_id'::uuid
                )
          )
          + (
            select pg_catalog.count(*)
              from public.account_admin_actions_ledger
             where admin_user_id in (select id from fixture_users)
                or target_user_id in (select id from fixture_users)
          )
          + (
            select pg_catalog.count(*)
              from public.account_reactivation_jobs
             where admin_user_id in (select id from fixture_users)
                or user_id in (select id from fixture_users)
          )
          + (
            select pg_catalog.count(*)
              from public.account_reactivation_legacy_repairs
             where admin_user_id in (select id from fixture_users)
                or user_id in (select id from fixture_users)
          )
          + (
            select pg_catalog.count(*)
              from public.account_deletion_cleanup_jobs
             where user_id in (select id from fixture_users)
          )
          + (
            select pg_catalog.count(*)
              from public.admin_mutation_requests
             where admin_user_id = '$admin_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.admin_actions_ledger
             where admin_user_id in (select id from fixture_users)
                or target_user_id in (select id from fixture_users)
                or order_uuid = '$order_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.credit_ledger
             where user_id in (select id from fixture_users)
                or ref_order_uuid = '$order_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.credit_lots
             where user_id in (select id from fixture_users)
                or order_uuid = '$order_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.orders
             where user_id in (select id from fixture_users)
                or order_uuid = '$order_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in (select id from fixture_users)
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in (select id from fixture_users)
          )
          + (
            select pg_catalog.count(*)
              from auth.identities
             where user_id in (select id from fixture_users)
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in (select id from fixture_users)
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "admin mutation race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
    if [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
      tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
    fi
  fi
  if [[ -d "$qa_tmp_dir" && "$qa_tmp_dir" == */boss-paegi-admin-mutation-races.* ]]; then
    rm -rf "$qa_tmp_dir"
  fi
  if (( cleanup_failed != 0 && original_status == 0 )); then
    exit 1
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "admin mutation race QA failed: $*" >&2
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

# Run a two-session interleaving. The owner executes the mutation and remains
# idle in its transaction while the waiter is proven blocked. Only then is the
# owner committed. This makes every race deterministic instead of timing-based.
run_pair() {
  pair_name="$1"
  owner_sql="$2"
  waiter_sql="$3"
  waiter_expectation="$4"
  waiter_error="${5:-}"
  owner_app="bp_qa_${pair_name}_owner_$$"
  waiter_app="bp_qa_${pair_name}_waiter_$$"
  owner_fifo="$qa_tmp_dir/${pair_name}.fifo"
  last_owner_out="$qa_tmp_dir/${pair_name}-owner.out"
  last_waiter_out="$qa_tmp_dir/${pair_name}-waiter.out"

  mkfifo "$owner_fifo"
  db_psql -qAt <"$owner_fifo" >"$last_owner_out" 2>&1 &
  active_owner_pid="$!"
  exec 3>"$owner_fifo"
  printf "%s\n" "
    set application_name = '$owner_app';
    set statement_timeout = '20s';
    set lock_timeout = '15s';
    begin;
    $owner_sql;
  " >&3
  wait_for_activity \
    "$owner_app" \
    "state = 'idle in transaction' and xact_start is not null" \
    "$pair_name owner transaction"

  db_psql -qAt -c "
    set application_name = '$waiter_app';
    set statement_timeout = '20s';
    set lock_timeout = '15s';
    $waiter_sql;
  " >"$last_waiter_out" 2>&1 &
  active_waiter_pid="$!"
  wait_for_activity \
    "$waiter_app" \
    "state = 'active' and wait_event_type = 'Lock'" \
    "$pair_name waiter lock"

  blocker_count="$(
    db_value "
      select pg_catalog.cardinality(
               pg_catalog.pg_blocking_pids(a.pid)
             )
        from pg_catalog.pg_stat_activity a
       where a.datname = '$db_name'
         and a.application_name = '$waiter_app';
    "
  )"
  [[ "$blocker_count" == "1" ]] \
    || fail "$pair_name waiter does not have exactly one blocker"

  printf "commit;\n\\q\n" >&3
  exec 3>&-
  wait "$active_owner_pid" || fail "$pair_name owner transaction failed"
  active_owner_pid=""

  waiter_succeeded=false
  if wait "$active_waiter_pid"; then
    waiter_succeeded=true
  fi
  active_waiter_pid=""
  if [[ "$waiter_expectation" == "success" ]]; then
    [[ "$waiter_succeeded" == "true" ]] \
      || fail "$pair_name waiter unexpectedly failed"
  else
    [[ "$waiter_succeeded" == "false" ]] \
      || fail "$pair_name waiter unexpectedly succeeded"
    grep -F "$waiter_error" "$last_waiter_out" >/dev/null \
      || fail "$pair_name waiter did not fail with $waiter_error"
  fi
}

new_uuid() {
  db_value "select pg_catalog.gen_random_uuid();"
}

catalog_ok="$(
  db_value "
    select (
      to_regclass('public.admin_mutation_requests') is not null
      and to_regprocedure(
        'public.admin_save_event_idempotent(uuid,text,text,text,text,text,timestamp with time zone,timestamp with time zone,boolean,boolean,boolean,boolean,integer,boolean,boolean,integer,uuid,bigint,uuid,text)'
      ) is not null
      and to_regprocedure(
        'public.admin_integrity_action_idempotent(text,uuid,uuid,text,text,bigint,uuid)'
      ) is not null
      and to_regprocedure(
        'public.admin_moderation_action_idempotent(text,uuid,uuid,text,text,bigint,uuid)'
      ) is not null
      and to_regprocedure(
        'public.admin_begin_account_reactivation(uuid,uuid,text,text,timestamp with time zone,uuid)'
      ) is not null
      and to_regprocedure(
        'public.request_account_reactivation_cancellation(uuid,uuid,uuid,text,timestamp with time zone,bigint)'
      ) is not null
      and to_regprocedure(
        'public.finish_account_reactivation_legacy_repair(uuid,uuid,uuid,integer,boolean,text)'
      ) is not null
      and to_regprocedure(
        'public.claim_account_deletion_cleanup_v2(uuid,integer,integer)'
      ) is not null
      and to_regprocedure(
        'public.arm_account_deletion_cleanup_auth_fence(uuid,uuid,uuid,integer)'
      ) is not null
      and to_regprocedure(
        'public.finish_account_deletion_cleanup_v2(uuid,uuid,integer,boolean,text)'
      ) is not null
      and exists (
        select 1
          from pg_catalog.pg_trigger
         where tgrelid = 'auth.users'::regclass
           and tgname =
                 'trg_auth_users_fence_account_deletion_scrub'
           and not tgisinternal
      )
      and to_regprocedure(
        'public.admin_settle_stuck_order_verified(uuid,uuid,text,uuid,timestamp with time zone,text,text,jsonb)'
      ) is not null
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "0085/008903 contract surface is not applied; rebuild the local DB"

deadlocks_before="$(
  db_value "
    select deadlocks
      from pg_catalog.pg_stat_database
     where datname = '$db_name';
  "
)"

admin_id="$(new_uuid)"
owner_id="$(new_uuid)"
reactivate_id="$(new_uuid)"
doll_id="$(new_uuid)"
score_id="$(new_uuid)"
order_id="$(new_uuid)"
event_intent="$(new_uuid)"
event_create_one="$(new_uuid)"
event_create_two="$(new_uuid)"
event_recover_request="$(new_uuid)"
event_update_one="$(new_uuid)"
event_update_two="$(new_uuid)"
event_abort_request="$(new_uuid)"
integrity_clear_request="$(new_uuid)"
integrity_void_request="$(new_uuid)"
moderation_dismiss_request="$(new_uuid)"
moderation_takedown_request="$(new_uuid)"
reactivation_one="$(new_uuid)"
reactivation_two="$(new_uuid)"
reactivation_cancel_request="$(new_uuid)"
legacy_auth_first_id="$(new_uuid)"
legacy_delete_first_id="$(new_uuid)"
legacy_auth_first_job="$(new_uuid)"
legacy_delete_first_job="$(new_uuid)"
settlement_one="$(new_uuid)"
settlement_two="$(new_uuid)"
deleted_at="2026-07-21 01:02:03+00"
deleted_at_two="2026-07-21 01:02:04+00"

for id in \
  "$admin_id" "$owner_id" "$reactivate_id" "$doll_id" "$score_id" \
  "$order_id" "$event_intent" "$event_create_one" "$event_create_two" \
  "$event_recover_request" "$event_update_one" "$event_update_two" \
  "$event_abort_request" "$integrity_clear_request" \
  "$integrity_void_request" "$moderation_dismiss_request" \
  "$moderation_takedown_request" "$reactivation_one" \
  "$reactivation_two" "$reactivation_cancel_request" \
  "$legacy_auth_first_id" "$legacy_delete_first_id" \
  "$legacy_auth_first_job" "$legacy_delete_first_job" \
  "$settlement_one" "$settlement_two"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid UUID"
done

db_psql -q -c "
  insert into auth.users(id, email, raw_app_meta_data) values
    (
      '$admin_id'::uuid,
      'admin-race-$admin_id@test.local',
      '{\"provider\":\"email\"}'::jsonb
    ),
    (
      '$owner_id'::uuid,
      'owner-race-$owner_id@test.local',
      '{\"provider\":\"email\"}'::jsonb
    ),
    (
      '$reactivate_id'::uuid,
      'deleted+$reactivate_id@deleted.invalid',
      '{\"provider\":\"google\"}'::jsonb
    ),
    (
      '$legacy_auth_first_id'::uuid,
      'deleted+$legacy_auth_first_id@deleted.invalid',
      '{\"provider\":\"google\",\"keep\":\"auth-first\"}'::jsonb
    ),
    (
      '$legacy_delete_first_id'::uuid,
      'deleted+$legacy_delete_first_id@deleted.invalid',
      '{\"provider\":\"google\",\"keep\":\"delete-first\"}'::jsonb
    );

  insert into public.member_accounts(
    user_id, gen_credits, email, is_admin
  ) values
    (
      '$admin_id'::uuid,
      0,
      'admin-race-$admin_id@test.local',
      true
    ),
    (
      '$owner_id'::uuid,
      0,
      'owner-race-$owner_id@test.local',
      false
    ),
    ('$reactivate_id'::uuid, 0, null, false),
    (
      '$legacy_auth_first_id'::uuid,
      0,
      'legacy-auth-first-$legacy_auth_first_id@test.local',
      false
    ),
    (
      '$legacy_delete_first_id'::uuid,
      0,
      'legacy-delete-first-$legacy_delete_first_id@test.local',
      false
    );

  insert into public.account_reactivation_legacy_repairs(
    id,
    admin_user_id,
    user_id,
    expected_withdrawal_generation,
    resolved_email,
    next_attempt_at,
    created_at
  ) values
    (
      '$legacy_auth_first_job'::uuid,
      '$admin_id'::uuid,
      '$legacy_auth_first_id'::uuid,
      0,
      'legacy-auth-first-$legacy_auth_first_id@test.local',
      '-infinity'::timestamptz,
      '-infinity'::timestamptz
    ),
    (
      '$legacy_delete_first_job'::uuid,
      '$admin_id'::uuid,
      '$legacy_delete_first_id'::uuid,
      0,
      'legacy-delete-first-$legacy_delete_first_id@test.local',
      '1970-01-01 00:00:00+00'::timestamptz,
      '1970-01-01 00:00:00+00'::timestamptz
    );

  update public.profiles
     set deleted_at = '$deleted_at'::timestamptz,
         display_name = '탈퇴한 사용자'
   where id = '$reactivate_id'::uuid;

  insert into auth.identities(
    provider_id, user_id, identity_data, provider, created_at, updated_at
  ) values (
    'google-$reactivate_id',
    '$reactivate_id'::uuid,
    pg_catalog.jsonb_build_object(
      'sub', 'google-$reactivate_id',
      'email', 'restore-race-$reactivate_id@test.local',
      'name', '복구경쟁'
    ),
    'google',
    clock_timestamp(),
    clock_timestamp()
  );

  insert into public.dolls(id, owner_id, image_url)
  values (
    '$doll_id'::uuid,
    '$owner_id'::uuid,
    'https://example.test/storage/v1/object/public/dolls/$doll_id.png'
  );
  insert into public.scores(
    id, owner_id, doll_id, score, weapon, duration_ms
  ) values (
    '$score_id'::uuid,
    '$owner_id'::uuid,
    '$doll_id'::uuid,
    17,
    'fist',
    900
  );
  insert into public.content_reports(
    target_type, target_id, reason, detail
  ) values (
    'doll',
    '$doll_id'::uuid,
    'spam',
    'admin mutation race fixture'
  );
  insert into public.orders(
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
  ) values (
    '$order_id'::uuid,
    '$owner_id'::uuid,
    'qa-admin-race',
    1000,
    3,
    'pending',
    'portone',
    pg_catalog.replace('$order_id', '-', ''),
    true,
    'card',
    'store-qa',
    'KRW',
    'channel-card-test'
  );
" >/dev/null

settlement_paid_at="$(
  db_value "select pg_catalog.clock_timestamp();"
)"

# A) Two delivery UUIDs for one event-create intent must serialize and converge
# on one event. This covers both request replay and response-loss key rotation.
event_create_sql() {
  request_id="$1"
  cat <<SQL
select public.admin_save_event_idempotent(
  null,
  'notice',
  'Race event',
  'Race summary',
  'Race body',
  null,
  null,
  null,
  false,
  false,
  false,
  false,
  0,
  false,
  false,
  7,
  '$admin_id'::uuid,
  0,
  '$request_id'::uuid,
  'new:$event_intent'
)
SQL
}

run_pair \
  "event_create_intent" \
  "$(event_create_sql "$event_create_one")" \
  "$(event_create_sql "$event_create_two")" \
  "success"
grep -F '"idempotent": true' "$last_waiter_out" >/dev/null \
  || fail "rotated event-create delivery did not converge idempotently"

event_id="$(
  db_value "
    select result->>'id'
      from public.admin_mutation_requests
     where request_id = '$event_create_one'::uuid;
  "
)"
[[ "$event_id" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "event-create receipt did not contain a valid event UUID"
event_create_state="$(
  db_value "
    select
      (
        select count(*)
          from public.events
         where id = '$event_id'::uuid
      )::text
      || '|' ||
      (
        select count(*)
          from public.events_audit
         where event_id = '$event_id'::uuid
           and action = 'event_saved'
      )::text
      || '|' ||
      (
        select count(*)
          from public.admin_mutation_requests
         where operation = 'event_save'
           and target_key = 'new:$event_intent'
           and state = 'completed'
      )::text;
  "
)"
[[ "$event_create_state" == "1|1|2" ]] \
  || fail "event-create convergence expected event=1,audit=1,receipts=2 ($event_create_state)"

# B) Recovery racing a POST waits on the request lock and returns the completed
# receipt after commit, never an aborted false negative.
run_pair \
  "event_post_then_recover" \
  "
    select public.admin_save_event_idempotent(
      '$event_id'::uuid, 'notice', 'Recovered event',
      'Race summary', 'Race body', null, null, null,
      false, false, false, false, 0, false, false, 7,
      '$admin_id'::uuid, 1, '$event_recover_request'::uuid,
      '$event_id'
    )
  " \
  "
    select public.get_admin_mutation_receipt(
      '$admin_id'::uuid,
      '$event_recover_request'::uuid,
      'event_save',
      '$event_id'
    )
  " \
  "success"
grep -F '"state": "completed"' "$last_waiter_out" >/dev/null \
  || fail "recovery behind POST did not return the completed receipt"

# C) Different edits from the same snapshot serialize on the event lock; only
# one can advance the CAS version.
run_pair \
  "event_stale_edit" \
  "
    select public.admin_save_event_idempotent(
      '$event_id'::uuid, 'notice', 'Winning event edit',
      'Race summary', 'Race body', null, null, null,
      false, false, false, false, 0, false, false, 7,
      '$admin_id'::uuid, 2, '$event_update_one'::uuid,
      '$event_id'
    )
  " \
  "
    select public.admin_save_event_idempotent(
      '$event_id'::uuid, 'notice', 'Losing event edit',
      'Race summary', 'Race body', null, null, null,
      false, false, false, false, 0, false, false, 7,
      '$admin_id'::uuid, 2, '$event_update_two'::uuid,
      '$event_id'
    )
  " \
  "failure" \
  "version_conflict"
event_edit_state="$(
  db_value "
    select title || '|' || mutation_version::text
      from public.events
     where id = '$event_id'::uuid;
  "
)"
[[ "$event_edit_state" == "Winning event edit|3" ]] \
  || fail "event stale edit did not preserve winner/version ($event_edit_state)"

# D) Recovery-before-POST creates a tombstone while holding the same request
# lock. The late publish must wait and then fail without changing the event.
run_pair \
  "event_recover_then_post" \
  "
    select public.get_admin_mutation_receipt(
      '$admin_id'::uuid,
      '$event_abort_request'::uuid,
      'event_publish',
      '$event_id'
    )
  " \
  "
    select public.admin_transition_event_idempotent(
      '$event_id'::uuid,
      'publish',
      3,
      '$admin_id'::uuid,
      '$event_abort_request'::uuid
    )
  " \
  "failure" \
  "request_aborted"
event_abort_state="$(
  db_value "
    select e.status || '|' || e.mutation_version::text || '|' || r.state
      from public.events e
      join public.admin_mutation_requests r
        on r.request_id = '$event_abort_request'::uuid
     where e.id = '$event_id'::uuid;
  "
)"
[[ "$event_abort_state" == "draft|3|aborted" ]] \
  || fail "recovery-first publish changed event state ($event_abort_state)"

# E) Opposite score decisions from the same snapshot share the member/score
# lock graph. The loser observes the committed winner and fails state CAS.
run_pair \
  "integrity_opposite" \
  "
    select public.admin_integrity_action_idempotent(
      'clear',
      '$admin_id'::uuid,
      '$score_id'::uuid,
      'race clear score',
      'registered',
      0,
      '$integrity_clear_request'::uuid
    )
  " \
  "
    select public.admin_integrity_action_idempotent(
      'void',
      '$admin_id'::uuid,
      '$score_id'::uuid,
      'race void score',
      'registered',
      0,
      '$integrity_void_request'::uuid
    )
  " \
  "failure" \
  "state_conflict"
integrity_state="$(
  db_value "
    select s.review_status || '|' || s.integrity_version::text || '|' ||
      (
        select count(*)
          from public.integrity_actions_ledger l
         where l.target_type = 'score'
           and l.target_id = s.id
      )::text
      from public.scores s
     where s.id = '$score_id'::uuid;
  "
)"
[[ "$integrity_state" == "cleared|1|1" ]] \
  || fail "integrity opposite race expected cleared/version1/audit1 ($integrity_state)"

# F) Opposite moderation actions serialize on the doll row. Dismiss wins;
# stale takedown cannot hide content after the report state/version changed.
run_pair \
  "moderation_opposite" \
  "
    select public.admin_moderation_action_idempotent(
      'dismiss',
      '$admin_id'::uuid,
      '$doll_id'::uuid,
      'race dismiss reports',
      'pending',
      1,
      '$moderation_dismiss_request'::uuid
    )
  " \
  "
    select public.admin_moderation_action_idempotent(
      'takedown',
      '$admin_id'::uuid,
      '$doll_id'::uuid,
      'race hide doll',
      'pending',
      1,
      '$moderation_takedown_request'::uuid
    )
  " \
  "failure" \
  "state_conflict"
moderation_state="$(
  db_value "
    select
      case when d.deleted_at is null then 'visible' else 'hidden' end
      || '|' || d.moderation_version::text || '|' ||
      (
        select count(*)
          from public.moderation_actions_ledger l
         where l.target_id = d.id
      )::text
      from public.dolls d
     where d.id = '$doll_id'::uuid;
  "
)"
[[ "$moderation_state" == "visible|2|1" ]] \
  || fail "moderation opposite race expected visible/version2/audit1 ($moderation_state)"

# G) Different tabs beginning the same reactivation serialize on the global
# email namespace. The second resumes the first operation, while DB activation
# remains fenced until the external GoTrue step is completed.
reactivation_sql() {
  request_id="$1"
  cat <<SQL
select public.admin_begin_account_reactivation(
  '$reactivate_id'::uuid,
  '$admin_id'::uuid,
  'race restore account',
  null,
  '$deleted_at'::timestamptz,
  '$request_id'::uuid
)
SQL
}
run_pair \
  "reactivation_resume" \
  "$(reactivation_sql "$reactivation_one")" \
  "$(reactivation_sql "$reactivation_two")" \
  "success"
grep -F "\"operationRequestId\": \"$reactivation_one\"" \
  "$last_waiter_out" >/dev/null \
  || fail "second reactivation tab did not resume the first operation"
reactivation_state="$(
  db_value "
    select
      case when p.deleted_at is null then 'active' else 'deleted' end
      || '|' ||
      (
        select count(*)
          from public.admin_mutation_requests r
         where r.operation = 'account_reactivate'
           and r.target_key = p.id::text
           and r.state = 'pending'
      )::text
      from public.profiles p
     where p.id = '$reactivate_id'::uuid;
  "
)"
[[ "$reactivation_state" == "deleted|1" ]] \
  || fail "reactivation begin exposed DB activation or duplicate pending rows ($reactivation_state)"

# H) A leased activation finish that owns the account job lock commits first.
# The later cancellation must wait and then fail against completed terminal
# state; it cannot compensate an already-visible active account.
db_psql -q -c "
  begin;
  select public.claim_account_reactivation_job(
    '$reactivation_one'::uuid,
    '$admin_id'::uuid,
    '$reactivate_id'::uuid,
    120
  );
  select public.arm_account_reactivation_auth_fence(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$reactivation_one'::uuid;
  update auth.users
     set email = 'restore-race-$reactivate_id@test.local',
         updated_at = clock_timestamp()
   where id = '$reactivate_id'::uuid;
  commit;
" >/dev/null
reactivation_finish_token="$(
  db_value "
    select lease_token
      from public.account_reactivation_jobs
     where request_id = '$reactivation_one'::uuid;
  "
)"
reactivation_finish_version="$(
  db_value "
    select lease_version
      from public.account_reactivation_jobs
     where request_id = '$reactivation_one'::uuid;
  "
)"
reactivation_generation_one="$(
  db_value "
    select withdrawal_generation
      from public.profiles
     where id = '$reactivate_id'::uuid;
  "
)"
[[ "$reactivation_finish_token" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "activation finish lease token is invalid"
[[ "$reactivation_finish_version" =~ ^[1-9][0-9]*$ ]] \
  || fail "activation finish lease version is invalid"
run_pair \
  "reactivation_finish_wins" \
  "
    select public.finish_account_reactivation_job(
      '$reactivation_one'::uuid,
      '$admin_id'::uuid,
      '$reactivate_id'::uuid,
      '$reactivation_finish_token'::uuid,
      $reactivation_finish_version,
      true,
      null
    )
  " \
  "
    select public.request_account_reactivation_cancellation(
      '$reactivation_one'::uuid,
      '$reactivate_id'::uuid,
      '$admin_id'::uuid,
      'race cancellation after completion',
      '$deleted_at'::timestamptz,
      $reactivation_generation_one
    )
  " \
  "error" \
  "reactivation_already_completed"
reactivation_finish_state="$(
  db_value "
    select
      case when p.deleted_at is null then 'active' else 'deleted' end
      || '|' || j.status
      || '|' || r.state
      || '|' || u.email
      || '|' ||
      (
        select count(*)
          from public.account_admin_actions_ledger l
         where l.target_user_id = p.id
           and l.action_type = 'account_reactivate'
      )::text
      || '|' ||
      case
        when coalesce(u.raw_app_meta_data, '{}'::jsonb)
               ? 'bp_reactivation_fence'
        then 'fenced'
        else 'scrubbed'
      end
      from public.profiles p
      join public.account_reactivation_jobs j
        on j.user_id = p.id
       and j.request_id = '$reactivation_one'::uuid
      join public.admin_mutation_requests r
        on r.request_id = j.request_id
      join auth.users u on u.id = p.id
     where p.id = '$reactivate_id'::uuid;
  "
)"
[[ "$reactivation_finish_state" == \
  "active|completed|completed|restore-race-$reactivate_id@test.local|1|scrubbed" ]] \
  || fail "finish-first reactivation did not converge ($reactivation_finish_state)"

# I) A cancellation that owns the same job lock first invalidates the live
# activation lease. The paused finish waits, then fails stale; a new exact
# cancel lease restores the deletion marker and reaches cancelled terminal.
# Recreate the withdrawn fixture through the real bounded cleanup Auth action;
# direct real->marker writes are correctly rejected by the permanent fence.
db_psql -q -c "
  select public.admin_soft_delete_account('$reactivate_id'::uuid);
" >/dev/null
reactivation_cleanup_job="$(
  db_value "
    select id
      from public.account_deletion_cleanup_jobs
     where user_id = '$reactivate_id'::uuid
       and status = 'pending'
     order by created_at desc, id desc
     limit 1;
  "
)"
[[ "$reactivation_cleanup_job" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "reactivation fixture cleanup job is invalid"
db_psql -q -c "
  update public.account_deletion_cleanup_jobs
     set final_sweep_after = clock_timestamp() - interval '1 second',
         next_attempt_at = clock_timestamp()
   where id = '$reactivation_cleanup_job'::uuid;
" >/dev/null
reactivation_cleanup_lease="$(
  db_value "
    select (v->>'lease_token') || '|'
           || (v->>'lease_version') || '|'
           || (v->>'scrub_auth')
      from (
        select public.claim_account_deletion_cleanup_v2(
          '$reactivation_cleanup_job'::uuid,
          120,
          100
        ) v
      ) q;
  "
)"
IFS='|' read -r \
  reactivation_cleanup_token \
  reactivation_cleanup_version \
  reactivation_cleanup_action <<<"$reactivation_cleanup_lease"
[[ "$reactivation_cleanup_token" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "reactivation fixture cleanup token is invalid"
[[ "$reactivation_cleanup_version" =~ ^[1-9][0-9]*$ ]] \
  || fail "reactivation fixture cleanup version is invalid"
[[ "$reactivation_cleanup_action" == "true" ]] \
  || fail "reactivation fixture cleanup did not require Auth scrub"
db_psql -q -c "
  select public.arm_account_deletion_cleanup_auth_fence(
    '$reactivation_cleanup_job'::uuid,
    '$reactivate_id'::uuid,
    '$reactivation_cleanup_token'::uuid,
    $reactivation_cleanup_version
  );
" >/dev/null
db_psql -q -c "
  update auth.users
     set email = 'deleted+$reactivate_id@deleted.invalid',
         raw_user_meta_data = '{}'::jsonb,
         updated_at = clock_timestamp()
   where id = '$reactivate_id'::uuid;
" >/dev/null
reactivation_cleanup_finish="$(
  db_value "
    select public.finish_account_deletion_cleanup_v2(
      '$reactivation_cleanup_job'::uuid,
      '$reactivation_cleanup_token'::uuid,
      $reactivation_cleanup_version,
      true,
      null
    )->>'status';
  "
)"
[[ "$reactivation_cleanup_finish" == "completed" ]] \
  || fail \
    "reactivation fixture cleanup did not complete ($reactivation_cleanup_finish)"
deleted_at_two="$(
  db_value "
    select deleted_at::text
      from public.profiles
     where id = '$reactivate_id'::uuid;
  "
)"
reactivation_generation_two="$(
  db_value "
    select withdrawal_generation
      from public.profiles
     where id = '$reactivate_id'::uuid;
  "
)"
[[ "$reactivation_generation_two" =~ ^[1-9][0-9]*$ ]] \
  || fail "second withdrawal generation is invalid"
db_psql -q -c "
  begin;
  select public.admin_begin_account_reactivation(
    '$reactivate_id'::uuid,
    '$admin_id'::uuid,
    'race cancellation wins',
    null,
    '$deleted_at_two'::timestamptz,
    $reactivation_generation_two,
    '$reactivation_cancel_request'::uuid
  );
  select public.claim_account_reactivation_job(
    '$reactivation_cancel_request'::uuid,
    '$admin_id'::uuid,
    '$reactivate_id'::uuid,
    120
  );
  select public.arm_account_reactivation_auth_fence(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$reactivation_cancel_request'::uuid;
  update auth.users
     set email = 'restore-race-$reactivate_id@test.local',
         updated_at = clock_timestamp()
   where id = '$reactivate_id'::uuid;
  commit;
" >/dev/null
cancelled_activation_token="$(
  db_value "
    select lease_token
      from public.account_reactivation_jobs
     where request_id = '$reactivation_cancel_request'::uuid;
  "
)"
cancelled_activation_version="$(
  db_value "
    select lease_version
      from public.account_reactivation_jobs
     where request_id = '$reactivation_cancel_request'::uuid;
  "
)"
[[ "$cancelled_activation_token" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "cancel-race activation token is invalid"
run_pair \
  "reactivation_cancel_wins" \
  "
    select public.request_account_reactivation_cancellation(
      '$reactivation_cancel_request'::uuid,
      '$reactivate_id'::uuid,
      '$admin_id'::uuid,
      'race cancellation wins',
      '$deleted_at_two'::timestamptz,
      $reactivation_generation_two
    )
  " \
  "
    select public.finish_account_reactivation_job(
      '$reactivation_cancel_request'::uuid,
      '$admin_id'::uuid,
      '$reactivate_id'::uuid,
      '$cancelled_activation_token'::uuid,
      $cancelled_activation_version,
      true,
      null
    )
  " \
  "error" \
  "stale_lease"
db_psql -q -c "
  begin;
  select public.claim_account_reactivation_job(
    '$reactivation_cancel_request'::uuid,
    '$admin_id'::uuid,
    '$reactivate_id'::uuid,
    120
  );
  select public.arm_account_reactivation_auth_fence(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$reactivation_cancel_request'::uuid;
  update auth.users
     set email = 'deleted+$reactivate_id@deleted.invalid',
         updated_at = clock_timestamp()
   where id = '$reactivate_id'::uuid;
  select public.finish_account_reactivation_job(
    j.request_id,
    j.admin_user_id,
    j.user_id,
    j.lease_token,
    j.lease_version,
    true,
    null
  )
    from public.account_reactivation_jobs j
   where j.request_id = '$reactivation_cancel_request'::uuid;
  commit;
" >/dev/null
reactivation_cancel_state="$(
  db_value "
    select
      case when p.deleted_at is null then 'active' else 'deleted' end
      || '|' || j.status
      || '|' || r.state
      || '|' || u.email
      || '|' ||
      (
        select count(*)
          from public.account_admin_actions_ledger l
         where l.target_user_id = p.id
           and l.metadata->>'operation_request_id' =
                 '$reactivation_cancel_request'
           and l.metadata->>'cancelled' = 'true'
      )::text
      || '|' ||
      case
        when coalesce(u.raw_app_meta_data, '{}'::jsonb)
               ? 'bp_reactivation_fence'
        then 'fenced'
        else 'scrubbed'
      end
      from public.profiles p
      join public.account_reactivation_jobs j
        on j.user_id = p.id
       and j.request_id = '$reactivation_cancel_request'::uuid
      join public.admin_mutation_requests r
        on r.request_id = j.request_id
      join auth.users u on u.id = p.id
     where p.id = '$reactivate_id'::uuid;
  "
)"
[[ "$reactivation_cancel_state" == \
  "deleted|cancelled|cancelled|deleted+$reactivate_id@deleted.invalid|1|scrubbed" ]] \
  || fail "cancel-first reactivation did not converge ($reactivation_cancel_state)"

# J) Distinct verified settlement UUIDs serialize on the financial object.
# The loser converges from the unique ledger, producing its own no-op receipt
# but no second credits, lot, or audit.
settlement_sql() {
  request_id="$1"
  cat <<SQL
select public.admin_settle_stuck_order_verified(
  '$admin_id'::uuid,
  '$order_id'::uuid,
  'race settle order',
  '$request_id'::uuid,
  '$settlement_paid_at'::timestamptz,
  'qa-admin-race-$order_id',
  'https://example.test/race-receipt',
  pg_catalog.jsonb_build_object(
    'id', pg_catalog.replace('$order_id', '-', ''),
    'status', 'PAID',
    'transactionId', 'qa-admin-race-$order_id',
    'paidAt', '$settlement_paid_at'::timestamptz,
    'receiptUrl', 'https://example.test/race-receipt',
    'amount', pg_catalog.jsonb_build_object('total', 1000),
    'storeId', 'store-qa',
    'currency', 'KRW',
    'channel', pg_catalog.jsonb_build_object(
      'type', 'TEST',
      'key', 'channel-card-test'
    )
  )
)
SQL
}
run_pair \
  "settlement_converge" \
  "$(settlement_sql "$settlement_one")" \
  "$(settlement_sql "$settlement_two")" \
  "success"
grep -F '"noOp": true' "$last_waiter_out" >/dev/null \
  || fail "second settlement did not converge as a no-op"
settlement_state="$(
  db_value "
    select
      o.status || '|' || m.gen_credits::text || '|' ||
      (
        select count(*)
          from public.credit_lots l
         where l.order_uuid = o.order_uuid
      )::text || '|' ||
      (
        select count(*)
          from public.admin_actions_ledger l
         where l.order_uuid = o.order_uuid
           and l.action_type = 'settle_stuck'
      )::text || '|' ||
      (
        select count(*)
          from public.admin_mutation_requests r
         where r.operation = 'order_settle'
           and r.target_key = o.order_uuid::text
           and r.state = 'completed'
      )::text
      from public.orders o
      join public.member_accounts m on m.user_id = o.user_id
     where o.order_uuid = '$order_id'::uuid;
  "
)"
[[ "$settlement_state" == "paid|3|1|1|2" ]] \
  || fail "settlement race expected paid/3/lot1/audit1/receipts2 ($settlement_state)"

# K) A rolling marker->real repair owns the dedicated Auth-transition lock
# first. A new withdrawal waits, then creates its durable cleanup outbox. The
# legacy finish observes the new lifecycle and retires its exact fence. The
# deletion worker then claims the bounded v2 job, arms the exact token+version
# Auth action, performs the marker scrub, and finishes the same lease.
db_psql -q -c "
  select public.claim_account_reactivation_legacy_repair(120);
" >/dev/null
legacy_auth_first_token="$(
  db_value "
    select lease_token
      from public.account_reactivation_legacy_repairs
     where id = '$legacy_auth_first_job'::uuid;
  "
)"
legacy_auth_first_version="$(
  db_value "
    select lease_version
      from public.account_reactivation_legacy_repairs
     where id = '$legacy_auth_first_job'::uuid;
  "
)"
[[ "$legacy_auth_first_token" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "legacy auth-first lease token is invalid"
db_psql -q -c "
  select public.arm_account_reactivation_legacy_repair_auth_fence(
    '$legacy_auth_first_job'::uuid,
    '$legacy_auth_first_id'::uuid,
    '$legacy_auth_first_token'::uuid,
    $legacy_auth_first_version
  );
" >/dev/null
run_pair \
  "legacy_auth_transition_wins" \
  "
    update auth.users
       set email =
             'legacy-auth-first-$legacy_auth_first_id@test.local',
           updated_at = clock_timestamp()
     where id = '$legacy_auth_first_id'::uuid
  " \
  "
    select public.admin_soft_delete_account(
      '$legacy_auth_first_id'::uuid
    )
  " \
  "success"
legacy_auth_first_finish="$(
  db_value "
    select public.finish_account_reactivation_legacy_repair(
      '$legacy_auth_first_job'::uuid,
      '$legacy_auth_first_id'::uuid,
      '$legacy_auth_first_token'::uuid,
      $legacy_auth_first_version,
      true,
      null
    )->>'status';
  "
)"
[[ "$legacy_auth_first_finish" == "superseded" ]] \
  || fail "legacy auth-first finish did not supersede"
legacy_auth_cleanup_job="$(
  db_value "
    select id
      from public.account_deletion_cleanup_jobs
     where user_id = '$legacy_auth_first_id'::uuid
       and status = 'pending'
     order by created_at desc, id desc
     limit 1;
  "
)"
[[ "$legacy_auth_cleanup_job" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "legacy auth-first cleanup job is invalid"
db_psql -q -c "
  update public.account_deletion_cleanup_jobs
     set final_sweep_after = clock_timestamp() - interval '1 second',
         next_attempt_at = clock_timestamp()
   where id = '$legacy_auth_cleanup_job'::uuid;
" >/dev/null
legacy_auth_cleanup_lease="$(
  db_value "
    select (v->>'lease_token') || '|'
           || (v->>'lease_version') || '|'
           || (v->>'scrub_auth')
      from (
        select public.claim_account_deletion_cleanup_v2(
          '$legacy_auth_cleanup_job'::uuid,
          120,
          100
        ) v
      ) q;
  "
)"
IFS='|' read -r \
  legacy_auth_cleanup_token \
  legacy_auth_cleanup_version \
  legacy_auth_cleanup_action <<<"$legacy_auth_cleanup_lease"
[[ "$legacy_auth_cleanup_token" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "legacy auth-first cleanup token is invalid"
[[ "$legacy_auth_cleanup_version" =~ ^[1-9][0-9]*$ ]] \
  || fail "legacy auth-first cleanup version is invalid"
[[ "$legacy_auth_cleanup_action" == "true" ]] \
  || fail "legacy auth-first cleanup did not require exact Auth scrub"
db_psql -q -c "
  select public.arm_account_deletion_cleanup_auth_fence(
    '$legacy_auth_cleanup_job'::uuid,
    '$legacy_auth_first_id'::uuid,
    '$legacy_auth_cleanup_token'::uuid,
    $legacy_auth_cleanup_version
  );
" >/dev/null
db_psql -q -c "
  update auth.users
     set email = 'deleted+$legacy_auth_first_id@deleted.invalid',
         raw_user_meta_data = '{}'::jsonb,
         updated_at = clock_timestamp()
   where id = '$legacy_auth_first_id'::uuid;
" >/dev/null
legacy_auth_cleanup_finish="$(
  db_value "
    select public.finish_account_deletion_cleanup_v2(
      '$legacy_auth_cleanup_job'::uuid,
      '$legacy_auth_cleanup_token'::uuid,
      $legacy_auth_cleanup_version,
      true,
      null
    )->>'status';
  "
)"
[[ "$legacy_auth_cleanup_finish" == "completed" ]] \
  || fail \
    "legacy auth-first cleanup did not complete ($legacy_auth_cleanup_finish)"
legacy_auth_first_state="$(
  db_value "
    select
      case when p.deleted_at is null then 'active' else 'deleted' end
      || '|' || j.status
      || '|' || d.status
      || '|' || u.email
      || '|' || coalesce(u.raw_app_meta_data->>'keep', '')
      || '|' ||
      case
        when coalesce(u.raw_app_meta_data, '{}'::jsonb)
               ?| array[
                    'bp_reactivation_fence',
                    'bp_account_cleanup_fence'
                  ]
        then 'fenced'
        else 'scrubbed'
      end
      from public.profiles p
      join public.account_reactivation_legacy_repairs j
        on j.user_id = p.id
       and j.id = '$legacy_auth_first_job'::uuid
      join public.account_deletion_cleanup_jobs d
        on d.user_id = p.id
      join auth.users u on u.id = p.id
     where p.id = '$legacy_auth_first_id'::uuid;
  "
)"
[[ "$legacy_auth_first_state" == \
  "deleted|superseded|completed|deleted+$legacy_auth_first_id@deleted.invalid|auth-first|scrubbed" ]] \
  || fail "legacy auth-first withdrawal did not converge ($legacy_auth_first_state)"

# L) A new withdrawal that owns the dedicated transition lock first closes
# the active-profile legacy branch. The delayed marker->real Auth statement
# waits, then fails atomically; user and identity remain deleted/marked.
db_psql -q -c "
  select public.claim_account_reactivation_legacy_repair(120);
" >/dev/null
legacy_delete_first_token="$(
  db_value "
    select lease_token
      from public.account_reactivation_legacy_repairs
     where id = '$legacy_delete_first_job'::uuid;
  "
)"
legacy_delete_first_version="$(
  db_value "
    select lease_version
      from public.account_reactivation_legacy_repairs
     where id = '$legacy_delete_first_job'::uuid;
  "
)"
[[ "$legacy_delete_first_token" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "legacy deletion-first lease token is invalid"
db_psql -q -c "
  select public.arm_account_reactivation_legacy_repair_auth_fence(
    '$legacy_delete_first_job'::uuid,
    '$legacy_delete_first_id'::uuid,
    '$legacy_delete_first_token'::uuid,
    $legacy_delete_first_version
  );
" >/dev/null
run_pair \
  "legacy_withdrawal_wins" \
  "
    select public.admin_soft_delete_account(
      '$legacy_delete_first_id'::uuid
    )
  " \
  "
    update auth.users
       set email =
             'legacy-delete-first-$legacy_delete_first_id@test.local',
           updated_at = clock_timestamp()
     where id = '$legacy_delete_first_id'::uuid
  " \
  "error" \
  "stale_reactivation_auth_fence"
legacy_delete_first_finish="$(
  db_value "
    select public.finish_account_reactivation_legacy_repair(
      '$legacy_delete_first_job'::uuid,
      '$legacy_delete_first_id'::uuid,
      '$legacy_delete_first_token'::uuid,
      $legacy_delete_first_version,
      true,
      null
    )->>'status';
  "
)"
[[ "$legacy_delete_first_finish" == "superseded" ]] \
  || fail "legacy deletion-first finish did not supersede"
legacy_delete_first_state="$(
  db_value "
    select
      case when p.deleted_at is null then 'active' else 'deleted' end
      || '|' || j.status
      || '|' || d.status
      || '|' || u.email
      || '|' || coalesce(u.raw_app_meta_data->>'keep', '')
      || '|' ||
      case
        when coalesce(u.raw_app_meta_data, '{}'::jsonb)
               ? 'bp_reactivation_fence'
        then 'fenced'
        else 'scrubbed'
      end
      from public.profiles p
      join public.account_reactivation_legacy_repairs j
        on j.user_id = p.id
       and j.id = '$legacy_delete_first_job'::uuid
      join public.account_deletion_cleanup_jobs d
        on d.user_id = p.id
       and d.status in ('pending', 'leased')
      join auth.users u on u.id = p.id
     where p.id = '$legacy_delete_first_id'::uuid;
  "
)"
[[ "$legacy_delete_first_state" == \
  "deleted|superseded|pending|deleted+$legacy_delete_first_id@deleted.invalid|delete-first|scrubbed" ]] \
  || fail "legacy deletion-first withdrawal did not converge ($legacy_delete_first_state)"

deadlocks_after="$(
  db_value "
    select deadlocks
      from pg_catalog.pg_stat_database
     where datname = '$db_name';
  "
)"
[[ "$deadlocks_after" == "$deadlocks_before" ]] \
  || fail "database deadlock counter changed ($deadlocks_before -> $deadlocks_after)"

echo "admin mutation race QA passed: 12 deterministic interleavings, deadlocks=0"
