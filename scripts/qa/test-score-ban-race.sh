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

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-score-ban-race.XXXXXX")"
owner_pid=""
waiter_pid=""
admin_id=""
submit_first_user=""
ban_first_user=""
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
  for pid in "$owner_pid" "$waiter_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$admin_id" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$submit_first_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$ban_first_user" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      delete from public.integrity_actions_ledger
       where admin_user_id = '$admin_id'::uuid
          or target_id in (
            '$submit_first_user'::uuid,
            '$ban_first_user'::uuid
          );
      delete from public.scores
       where owner_id in (
         '$submit_first_user'::uuid,
         '$ban_first_user'::uuid
       );
      delete from public.member_accounts
       where user_id in (
         '$admin_id'::uuid,
         '$submit_first_user'::uuid,
         '$ban_first_user'::uuid
       );
      delete from auth.users
       where id in (
         '$admin_id'::uuid,
         '$submit_first_user'::uuid,
         '$ban_first_user'::uuid
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
              from public.integrity_actions_ledger
             where admin_user_id = '$admin_id'::uuid
                or target_id in (
                  '$submit_first_user'::uuid,
                  '$ban_first_user'::uuid
                )
          )
          + (
            select pg_catalog.count(*)
              from public.scores
             where owner_id in (
               '$submit_first_user'::uuid,
               '$ban_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in (
               '$admin_id'::uuid,
               '$submit_first_user'::uuid,
               '$ban_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in (
               '$admin_id'::uuid,
               '$submit_first_user'::uuid,
               '$ban_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in (
               '$admin_id'::uuid,
               '$submit_first_user'::uuid,
               '$ban_first_user'::uuid
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
         where endpoint = 'score';
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
         where endpoint = 'score';
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
         where q.endpoint = 'score';
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$quota_current_hex" != "$quota_backup_hex" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "score/ban race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
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
  echo "score/ban race QA failed: $*" >&2
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
     where q.endpoint = 'score';
  "
)"
[[ -z "$quota_backup_hex" || "$quota_backup_hex" =~ ^[0-9a-f]+$ ]] \
  || fail "could not safely back up score quota rows"
quota_fixture_touched="true"

admin_id="$(db_value "select gen_random_uuid();")"
submit_first_user="$(db_value "select gen_random_uuid();")"
ban_first_user="$(db_value "select gen_random_uuid();")"
submit_first_key="$(db_value "select gen_random_uuid();")"
ban_first_key="$(db_value "select gen_random_uuid();")"
for id in \
  "$admin_id" "$submit_first_user" "$ban_first_user" \
  "$submit_first_key" "$ban_first_key"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid UUID"
done

db_psql -q -c "
  insert into auth.users(id, email) values
    ('$admin_id'::uuid, 'score-ban-admin-$admin_id@test.local'),
    (
      '$submit_first_user'::uuid,
      'score-submit-first-$submit_first_user@test.local'
    ),
    (
      '$ban_first_user'::uuid,
      'score-ban-first-$ban_first_user@test.local'
    );
  insert into public.member_accounts(user_id, is_admin) values
    ('$admin_id'::uuid, true),
    ('$submit_first_user'::uuid, false),
    ('$ban_first_user'::uuid, false);
" >/dev/null

# A) Submit+report commits first. Ban waits on the shared member lock, then
# atomically voids the committed score and removes the just-earned badge.
owner_app="bp_qa_score_submit_first_$$"
waiter_app="bp_qa_score_ban_waiter_$$"
mkfifo "$qa_tmp_dir/submit-first.fifo"
db_psql -qAt <"$qa_tmp_dir/submit-first.fifo" \
  >"$qa_tmp_dir/submit-first.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/submit-first.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select (
    public.submit_score_with_review(
      '$submit_first_user'::uuid,
      null,
      100,
      'fist',
      1000,
      1,
      'normal',
      null,
      'registered',
      '[]'::jsonb,
      jsonb_build_object(
        'submissionId',
        '$submit_first_key'::uuid,
        'submissionFingerprint',
        repeat('a', 64)
      ),
      0,
      '2026-07-anti-abuse-v6'
    )->>'scoreId'
  ) as score_id
  \\gset
  select public.commit_score_report(
    :'score_id'::uuid,
    '$submit_first_user'::uuid,
    '{\"version\":2}'::jsonb,
    'steady',
    array['score_1'],
    50,
    array['score_1']
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "submit-first transaction"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.admin_ban_member(
    '$admin_id'::uuid,
    '$submit_first_user'::uuid,
    'score/ban concurrency QA'
  );
" >"$qa_tmp_dir/ban-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "ban to wait behind submit/report"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "submit-first transaction failed"
owner_pid=""
wait "$waiter_pid" || fail "submit-first ban failed"
waiter_pid=""

submit_first_state="$(
  db_value "
    select s.review_status
           || '|'
           || count(ub.*)::text
           || '|'
           || count(f.*) filter (where f.status = 'voided')::text
      from public.scores s
      left join public.user_badges ub on ub.owner_id = s.owner_id
      left join public.score_flags f on f.score_id = s.id
     where s.owner_id = '$submit_first_user'::uuid
     group by s.review_status;
  "
)"
[[ "$submit_first_state" == "voided|0|1" ]] \
  || fail "submit-first final state is not voided + zero badges + flag"

# B) Ban commits first. A stale registered submission waits, re-reads the
# member under the same lock, and can only commit as voided with ban evidence.
owner_app="bp_qa_score_ban_first_$$"
waiter_app="bp_qa_score_submit_waiter_$$"
mkfifo "$qa_tmp_dir/ban-first.fifo"
db_psql -qAt <"$qa_tmp_dir/ban-first.fifo" \
  >"$qa_tmp_dir/ban-first.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/ban-first.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_ban_member(
    '$admin_id'::uuid,
    '$ban_first_user'::uuid,
    'score/ban concurrency QA'
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "ban-first transaction"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.submit_score_with_review(
    '$ban_first_user'::uuid,
    null,
    100,
    'fist',
    1000,
    1,
    'normal',
    null,
    'registered',
    '[]'::jsonb,
    jsonb_build_object(
      'submissionId',
      '$ban_first_key'::uuid,
      'submissionFingerprint',
      repeat('b', 64)
    ),
    0,
    '2026-07-anti-abuse-v6'
  );
" >"$qa_tmp_dir/submit-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "submit to wait behind ban"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "ban-first transaction failed"
owner_pid=""
wait "$waiter_pid" || fail "ban-first submit failed"
waiter_pid=""
grep -Eq '"reviewStatus"[[:space:]]*:[[:space:]]*"voided"' \
  "$qa_tmp_dir/submit-waiter.out" \
  || fail "stale submit was not forced to voided"

ban_first_state="$(
  db_value "
    select s.review_status
           || '|'
           || f.status
           || '|'
           || (
             select count(*)::text
               from public.user_badges ub
              where ub.owner_id = s.owner_id
           )
      from public.scores s
      join public.score_flags f on f.score_id = s.id
     where s.owner_id = '$ban_first_user'::uuid;
  "
)"
[[ "$ban_first_state" == "voided|voided|0" ]] \
  || fail "ban-first final state is not a voided score/flag with zero badges"

echo "score/ban race QA passed: both commit orders converge to voided + zero badges"
