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

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-reassign-write-race.XXXXXX"
)"
owner_pid=""
waiter_a_pid=""
waiter_b_pid=""
source_a=""
target_a=""
source_b=""
target_b=""
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
  for pid in "$owner_pid" "$waiter_a_pid" "$waiter_b_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$source_a" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$target_a" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$source_b" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$target_b" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      delete from public.scores
       where owner_id in (
         '$source_a'::uuid, '$target_a'::uuid,
         '$source_b'::uuid, '$target_b'::uuid
       );
      delete from public.telemetry_sessions
       where owner_id in (
         '$source_a'::uuid, '$target_a'::uuid,
         '$source_b'::uuid, '$target_b'::uuid
       )
          or submitter_binding in (
            public.bp_telemetry_submitter_binding(id, '$source_a'::uuid),
            public.bp_telemetry_submitter_binding(id, '$target_a'::uuid),
            public.bp_telemetry_submitter_binding(id, '$source_b'::uuid),
            public.bp_telemetry_submitter_binding(id, '$target_b'::uuid)
          );
      delete from public.oauth_anon_auth_cleanup_jobs
       where legacy_source_user_id in (
         '$source_a'::uuid,
         '$source_b'::uuid
       );
      set local session_replication_role = replica;
      delete from public.anon_data_reassignments
       where source_user_id in ('$source_a'::uuid, '$source_b'::uuid);
      set local session_replication_role = origin;
      delete from public.member_accounts
       where user_id in ('$target_a'::uuid, '$target_b'::uuid);
      delete from auth.users
       where id in (
         '$source_a'::uuid, '$target_a'::uuid,
         '$source_b'::uuid, '$target_b'::uuid
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
              from public.scores
             where owner_id in (
               '$source_a'::uuid, '$target_a'::uuid,
               '$source_b'::uuid, '$target_b'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.telemetry_sessions
             where owner_id in (
               '$source_a'::uuid, '$target_a'::uuid,
               '$source_b'::uuid, '$target_b'::uuid
             )
                or submitter_binding in (
                  public.bp_telemetry_submitter_binding(
                    id,
                    '$source_a'::uuid
                  ),
                  public.bp_telemetry_submitter_binding(
                    id,
                    '$target_a'::uuid
                  ),
                  public.bp_telemetry_submitter_binding(
                    id,
                    '$source_b'::uuid
                  ),
                  public.bp_telemetry_submitter_binding(
                    id,
                    '$target_b'::uuid
                  )
                )
          )
          + (
            select pg_catalog.count(*)
              from public.oauth_anon_auth_cleanup_jobs
             where legacy_source_user_id in (
               '$source_a'::uuid,
               '$source_b'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.anon_data_reassignments
             where source_user_id in (
               '$source_a'::uuid,
               '$source_b'::uuid
             )
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
               '$source_a'::uuid, '$target_a'::uuid,
               '$source_b'::uuid, '$target_b'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in (
               '$source_a'::uuid, '$target_a'::uuid,
               '$source_b'::uuid, '$target_b'::uuid
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
         where endpoint in ('telemetry', 'score');
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
         where endpoint in ('telemetry', 'score');
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
         where q.endpoint in ('telemetry', 'score');
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$quota_current_hex" != "$quota_backup_hex" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "anonymous reassignment/write race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
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
  echo "anonymous reassignment/write race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
      tail -n 30 "$output" >&2
    fi
  done
  exit 1
}

wait_for_activity() {
  app_names="$1"
  expected="$2"
  predicate="$3"
  description="$4"
  for _ in $(seq 1 2400); do
    count="$(
      db_value "
        select count(*)
          from pg_catalog.pg_stat_activity
         where application_name = any(string_to_array('$app_names', ','))
           and backend_type = 'client backend'
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
     where q.endpoint in ('telemetry', 'score');
  "
)"
[[ -z "$quota_backup_hex" || "$quota_backup_hex" =~ ^[0-9a-f]+$ ]] \
  || fail "could not safely back up telemetry/score quota rows"
quota_fixture_touched="true"

source_a="$(db_value "select gen_random_uuid();")"
target_a="$(db_value "select gen_random_uuid();")"
source_b="$(db_value "select gen_random_uuid();")"
target_b="$(db_value "select gen_random_uuid();")"
session_a="$(db_value "select gen_random_uuid();")"
session_b="$(db_value "select gen_random_uuid();")"
submission_a="$(db_value "select gen_random_uuid();")"
submission_b="$(db_value "select gen_random_uuid();")"
for id in \
  "$source_a" "$target_a" "$source_b" "$target_b" \
  "$session_a" "$session_b" "$submission_a" "$submission_b"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid UUID"
done

db_psql -q -c "
  insert into auth.users(
    id,
    email,
    is_anonymous,
    created_at
  ) values
    (
      '$source_a'::uuid,
      'reassign-write-source-a-$source_a@test.local',
      true,
      clock_timestamp()
    ),
    (
      '$target_a'::uuid,
      'reassign-write-target-a-$target_a@test.local',
      false,
      clock_timestamp()
    ),
    (
      '$source_b'::uuid,
      'reassign-write-source-b-$source_b@test.local',
      true,
      clock_timestamp()
    ),
    (
      '$target_b'::uuid,
      'reassign-write-target-b-$target_b@test.local',
      false,
      clock_timestamp()
    );
" >/dev/null

# A) Source telemetry+score commits first. Reassignment waits on the shared
# member lock, then moves both rows and rotates the binding in one transaction.
owner_app="bp_qa_source_write_first_$$"
waiter_app="bp_qa_reassign_after_write_$$"
mkfifo "$qa_tmp_dir/write-first.fifo"
db_psql -qAt <"$qa_tmp_dir/write-first.fifo" \
  >"$qa_tmp_dir/write-first.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/write-first.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.ingest_telemetry_delta(
    '$session_a'::uuid,
    '$source_a'::uuid,
    false,
    '{\"deviceClass\":\"other\",\"summary\":{\"seqHigh\":1},\"events\":[]}'::jsonb
  );
  select public.submit_score_with_review(
    '$source_a'::uuid,
    null,
    50,
    'fist',
    1000,
    1,
    'normal',
    '$session_a'::uuid,
    'registered',
    '[]'::jsonb,
    jsonb_build_object(
      'submissionId', '$submission_a'::uuid,
      'submissionFingerprint', repeat('a', 64)
    ),
    0,
    '2026-07-anti-abuse-v6'
  );
" >&3
wait_for_activity \
  "$owner_app" \
  1 \
  "state = 'idle in transaction' and xact_start is not null" \
  "source write transaction"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.reassign_anon_data(
    '$source_a'::uuid,
    '$target_a'::uuid
  );
" >"$qa_tmp_dir/reassign-after-write.out" 2>&1 &
waiter_a_pid="$!"
wait_for_activity \
  "$waiter_app" \
  1 \
  "state = 'active' and wait_event_type = 'Lock'" \
  "reassignment behind source writes"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "source write transaction failed"
owner_pid=""
wait "$waiter_a_pid" || fail "write-first reassignment failed"
waiter_a_pid=""

write_first_state="$(
  db_value "
    select count(*)::text
           || '|'
           || count(*) filter (
             where s.owner_id = '$target_a'::uuid
           )::text
           || '|'
           || count(*) filter (
             where t.owner_id = '$target_a'::uuid
               and t.is_anon = false
               and t.submitter_binding =
                 public.bp_telemetry_submitter_binding(
                   t.id,
                   '$target_a'::uuid
                 )
           )::text
      from public.scores s
      join public.telemetry_sessions t
        on t.id = s.telemetry_session_id
     where s.submission_id = '$submission_a'::uuid;
  "
)"
[[ "$write_first_state" == "1|1|1" ]] \
  || fail "write-first rows did not move atomically to the target"

# B) Reassignment commits first. Both a stale score and a stale telemetry write
# wait on its member lock, observe the durable receipt, and create no orphan.
owner_app="bp_qa_reassign_first_$$"
score_app="bp_qa_stale_score_$$"
telemetry_app="bp_qa_stale_telemetry_$$"
mkfifo "$qa_tmp_dir/reassign-first.fifo"
db_psql -qAt <"$qa_tmp_dir/reassign-first.fifo" \
  >"$qa_tmp_dir/reassign-first.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/reassign-first.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.reassign_anon_data(
    '$source_b'::uuid,
    '$target_b'::uuid
  );
" >&3
wait_for_activity \
  "$owner_app" \
  1 \
  "state = 'idle in transaction' and xact_start is not null" \
  "reassignment-first transaction"

db_psql -qAt -c "
  set application_name = '$score_app';
  set statement_timeout = '15s';
  select public.submit_score_with_review(
    '$source_b'::uuid,
    null,
    50,
    'fist',
    1000,
    1,
    'normal',
    null,
    'registered',
    '[]'::jsonb,
    jsonb_build_object(
      'submissionId', '$submission_b'::uuid,
      'submissionFingerprint', repeat('b', 64)
    ),
    0,
    '2026-07-anti-abuse-v6'
  );
" >"$qa_tmp_dir/stale-score.out" 2>&1 &
waiter_a_pid="$!"
db_psql -qAt -c "
  set application_name = '$telemetry_app';
  set statement_timeout = '15s';
  select public.ingest_telemetry_delta(
    '$session_b'::uuid,
    '$source_b'::uuid,
    false,
    '{\"deviceClass\":\"other\",\"summary\":{\"seqHigh\":1},\"events\":[]}'::jsonb
  );
" >"$qa_tmp_dir/stale-telemetry.out" 2>&1 &
waiter_b_pid="$!"
wait_for_activity \
  "$score_app,$telemetry_app" \
  2 \
  "state = 'active' and wait_event_type = 'Lock'" \
  "both stale source writes behind reassignment"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "reassignment-first transaction failed"
owner_pid=""

set +e
wait "$waiter_a_pid"
score_status="$?"
wait "$waiter_b_pid"
telemetry_status="$?"
set -e
waiter_a_pid=""
waiter_b_pid=""
[[ "$score_status" != "0" ]] \
  || fail "stale score unexpectedly succeeded"
[[ "$telemetry_status" == "0" ]] \
  || fail "stale telemetry RPC did not return its fenced acknowledgement"
grep -F "account_migrated" "$qa_tmp_dir/stale-score.out" >/dev/null \
  || fail "stale score did not report account_migrated"
grep -F '"reason": "account_migrated"' \
  "$qa_tmp_dir/stale-telemetry.out" >/dev/null \
  || fail "stale telemetry did not report account_migrated"

late_state="$(
  db_value "
    select (
      not exists (
        select 1 from public.scores
         where owner_id = '$source_b'::uuid
            or submission_id = '$submission_b'::uuid
      )
      and not exists (
        select 1 from public.telemetry_sessions
         where id = '$session_b'::uuid
      )
      and exists (
        select 1 from public.anon_data_reassignments
         where source_user_id = '$source_b'::uuid
           and target_user_id = '$target_b'::uuid
      )
    )::text;
  "
)"
[[ "$late_state" == "true" ]] \
  || fail "migration-first writes left an orphan or lost the receipt"

echo "anonymous reassignment/write race QA passed: both commit orders are fenced"
