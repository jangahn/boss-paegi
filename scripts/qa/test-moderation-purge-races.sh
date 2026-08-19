#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

if (( $# != 1 )) || [[ "$1" != "expand" && "$1" != "contract" ]]; then
  echo "usage: $0 <expand|contract>" >&2
  exit 2
fi
expected_stage="$1"

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
if [[ -z "$project_id" ]]; then
  echo "supabase project_id is missing" >&2
  exit 1
fi
db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
if [[ ! "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-purge-race.XXXXXX")"
restore_owner_pid=""
purge_waiter_pid=""
purge_owner_pid=""
restore_waiter_pid=""
repeat_owner_pid=""
finish_waiter_pid=""
admin_id=""
owner_id=""
doll_restore_first=""
doll_purge_first=""
doll_repeat_finish=""

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
  cleanup_failed=0
  cleanup_remaining=""
  exec 3>&-
  for pid in \
    "$restore_owner_pid" "$purge_waiter_pid" "$purge_owner_pid" \
    "$restore_waiter_pid" "$repeat_owner_pid" "$finish_waiter_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$admin_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$owner_id" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      delete from public.moderation_actions_ledger
       where admin_user_id = '$admin_id'::uuid
          or target_id in (
            '$doll_restore_first'::uuid,
            '$doll_purge_first'::uuid,
            '$doll_repeat_finish'::uuid
          );
      delete from public.dolls
       where id in (
         '$doll_restore_first'::uuid,
         '$doll_purge_first'::uuid,
         '$doll_repeat_finish'::uuid
       );
      delete from public.member_accounts
       where user_id in ('$admin_id'::uuid, '$owner_id'::uuid);
      delete from auth.users
       where id in ('$admin_id'::uuid, '$owner_id'::uuid);
      commit;
    " >"$qa_tmp_dir/cleanup.out" 2>&1; then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        select
          (
            select pg_catalog.count(*)
              from public.moderation_actions_ledger
             where admin_user_id = '$admin_id'::uuid
                or target_id in (
                  '$doll_restore_first'::uuid,
                  '$doll_purge_first'::uuid,
                  '$doll_repeat_finish'::uuid
                )
          )
          + (
            select pg_catalog.count(*)
              from public.moderation_purge_jobs
             where doll_id in (
               '$doll_restore_first'::uuid,
               '$doll_purge_first'::uuid,
               '$doll_repeat_finish'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.dolls
             where id in (
               '$doll_restore_first'::uuid,
               '$doll_purge_first'::uuid,
               '$doll_repeat_finish'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in ('$admin_id'::uuid, '$owner_id'::uuid)
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in ('$admin_id'::uuid, '$owner_id'::uuid)
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in ('$admin_id'::uuid, '$owner_id'::uuid)
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "moderation purge race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
    if [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
      tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
    fi
  fi
  rm -f "$qa_tmp_dir"/*
  rmdir "$qa_tmp_dir" >/dev/null 2>&1
  if (( cleanup_failed != 0 && original_status == 0 )); then
    exit 1
  fi
}
trap cleanup EXIT INT TERM

fail() {
  echo "moderation purge race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
      tail -n 30 "$output" >&2
    fi
  done
  exit 1
}

# 세션 동기화는 공용 lib — 상한 120s(러너 속도 무관)·타임아웃 시 세션 스냅샷 덤프.
source scripts/qa/lib/wait-sync.sh

rollout_stage="$(
  db_value "
    select case
      when to_regprocedure(
             'public.admin_begin_doll_purge(uuid,uuid,text)'
           ) is null
        or to_regprocedure(
             'public.claim_moderation_purge_v2(uuid,integer,integer)'
           ) is null
        or to_regprocedure(
             'public.finish_moderation_purge_v2(uuid,uuid,integer,boolean,text)'
           ) is null
        or not exists (
             select 1
               from pg_catalog.pg_trigger
              where tgrelid = 'public.dolls'::regclass
                and tgname = 'trg_dolls_reject_restore_during_purge'
                and not tgisinternal
           )
        then 'invalid'
      when exists (
             select 1
               from public.schema_migration_journal
              where version = '0092_rollout_contract_cleanup'
           )
        and to_regprocedure(
              'public.claim_moderation_purge(uuid,integer)'
            ) is null
        and to_regprocedure(
              'public.finish_moderation_purge(uuid,uuid,integer,boolean,text)'
            ) is null
        then 'contract'
      when not exists (
             select 1
               from public.schema_migration_journal
              where version = '0092_rollout_contract_cleanup'
           )
        and exists (
             select 1
               from public.schema_migration_journal
              where version = '008903_bounded_asset_cleanup_sagas'
           )
        and to_regprocedure(
              'public.claim_moderation_purge(uuid,integer)'
            ) is not null
        and to_regprocedure(
              'public.finish_moderation_purge(uuid,uuid,integer,boolean,text)'
            ) is not null
        then 'expand'
      else 'invalid'
    end;
  "
)"
[[ "$rollout_stage" == "$expected_stage" ]] \
  || fail \
    "expected exact $expected_stage rollout stage; detected $rollout_stage"

admin_id="$(db_value "select gen_random_uuid();")"
owner_id="$(db_value "select gen_random_uuid();")"
doll_restore_first="$(db_value "select gen_random_uuid();")"
doll_purge_first="$(db_value "select gen_random_uuid();")"
doll_repeat_finish="$(db_value "select gen_random_uuid();")"
for id in \
  "$admin_id" "$owner_id" "$doll_restore_first" \
  "$doll_purge_first" "$doll_repeat_finish"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid UUID"
done

db_psql -q -c "
  insert into auth.users(id, email) values
    (
      '$admin_id'::uuid,
      'purge-race-admin-$admin_id@test.local'
    ),
    (
      '$owner_id'::uuid,
      'purge-race-owner-$owner_id@test.local'
    );
  insert into public.member_accounts(user_id, is_admin) values
    ('$admin_id'::uuid, true),
    ('$owner_id'::uuid, false);
  insert into public.dolls(
    id, owner_id, image_url, deleted_at, deleted_by, deletion_reason
  ) values
    (
      '$doll_restore_first'::uuid,
      '$owner_id'::uuid,
      'https://project.test/storage/v1/object/public/dolls/$owner_id/$doll_restore_first.png',
      clock_timestamp(),
      '$admin_id'::uuid,
      'restore-first fixture'
    ),
    (
      '$doll_purge_first'::uuid,
      '$owner_id'::uuid,
      'https://project.test/storage/v1/object/public/dolls/$owner_id/$doll_purge_first.png',
      clock_timestamp(),
      '$admin_id'::uuid,
      'purge-first fixture'
    ),
    (
      '$doll_repeat_finish'::uuid,
      '$owner_id'::uuid,
      'https://project.test/storage/v1/object/public/dolls/$owner_id/$doll_repeat_finish.png',
      clock_timestamp(),
      '$admin_id'::uuid,
      'repeat-finish fixture'
    );
" >/dev/null

# A) restore-first: restore owns the doll row. Purge waits, then observes active
# state and must fail without creating an outbox row.
restore_app="bp_qa_restore_first_$$"
purge_waiter_app="bp_qa_purge_after_restore_$$"
mkfifo "$qa_tmp_dir/restore-first.fifo"
db_psql -qAt <"$qa_tmp_dir/restore-first.fifo" \
  >"$qa_tmp_dir/restore-first.out" 2>&1 &
restore_owner_pid="$!"
exec 3>"$qa_tmp_dir/restore-first.fifo"
printf "%s\n" "
  set application_name = '$restore_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_restore_doll(
    '$admin_id'::uuid,
    '$doll_restore_first'::uuid,
    'restore wins race'
  );
" >&3
wait_for_activity \
  "$restore_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "restore-first transaction"

db_psql -q -c "
  set application_name = '$purge_waiter_app';
  set statement_timeout = '15s';
  select public.admin_begin_doll_purge(
    '$admin_id'::uuid,
    '$doll_restore_first'::uuid,
    'purge loses race'
  );
" >"$qa_tmp_dir/purge-after-restore.out" 2>&1 &
purge_waiter_pid="$!"
wait_for_activity \
  "$purge_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "purge to wait behind restore"
printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$restore_owner_pid" || fail "restore-first transaction failed"
restore_owner_pid=""
if wait "$purge_waiter_pid"; then
  fail "purge after committed restore unexpectedly succeeded"
fi
purge_waiter_pid=""
grep -F "not_taken_down" "$qa_tmp_dir/purge-after-restore.out" >/dev/null \
  || fail "purge loser did not report not_taken_down"
restore_first_state="$(
  db_value "
    select (d.deleted_at is null)::text || '|' || count(j.*)::text
      from public.dolls d
      left join public.moderation_purge_jobs j on j.doll_id = d.id
     where d.id = '$doll_restore_first'::uuid
     group by d.deleted_at;
  "
)"
[[ "$restore_first_state" == "true|0" ]] \
  || fail "restore-first final state is not active + zero purge jobs"

# B) purge-first: begin owns the doll row and durable pending receipt. Restore
# waits, then must fail with purge_pending.
purge_app="bp_qa_purge_first_$$"
restore_waiter_app="bp_qa_restore_after_purge_$$"
mkfifo "$qa_tmp_dir/purge-first.fifo"
db_psql -qAt <"$qa_tmp_dir/purge-first.fifo" \
  >"$qa_tmp_dir/purge-first.out" 2>&1 &
purge_owner_pid="$!"
exec 3>"$qa_tmp_dir/purge-first.fifo"
printf "%s\n" "
  set application_name = '$purge_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_begin_doll_purge(
    '$admin_id'::uuid,
    '$doll_purge_first'::uuid,
    'purge wins race'
  );
" >&3
wait_for_activity \
  "$purge_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "purge-first transaction"

db_psql -q -c "
  set application_name = '$restore_waiter_app';
  set statement_timeout = '15s';
  select public.admin_restore_doll(
    '$admin_id'::uuid,
    '$doll_purge_first'::uuid,
    'restore loses race'
  );
" >"$qa_tmp_dir/restore-after-purge.out" 2>&1 &
restore_waiter_pid="$!"
wait_for_activity \
  "$restore_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "restore to wait behind purge begin"
printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$purge_owner_pid" || fail "purge-first transaction failed"
purge_owner_pid=""
if wait "$restore_waiter_pid"; then
  fail "restore after committed purge begin unexpectedly succeeded"
fi
restore_waiter_pid=""
grep -F "purge_pending" "$qa_tmp_dir/restore-after-purge.out" >/dev/null \
  || fail "restore loser did not report purge_pending"
purge_first_state="$(
  db_value "
    select (d.deleted_at is not null)::text || '|' || count(j.*)::text
      from public.dolls d
      left join public.moderation_purge_jobs j
        on j.doll_id = d.id
       and j.status = 'pending'
     where d.id = '$doll_purge_first'::uuid
     group by d.deleted_at;
  "
)"
[[ "$purge_first_state" == "true|1" ]] \
  || fail "purge-first final state is not hidden + one pending job"

# C) repeated begin and finish both take dolls -> jobs. Force real contention;
# neither side may deadlock and the valid current lease must complete once.
job_id="$(
  db_value "
    select public.admin_begin_doll_purge(
      '$admin_id'::uuid,
      '$doll_repeat_finish'::uuid,
      'repeat begin versus finish'
    )->>'job_id';
  "
)"
db_psql -q -c "
  update public.moderation_purge_jobs
     set final_sweep_after = clock_timestamp() - interval '1 second'
   where id = '$job_id'::uuid;
" >/dev/null
lease="$(
  db_value "
    select (v->>'lease_token') || '|' || (v->>'lease_version')
      from (
        select public.claim_moderation_purge_v2(
          '$job_id'::uuid,
          120,
          100
        ) v
      ) q;
  "
)"
IFS='|' read -r lease_token lease_version <<<"$lease"
[[ "$job_id" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid purge job id"
[[ "$lease_token" =~ ^[0-9a-f-]{36}$ ]] || fail "invalid lease token"
[[ "$lease_version" =~ ^[1-9][0-9]*$ ]] || fail "invalid lease version"

repeat_app="bp_qa_repeat_begin_$$"
finish_waiter_app="bp_qa_finish_after_repeat_$$"
mkfifo "$qa_tmp_dir/repeat-begin.fifo"
db_psql -qAt <"$qa_tmp_dir/repeat-begin.fifo" \
  >"$qa_tmp_dir/repeat-begin.out" 2>&1 &
repeat_owner_pid="$!"
exec 3>"$qa_tmp_dir/repeat-begin.fifo"
printf "%s\n" "
  set application_name = '$repeat_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_begin_doll_purge(
    '$admin_id'::uuid,
    '$doll_repeat_finish'::uuid,
    'repeat begin versus finish'
  );
" >&3
wait_for_activity \
  "$repeat_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "repeat begin to hold doll then job"

db_psql -q -c "
  set application_name = '$finish_waiter_app';
  set statement_timeout = '15s';
  set deadlock_timeout = '100ms';
  select public.finish_moderation_purge_v2(
    '$job_id'::uuid,
    '$lease_token'::uuid,
    $lease_version,
    true,
    null
  );
" >"$qa_tmp_dir/finish-after-repeat.out" 2>&1 &
finish_waiter_pid="$!"
wait_for_activity \
  "$finish_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "finish to wait behind repeated begin"
printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$repeat_owner_pid" || fail "repeated begin transaction failed"
repeat_owner_pid=""
wait "$finish_waiter_pid" \
  || fail "finish deadlocked or failed behind repeated begin"
finish_waiter_pid=""
repeat_finish_state="$(
  db_value "
    select j.status || '|'
           || (d.artifacts_purged_at is not null)::text || '|'
           || count(l.*)::text
      from public.moderation_purge_jobs j
      join public.dolls d on d.id = j.doll_id
      left join public.moderation_actions_ledger l
        on l.target_id = d.id
       and l.action_type = 'purge_doll'
       and l.metadata->>'purge_job_id' = j.id::text
     where j.id = '$job_id'::uuid
     group by j.status, d.artifacts_purged_at;
  "
)"
[[ "$repeat_finish_state" == "completed|true|1" ]] \
  || fail "repeat-begin/finish final state is not one completed purge"

echo "moderation purge race QA passed:"
echo "  rollout stage: $expected_stage; bounded v2 lease API"
echo "  restore-first: purge waited, then not_taken_down"
echo "  purge-first: restore waited, then purge_pending"
echo "  repeat-begin vs finish: no deadlock; one fenced completion"
