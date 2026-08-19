#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
if [[ -z "$project_id" ]] \
  || ! [[ "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database is unavailable" >&2
  exit 1
fi

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-anon-reassign-race.XXXXXX")"
blocker_pid=""
target_a_pid=""
target_b_pid=""
source_user=""
target_a=""
target_b=""
session_id=""
quota_backup_hex=""
quota_fixture_touched="false"

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
  for pid in "$blocker_pid" "$target_a_pid" "$target_b_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$source_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$target_a" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$target_b" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      delete from public.telemetry_sessions
       where id = '$session_id'::uuid;
      delete from public.oauth_anon_auth_cleanup_jobs
       where legacy_source_user_id = '$source_user'::uuid;
      set local session_replication_role = replica;
      delete from public.anon_data_reassignments
       where source_user_id = '$source_user'::uuid;
      set local session_replication_role = origin;
      delete from public.member_accounts
       where user_id in ('$target_a'::uuid, '$target_b'::uuid);
      delete from auth.users
       where id in (
         '$source_user'::uuid,
         '$target_a'::uuid,
         '$target_b'::uuid
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
              from public.telemetry_sessions
             where id = '$session_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.oauth_anon_auth_cleanup_jobs
             where legacy_source_user_id = '$source_user'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.anon_data_reassignments
             where source_user_id = '$source_user'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in ('$target_a'::uuid, '$target_b'::uuid)
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in (
               '$source_user'::uuid,
               '$target_a'::uuid,
               '$target_b'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in (
               '$source_user'::uuid,
               '$target_a'::uuid,
               '$target_b'::uuid
             )
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if [[ "$quota_fixture_touched" == "true" ]]; then
    if [[ -n "$quota_backup_hex" && "$quota_backup_hex" =~ ^[0-9a-f]+$ ]]; then
      if ! db_psql -q -c "
        delete from public.public_write_quota_buckets
         where endpoint = 'telemetry';
        insert into public.public_write_quota_buckets
        select restored.*
          from pg_catalog.json_array_elements(
            pg_catalog.convert_from(
              pg_catalog.decode('$quota_backup_hex', 'hex'),
              'UTF8'
            )::json
          ) elements(value)
          cross join lateral pg_catalog.json_populate_record(
            null::public.public_write_quota_buckets,
            elements.value
          ) restored;
      " >>"$qa_tmp_dir/cleanup.out" 2>&1; then
        cleanup_failed=1
      fi
    elif [[ -z "$quota_backup_hex" ]]; then
      if ! db_psql -q -c "
        delete from public.public_write_quota_buckets
         where endpoint = 'telemetry';
      " >>"$qa_tmp_dir/cleanup.out" 2>&1; then
        cleanup_failed=1
      fi
    else
      cleanup_failed=1
    fi
    if ! quota_current_hex="$(
      db_value "
        select pg_catalog.encode(
                 pg_catalog.convert_to(
                   pg_catalog.json_agg(
                     pg_catalog.row_to_json(q)
                     order by q.endpoint, q.day_kst, q.actor_key
                   )::text,
                   'UTF8'
                 ),
                 'hex'
               )
          from public.public_write_quota_buckets q
         where q.endpoint = 'telemetry';
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$quota_current_hex" != "$quota_backup_hex" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "anonymous reassignment race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
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
  echo "anonymous reassignment race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
      tail -n 20 "$output" >&2
    fi
  done
  exit 1
}

wait_for_activity() {
  predicate="$1"
  expected="$2"
  description="$3"
  for _ in $(seq 1 2400); do
    count="$(
      db_value "
        select count(*)
          from pg_catalog.pg_stat_activity
         where backend_type = 'client backend'
           and ($predicate);
      "
    )"
    if [[ "$count" == "$expected" ]]; then
      return 0
    fi
    sleep 0.05
  done
  fail "timed out waiting for $description"
}

catalog_ok="$(
  db_value "
    select (
      to_regprocedure('public.reassign_anon_data(uuid,uuid)') is not null
      and to_regclass('public.anon_data_reassignments') is not null
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "0074 reassignment fencing is not applied"

quota_backup_hex="$(
  db_value "
    select pg_catalog.encode(
             pg_catalog.convert_to(
               pg_catalog.json_agg(
                 pg_catalog.row_to_json(q)
                 order by q.endpoint, q.day_kst, q.actor_key
               )::text,
               'UTF8'
             ),
             'hex'
           )
      from public.public_write_quota_buckets q
     where q.endpoint = 'telemetry';
  "
)"
[[ -z "$quota_backup_hex" || "$quota_backup_hex" =~ ^[0-9a-f]+$ ]] \
  || fail "could not safely back up telemetry quota rows"
quota_fixture_touched="true"

source_user="$(db_value "select gen_random_uuid();")"
target_a="$(db_value "select gen_random_uuid();")"
target_b="$(db_value "select gen_random_uuid();")"
session_id="$(db_value "select gen_random_uuid();")"
for id in "$source_user" "$target_a" "$target_b" "$session_id"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || fail "PostgreSQL returned an invalid UUID"
done

db_psql -q -c "
  insert into auth.users(
    id,
    email,
    is_anonymous,
    created_at
  ) values
    (
      '$source_user'::uuid,
      'reassign-source-$source_user@test.local',
      true,
      clock_timestamp()
    ),
    (
      '$target_a'::uuid,
      'reassign-target-a-$target_a@test.local',
      false,
      clock_timestamp()
    ),
    (
      '$target_b'::uuid,
      'reassign-target-b-$target_b@test.local',
      false,
      clock_timestamp()
    );
  select public.ingest_telemetry_delta(
    '$session_id'::uuid,
    '$source_user'::uuid,
    false,
    '{\"deviceClass\":\"other\",\"summary\":{\"seqHigh\":1},\"events\":[]}'::jsonb
  );
" >/dev/null

blocker_app="bp_qa_reassign_blocker_$$"
target_a_app="bp_qa_reassign_target_a_$$"
target_b_app="bp_qa_reassign_target_b_$$"

# Hold the exact source lock so both target requests become real concurrent
# waiters. Releasing it elects one durable winner; the other must conflict.
mkfifo "$qa_tmp_dir/blocker.fifo"
db_psql -qAt <"$qa_tmp_dir/blocker.fifo" \
  >"$qa_tmp_dir/blocker.out" 2>&1 &
blocker_pid="$!"
exec 3>"$qa_tmp_dir/blocker.fifo"
printf "%s\n" "
  set application_name = '$blocker_app';
  set statement_timeout = '15s';
  begin;
  select pg_advisory_xact_lock(7401, hashtext('$source_user'));
" >&3
wait_for_activity \
  "application_name = '$blocker_app' and state = 'idle in transaction'" \
  1 \
  "the source lock owner"

db_psql -q -c "
  set application_name = '$target_a_app';
  set statement_timeout = '15s';
  select public.reassign_anon_data(
    '$source_user'::uuid,
    '$target_a'::uuid
  );
" >"$qa_tmp_dir/target-a.out" 2>&1 &
target_a_pid="$!"
db_psql -q -c "
  set application_name = '$target_b_app';
  set statement_timeout = '15s';
  select public.reassign_anon_data(
    '$source_user'::uuid,
    '$target_b'::uuid
  );
" >"$qa_tmp_dir/target-b.out" 2>&1 &
target_b_pid="$!"
wait_for_activity \
  "application_name in ('$target_a_app','$target_b_app')
   and state = 'active'
   and wait_event_type = 'Lock'" \
  2 \
  "both different-target requests to wait on the same source"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$blocker_pid" || fail "source lock owner failed"
blocker_pid=""

set +e
wait "$target_a_pid"
status_a="$?"
wait "$target_b_pid"
status_b="$?"
set -e
target_a_pid=""
target_b_pid=""
if [[ "$status_a" == "$status_b" ]]; then
  fail "expected exactly one winner and one conflict (a=$status_a b=$status_b)"
fi
grep -F "anon_reassignment_conflict" \
  "$qa_tmp_dir/target-a.out" "$qa_tmp_dir/target-b.out" >/dev/null \
  || fail "loser did not report anon_reassignment_conflict"

winner="$(
  db_value "
    select target_user_id::text
      from public.anon_data_reassignments
     where source_user_id = '$source_user'::uuid;
  "
)"
[[ "$winner" == "$target_a" || "$winner" == "$target_b" ]] \
  || fail "durable winner receipt is missing"

final_state="$(
  db_value "
    select count(*)::text
           || '|'
           || pg_catalog.bool_and(
             t.owner_id = '$winner'::uuid
             and t.is_anon = false
             and t.submitter_binding =
               public.bp_telemetry_submitter_binding(t.id, '$winner'::uuid)
           )::text
      from public.telemetry_sessions t
     where t.id = '$session_id'::uuid;
  "
)"
[[ "$final_state" == "1|true" ]] \
  || fail "winner did not receive the telemetry row with a rotated binding"

db_psql -q -c "
  select public.reassign_anon_data(
    '$source_user'::uuid,
    '$winner'::uuid
  );
" >/dev/null || fail "same-target retry was not idempotent"

echo "anonymous reassignment race QA passed: one winner, one conflict, exact binding rotation"
