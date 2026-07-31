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
  echo "score/report quota race QA requires disposable local Supabase" >&2
  exit 1
fi

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

db_value() {
  db_psql -Aqt -c "$1"
}

fail() {
  echo "score/report quota race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
      tail -n 40 "$output" >&2
    fi
  done
  exit 1
}

wait_for_sleep() {
  app_name="$1"
  description="$2"
  for _ in $(seq 1 120); do
    state="$(
      db_value "
        select coalesce(
          (
            select state || ':' || coalesce(wait_event, '')
              from pg_catalog.pg_stat_activity
             where application_name = '$app_name'
               and backend_type = 'client backend'
             limit 1
          ),
          ''
        );
      "
    )"
    if [[ "$state" == "active:PgSleep" ]]; then
      return 0
    fi
    sleep 0.05
  done
  fail "timed out waiting for $description ($state)"
}

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-score-report-quota-race.XXXXXX"
)"
owner_pid=""
user_a="$(db_value "select gen_random_uuid();")"
user_b="$(db_value "select gen_random_uuid();")"
doll_id="$(db_value "select gen_random_uuid();")"
score_submission="$(db_value "select gen_random_uuid();")"
score_other_submission="$(db_value "select gen_random_uuid();")"
score_failed_submission="$(db_value "select gen_random_uuid();")"
report_submission="$(db_value "select gen_random_uuid();")"
report_other_submission="$(db_value "select gen_random_uuid();")"
report_failed_submission="$(db_value "select gen_random_uuid();")"
missing_doll_id="$(db_value "select gen_random_uuid();")"
actor_a="$(printf 'a%.0s' {1..64})"
actor_b="$(printf 'b%.0s' {1..64})"

cleanup() {
  original_status=$?
  set +e
  cleanup_failed=0
  cleanup_remaining=""
  if [[ -n "$owner_pid" ]] && kill -0 "$owner_pid" >/dev/null 2>&1; then
    kill "$owner_pid" >/dev/null 2>&1
    wait "$owner_pid" >/dev/null 2>&1
  fi
  if [[ "$user_a" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$user_b" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q >"$qa_tmp_dir/cleanup.out" 2>&1 <<SQL
begin;
select pg_catalog.set_config(
  'boss_paegi.privacy_retention_delete',
  '008904:v1',
  true
);
delete from public.content_report_submission_receipts
 where submission_id in (
   '$report_submission'::uuid,
   '$report_other_submission'::uuid
 );
delete from public.content_reports where target_id = '$doll_id'::uuid;
delete from public.scores
 where submission_id in (
   '$score_submission'::uuid,
   '$score_other_submission'::uuid,
   '$score_failed_submission'::uuid
 );
delete from public.public_write_attempts
 where endpoint in ('score', 'report');
delete from public.public_write_quota_buckets
 where endpoint in ('score', 'report');
delete from public.dolls where id = '$doll_id'::uuid;
delete from public.member_accounts
 where user_id in ('$user_a'::uuid, '$user_b'::uuid);
delete from auth.users
 where id in ('$user_a'::uuid, '$user_b'::uuid);
commit;
SQL
    then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        select
          (
            select pg_catalog.count(*)
              from public.content_report_submission_receipts
             where submission_id in (
               '$report_submission'::uuid,
               '$report_other_submission'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.content_reports
             where target_id = '$doll_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.scores
             where submission_id in (
               '$score_submission'::uuid,
               '$score_other_submission'::uuid,
               '$score_failed_submission'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.public_write_attempts
             where endpoint in ('score', 'report')
          )
          + (
            select pg_catalog.count(*)
              from public.public_write_quota_buckets
             where endpoint in ('score', 'report')
          )
          + (
            select pg_catalog.count(*)
              from public.dolls
             where id = '$doll_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in ('$user_a'::uuid, '$user_b'::uuid)
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in ('$user_a'::uuid, '$user_b'::uuid)
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in ('$user_a'::uuid, '$user_b'::uuid)
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "score/report quota race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
    if [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
      tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
    fi
  fi
  case "$qa_tmp_dir" in
    "${TMPDIR:-/tmp}"/boss-paegi-score-report-quota-race.*)
      rm -rf -- "$qa_tmp_dir"
      ;;
  esac
  if (( cleanup_failed != 0 && original_status == 0 )); then
    exit 1
  fi
}
trap cleanup EXIT INT TERM

for id in \
  "$user_a" "$user_b" "$doll_id" "$score_submission" \
  "$score_other_submission" "$score_failed_submission" \
  "$report_submission" "$report_other_submission" \
  "$report_failed_submission" "$missing_doll_id"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid UUID"
done

catalog_ok="$(
  db_value "
    select (
      pg_catalog.to_regprocedure(
        'public.submit_score_with_review(uuid,uuid,integer,text,integer,integer,text,uuid,text,jsonb,jsonb,integer,text,text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.reserve_score_write_attempt(uuid,uuid,integer,text,integer,integer,text,uuid,jsonb,text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean,text)'
      ) is not null
      and pg_catalog.to_regprocedure(
        'public.reserve_report_write_attempt(uuid,uuid,text,text,text,text)'
      ) is not null
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "008900 public score/report quota migration is missing"

db_psql -q >/dev/null <<SQL
delete from public.public_write_quota_buckets
 where endpoint in ('score', 'report');
delete from public.public_write_attempts
 where endpoint in ('score', 'report');
insert into auth.users(id, email)
values
  ('$user_a'::uuid, 'quota-race-a-$user_a@test.local'),
  ('$user_b'::uuid, 'quota-race-b-$user_b@test.local');
insert into public.member_accounts(user_id, email)
values
  ('$user_a'::uuid, 'quota-race-a-$user_a@test.local'),
  ('$user_b'::uuid, 'quota-race-b-$user_b@test.local');
insert into public.dolls(id, owner_id, image_url)
values ('$doll_id'::uuid, '$user_a'::uuid, 'quota-race.png');
SQL

# Score: one transaction takes the final global slot and retains both the
# submission advisory lock and quota rows. A concurrent exact retry fails fast
# without consuming another unit, then succeeds quota-free after commit.
db_psql -q >/dev/null <<SQL
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values (
  'score',
  (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
  'global',
  499999
);
SQL
score_owner_app="bp_score_quota_owner_$$"
(
  db_psql -Aqt >"$qa_tmp_dir/score-owner.out" 2>&1 <<SQL
set application_name = '$score_owner_app';
begin;
select public.submit_score_with_review(
  '$user_a'::uuid,
  null,
  100,
  'fist',
  1000,
  1,
  'normal',
  null,
  'registered',
  '[]'::jsonb,
  pg_catalog.jsonb_build_object(
    'submissionId', '$score_submission'::uuid,
    'submissionFingerprint', pg_catalog.repeat('1', 64)
  ),
  0,
  'quota-race',
  '$actor_a'
);
select pg_catalog.pg_sleep(1);
commit;
SQL
) &
owner_pid="$!"
wait_for_sleep "$score_owner_app" "score final-slot owner"

set +e
db_psql -Aqt >"$qa_tmp_dir/score-contender.out" 2>&1 <<SQL
select public.submit_score_with_review(
  '$user_a'::uuid,
  null,
  100,
  'fist',
  1000,
  1,
  'normal',
  null,
  'registered',
  '[]'::jsonb,
  pg_catalog.jsonb_build_object(
    'submissionId', '$score_submission'::uuid,
    'submissionFingerprint', pg_catalog.repeat('1', 64)
  ),
  0,
  'quota-race',
  '$actor_a'
);
SQL
score_contender_status=$?
set -e
[[ "$score_contender_status" != "0" ]] \
  || fail "concurrent score retry unexpectedly committed"
grep -q "score_write_quota_busy" "$qa_tmp_dir/score-contender.out" \
  || fail "concurrent score retry did not fail fast as quota_busy"
wait "$owner_pid" || fail "score final-slot owner failed"
owner_pid=""

score_state="$(
  db_value "
    select
      (select pg_catalog.count(*) from public.scores
        where submission_id = '$score_submission'::uuid)::text
      || '|' ||
      (select request_count::text
         from public.public_write_quota_buckets
        where endpoint = 'score' and actor_key = 'global')
      || '|' ||
      (select pg_catalog.sum(request_count)::text
         from public.public_write_quota_buckets
        where endpoint = 'score');
  "
)"
[[ "$score_state" == "1|500000|500002" ]] \
  || fail "score concurrent final slot was not exact ($score_state)"

db_psql -Aqt >"$qa_tmp_dir/score-replay.out" <<SQL
select public.submit_score_with_review(
  '$user_a'::uuid,
  null,
  100,
  'fist',
  1000,
  1,
  'normal',
  null,
  'registered',
  '[]'::jsonb,
  pg_catalog.jsonb_build_object(
    'submissionId', '$score_submission'::uuid,
    'submissionFingerprint', pg_catalog.repeat('1', 64)
  ),
  0,
  'quota-race',
  '$actor_a'
);
SQL
grep -Eq '"duplicate"[[:space:]]*:[[:space:]]*true' \
  "$qa_tmp_dir/score-replay.out" \
  || fail "score exact replay did not recover after contention"
[[ "$(db_value "select sum(request_count) from public.public_write_quota_buckets where endpoint = 'score';")" == "5002" ]] \
  || fail "score exact replay consumed quota"

set +e
db_psql -Aqt >"$qa_tmp_dir/score-new-over-cap.out" 2>&1 <<SQL
select public.submit_score_with_review(
  '$user_b'::uuid,
  null,
  101,
  'fist',
  1000,
  1,
  'normal',
  null,
  'registered',
  '[]'::jsonb,
  pg_catalog.jsonb_build_object(
    'submissionId', '$score_other_submission'::uuid,
    'submissionFingerprint', pg_catalog.repeat('2', 64)
  ),
  0,
  'quota-race',
  '$actor_b'
);
SQL
score_new_status=$?
set -e
[[ "$score_new_status" != "0" ]] \
  && grep -q "score_write_global_request_quota" \
    "$qa_tmp_dir/score-new-over-cap.out" \
  || fail "new score after the final slot was not globally rejected"
[[ "$(db_value "select count(*) from public.scores where submission_id = '$score_other_submission'::uuid;")" == "0" ]] \
  || fail "globally rejected score reached durable core state"

# Report: the same final-slot/concurrent exact-retry contract.
db_psql -q >/dev/null <<SQL
delete from public.public_write_quota_buckets where endpoint = 'report';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values (
  'report',
  (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date,
  'global',
  49999
);
SQL
report_owner_app="bp_report_quota_owner_$$"
(
  db_psql -Aqt >"$qa_tmp_dir/report-owner.out" 2>&1 <<SQL
set application_name = '$report_owner_app';
begin;
select public.submit_content_report(
  '$report_submission'::uuid,
  '$doll_id'::uuid,
  'portrait',
  'quota race',
  null,
  null,
  true,
  '$actor_a'
);
select pg_catalog.pg_sleep(1);
commit;
SQL
) &
owner_pid="$!"
wait_for_sleep "$report_owner_app" "report final-slot owner"

set +e
db_psql -Aqt >"$qa_tmp_dir/report-contender.out" 2>&1 <<SQL
select public.submit_content_report(
  '$report_submission'::uuid,
  '$doll_id'::uuid,
  'portrait',
  'quota race',
  null,
  null,
  false,
  '$actor_a'
);
SQL
report_contender_status=$?
set -e
[[ "$report_contender_status" != "0" ]] \
  || fail "concurrent report retry unexpectedly committed"
grep -q "report_write_quota_busy" "$qa_tmp_dir/report-contender.out" \
  || fail "concurrent report retry did not fail fast as quota_busy"
wait "$owner_pid" || fail "report final-slot owner failed"
owner_pid=""

report_state="$(
  db_value "
    select
      (select pg_catalog.count(*)
         from public.content_report_submission_receipts
        where submission_id = '$report_submission'::uuid)::text
      || '|' ||
      (select request_count::text
         from public.public_write_quota_buckets
        where endpoint = 'report' and actor_key = 'global')
      || '|' ||
      (select pg_catalog.sum(request_count)::text
         from public.public_write_quota_buckets
        where endpoint = 'report');
  "
)"
[[ "$report_state" == "1|50000|50001" ]] \
  || fail "report concurrent final slot was not exact ($report_state)"

db_psql -Aqt >"$qa_tmp_dir/report-replay.out" <<SQL
select public.submit_content_report(
  '$report_submission'::uuid,
  '$doll_id'::uuid,
  'portrait',
  'quota race',
  null,
  null,
  false,
  '$actor_a'
);
SQL
grep -Eq '"duplicate"[[:space:]]*:[[:space:]]*true' \
  "$qa_tmp_dir/report-replay.out" \
  || fail "report exact replay did not recover after contention"
[[ "$(db_value "select sum(request_count) from public.public_write_quota_buckets where endpoint = 'report';")" == "501" ]] \
  || fail "report exact replay consumed quota"

set +e
db_psql -Aqt >"$qa_tmp_dir/report-new-over-cap.out" 2>&1 <<SQL
select public.submit_content_report(
  '$report_other_submission'::uuid,
  '$doll_id'::uuid,
  'portrait',
  'new over cap',
  null,
  null,
  true,
  '$actor_b'
);
SQL
report_new_status=$?
set -e
[[ "$report_new_status" != "0" ]] \
  && grep -q "rate_limited" "$qa_tmp_dir/report-new-over-cap.out" \
  || fail "new report after the final slot was not globally rejected"
[[ "$(db_value "select count(*) from public.content_report_submission_receipts where submission_id = '$report_other_submission'::uuid;")" == "0" ]] \
  || fail "globally rejected report reached durable core state"

# Failed score: mimic the two-RPC app protocol. The reservation commits before
# core validation, one contender fails fast while the terminal failure commits,
# and every later exact retry receives the cached failure quota-free.
db_psql -q >/dev/null <<SQL
delete from public.public_write_quota_buckets where endpoint = 'score';
delete from public.public_write_attempts where endpoint = 'score';
SQL
db_psql -Aqt >"$qa_tmp_dir/score-failed-reserve.out" <<SQL
select public.reserve_score_write_attempt(
  '$user_a'::uuid,
  null,
  -1,
  'fist',
  1000,
  1,
  'normal',
  null,
  pg_catalog.jsonb_build_object(
    'submissionId', '$score_failed_submission'::uuid,
    'submissionFingerprint', pg_catalog.repeat('3', 64)
  ),
  '$actor_a'
);
SQL
grep -Eq '"outcome"[[:space:]]*:[[:space:]]*"reserved"' \
  "$qa_tmp_dir/score-failed-reserve.out" \
  || fail "failed score pre-core reservation did not commit"

score_failed_owner_app="bp_score_failed_owner_$$"
(
  db_psql -Aqt >"$qa_tmp_dir/score-failed-owner.out" 2>&1 <<SQL
set application_name = '$score_failed_owner_app';
begin;
select public.submit_score_with_review(
  '$user_a'::uuid,
  null,
  -1,
  'fist',
  1000,
  1,
  'normal',
  null,
  'registered',
  '[]'::jsonb,
  pg_catalog.jsonb_build_object(
    'submissionId', '$score_failed_submission'::uuid,
    'submissionFingerprint', pg_catalog.repeat('3', 64)
  ),
  0,
  'quota-race',
  '$actor_a'
);
select pg_catalog.pg_sleep(1);
commit;
SQL
) &
owner_pid="$!"
wait_for_sleep "$score_failed_owner_app" "failed score owner"

set +e
db_psql -Aqt >"$qa_tmp_dir/score-failed-contender.out" 2>&1 <<SQL
select public.submit_score_with_review(
  '$user_a'::uuid,
  null,
  -1,
  'fist',
  1000,
  1,
  'normal',
  null,
  'registered',
  '[]'::jsonb,
  pg_catalog.jsonb_build_object(
    'submissionId', '$score_failed_submission'::uuid,
    'submissionFingerprint', pg_catalog.repeat('3', 64)
  ),
  0,
  'quota-race',
  '$actor_a'
);
SQL
score_failed_contender_status=$?
set -e
[[ "$score_failed_contender_status" != "0" ]] \
  && grep -q "score_write_quota_busy" \
    "$qa_tmp_dir/score-failed-contender.out" \
  || fail "concurrent failed score retry did not fail fast as quota_busy"
wait "$owner_pid" || fail "failed score owner transaction failed"
owner_pid=""
grep -Eq '"writeAttemptError"[[:space:]]*:[[:space:]]*"invalid_score_protocol"' \
  "$qa_tmp_dir/score-failed-owner.out" \
  || fail "invalid score core failure was not durably returned"

db_psql -Aqt >"$qa_tmp_dir/score-failed-replay.out" <<SQL
select public.submit_score_with_review(
  '$user_a'::uuid,
  null,
  -1,
  'fist',
  1000,
  1,
  'normal',
  null,
  'registered',
  '[]'::jsonb,
  pg_catalog.jsonb_build_object(
    'submissionId', '$score_failed_submission'::uuid,
    'submissionFingerprint', pg_catalog.repeat('3', 64)
  ),
  0,
  'quota-race',
  '$actor_a'
);
SQL
grep -Eq '"writeAttemptError"[[:space:]]*:[[:space:]]*"invalid_score_protocol"' \
  "$qa_tmp_dir/score-failed-replay.out" \
  || fail "failed score exact retry did not return cached failure"
score_failed_state="$(
  db_value "
    select
      (select pg_catalog.sum(request_count)
         from public.public_write_quota_buckets
        where endpoint = 'score')::text
      || '|' ||
      (select pg_catalog.count(*)::text
         from public.public_write_attempts
        where endpoint = 'score'
          and state = 'failed'
          and error_code = 'invalid_score_protocol');
  "
)"
[[ "$score_failed_state" == "3|1" ]] \
  || fail "failed score quota/attempt state was not exact ($score_failed_state)"

# Failed report: the same two-RPC and terminal-failure concurrency contract.
db_psql -q >/dev/null <<SQL
delete from public.public_write_quota_buckets where endpoint = 'report';
delete from public.public_write_attempts where endpoint = 'report';
SQL
db_psql -Aqt >"$qa_tmp_dir/report-failed-reserve.out" <<SQL
select public.reserve_report_write_attempt(
  '$report_failed_submission'::uuid,
  '$missing_doll_id'::uuid,
  'other',
  'missing target race',
  null,
  '$actor_a'
);
SQL
grep -Eq '"outcome"[[:space:]]*:[[:space:]]*"reserved"' \
  "$qa_tmp_dir/report-failed-reserve.out" \
  || fail "failed report pre-core reservation did not commit"

report_failed_owner_app="bp_report_failed_owner_$$"
(
  db_psql -Aqt >"$qa_tmp_dir/report-failed-owner.out" 2>&1 <<SQL
set application_name = '$report_failed_owner_app';
begin;
select public.submit_content_report(
  '$report_failed_submission'::uuid,
  '$missing_doll_id'::uuid,
  'other',
  'missing target race',
  null,
  null,
  true,
  '$actor_a'
);
select pg_catalog.pg_sleep(1);
commit;
SQL
) &
owner_pid="$!"
wait_for_sleep "$report_failed_owner_app" "failed report owner"

set +e
db_psql -Aqt >"$qa_tmp_dir/report-failed-contender.out" 2>&1 <<SQL
select public.submit_content_report(
  '$report_failed_submission'::uuid,
  '$missing_doll_id'::uuid,
  'other',
  'missing target race',
  null,
  null,
  true,
  '$actor_a'
);
SQL
report_failed_contender_status=$?
set -e
[[ "$report_failed_contender_status" != "0" ]] \
  && grep -q "report_write_quota_busy" \
    "$qa_tmp_dir/report-failed-contender.out" \
  || fail "concurrent failed report retry did not fail fast as quota_busy"
wait "$owner_pid" || fail "failed report owner transaction failed"
owner_pid=""
grep -Eq '"writeAttemptError"[[:space:]]*:[[:space:]]*"target_not_found"' \
  "$qa_tmp_dir/report-failed-owner.out" \
  || fail "missing report target was not durably returned"

db_psql -Aqt >"$qa_tmp_dir/report-failed-replay.out" <<SQL
select public.submit_content_report(
  '$report_failed_submission'::uuid,
  '$missing_doll_id'::uuid,
  'other',
  'missing target race',
  null,
  null,
  true,
  '$actor_a'
);
SQL
grep -Eq '"writeAttemptError"[[:space:]]*:[[:space:]]*"target_not_found"' \
  "$qa_tmp_dir/report-failed-replay.out" \
  || fail "failed report exact retry did not return cached failure"
report_failed_state="$(
  db_value "
    select
      (select pg_catalog.sum(request_count)
         from public.public_write_quota_buckets
        where endpoint = 'report')::text
      || '|' ||
      (select pg_catalog.count(*)::text
         from public.public_write_attempts
        where endpoint = 'report'
          and state = 'failed'
          and error_code = 'target_not_found');
  "
)"
[[ "$report_failed_state" == "2|1" ]] \
  || fail "failed report quota/attempt state was not exact ($report_failed_state)"

echo "score/report quota race QA passed: final slot, contention, exact success/failure replay, over-cap"
