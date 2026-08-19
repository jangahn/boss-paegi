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

db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
if [[ ! "$db_container" =~ ^supabase_db_[A-Za-z0-9._-]+$ ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-report-race.XXXXXX"
)"
owner_pid=""
waiter_pid=""
fixture_user=""
admin_user=""
doll_same_submission=""
doll_same_target=""
doll_report_first=""
doll_takedown_first=""
same_submission_id=""
report_quota_backup_hex=""
report_quota_fixture_touched="false"

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
  if [[ "$fixture_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$admin_user" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      delete from public.moderation_actions_ledger
       where admin_user_id = '$admin_user'::uuid
          or target_id in (
            '$doll_same_submission'::uuid,
            '$doll_same_target'::uuid,
            '$doll_report_first'::uuid,
            '$doll_takedown_first'::uuid
          );
      delete from public.content_report_submission_receipts
       where target_id in (
         '$doll_same_submission'::uuid,
         '$doll_same_target'::uuid,
         '$doll_report_first'::uuid,
         '$doll_takedown_first'::uuid
       );
      delete from public.content_reports
       where target_id in (
         '$doll_same_submission'::uuid,
         '$doll_same_target'::uuid,
         '$doll_report_first'::uuid,
         '$doll_takedown_first'::uuid
       );
      delete from public.dolls
       where id in (
         '$doll_same_submission'::uuid,
         '$doll_same_target'::uuid,
         '$doll_report_first'::uuid,
         '$doll_takedown_first'::uuid
       );
      delete from public.member_accounts
       where user_id in ('$fixture_user'::uuid, '$admin_user'::uuid);
      delete from auth.users
       where id in ('$fixture_user'::uuid, '$admin_user'::uuid);
      commit;
    " >"$qa_tmp_dir/cleanup.out" 2>&1; then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        select
          (
            select pg_catalog.count(*)
              from public.content_report_submission_receipts
             where target_id in (
               '$doll_same_submission'::uuid,
               '$doll_same_target'::uuid,
               '$doll_report_first'::uuid,
               '$doll_takedown_first'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.content_reports
             where target_id in (
               '$doll_same_submission'::uuid,
               '$doll_same_target'::uuid,
               '$doll_report_first'::uuid,
               '$doll_takedown_first'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.moderation_actions_ledger
             where admin_user_id = '$admin_user'::uuid
                or target_id in (
                  '$doll_same_submission'::uuid,
                  '$doll_same_target'::uuid,
                  '$doll_report_first'::uuid,
                  '$doll_takedown_first'::uuid
                )
          )
          + (
            select pg_catalog.count(*)
              from public.dolls
             where id in (
               '$doll_same_submission'::uuid,
               '$doll_same_target'::uuid,
               '$doll_report_first'::uuid,
               '$doll_takedown_first'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in ('$fixture_user'::uuid, '$admin_user'::uuid)
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in ('$fixture_user'::uuid, '$admin_user'::uuid)
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in ('$fixture_user'::uuid, '$admin_user'::uuid)
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if [[ "$report_quota_fixture_touched" == "true" ]]; then
    if [[ -n "$report_quota_backup_hex" ]] \
      && [[ "$report_quota_backup_hex" =~ ^[0-9a-f]+$ ]]; then
      if ! db_psql -q -c "
        delete from public.public_write_quota_buckets
         where endpoint = 'report'
           and actor_key = 'global';
        insert into public.public_write_quota_buckets
        select restored.*
          from pg_catalog.json_array_elements(
            pg_catalog.convert_from(
              pg_catalog.decode('$report_quota_backup_hex', 'hex'),
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
    elif [[ -z "$report_quota_backup_hex" ]]; then
      if ! db_psql -q -c "
        delete from public.public_write_quota_buckets
         where endpoint = 'report'
           and actor_key = 'global';
      " >>"$qa_tmp_dir/cleanup.out" 2>&1; then
        cleanup_failed=1
      fi
    else
      cleanup_failed=1
    fi
    if ! report_quota_current_hex="$(
      db_value "
        select pg_catalog.encode(
                 pg_catalog.convert_to(
                   pg_catalog.json_agg(
                     pg_catalog.row_to_json(s)
                     order by s.day_kst
                   )::text,
                   'UTF8'
                 ),
                 'hex'
               )
          from public.public_write_quota_buckets s
         where s.endpoint = 'report'
           and s.actor_key = 'global';
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$report_quota_current_hex" != "$report_quota_backup_hex" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "content-report race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
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
  echo "content-report race QA failed: $*" >&2
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

catalog_ok="$(
  db_value "
    select (
      to_regprocedure(
        'public.submit_content_report(uuid,uuid,text,text,uuid,text,boolean)'
      ) is not null
      and not has_table_privilege(
        'service_role',
        'public.content_reports',
        'INSERT'
      )
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "0080 is not applied; run npm run qa:db:apply first"

report_quota_backup_hex="$(
  db_value "
    select pg_catalog.encode(
             pg_catalog.convert_to(
               pg_catalog.json_agg(
                 pg_catalog.row_to_json(s)
                 order by s.day_kst
               )::text,
               'UTF8'
             ),
             'hex'
           )
      from public.public_write_quota_buckets s
     where s.endpoint = 'report'
       and s.actor_key = 'global';
  "
)"
[[ -z "$report_quota_backup_hex" \
   || "$report_quota_backup_hex" =~ ^[0-9a-f]+$ ]] \
  || fail "could not safely back up the report global quota"
report_quota_fixture_touched="true"

fixture_user="$(db_value "select gen_random_uuid();")"
admin_user="$(db_value "select gen_random_uuid();")"
doll_same_submission="$(db_value "select gen_random_uuid();")"
doll_same_target="$(db_value "select gen_random_uuid();")"
doll_report_first="$(db_value "select gen_random_uuid();")"
doll_takedown_first="$(db_value "select gen_random_uuid();")"
same_submission_id="$(db_value "select gen_random_uuid();")"
for id in \
  "$fixture_user" "$admin_user" "$doll_same_submission" \
  "$doll_same_target" "$doll_report_first" "$doll_takedown_first" \
  "$same_submission_id"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid UUID"
done

db_psql -q -c "
  insert into auth.users(id, email) values
    (
      '$fixture_user'::uuid,
      'report-race-$fixture_user@example.test'
    ),
    (
      '$admin_user'::uuid,
      'report-admin-$admin_user@example.test'
    );
  insert into public.member_accounts(user_id, gen_credits, is_admin)
  values ('$admin_user'::uuid, 0, true);
  insert into public.dolls(id, owner_id, image_url) values
    ('$doll_same_submission'::uuid, '$fixture_user'::uuid, 'same-submission.png'),
    ('$doll_same_target'::uuid, '$fixture_user'::uuid, 'same-target.png'),
    ('$doll_report_first'::uuid, '$fixture_user'::uuid, 'report-first.png'),
    ('$doll_takedown_first'::uuid, '$fixture_user'::uuid, 'takedown-first.png');
" >/dev/null

# A) Two simultaneous executions of one observable intent: the retry waits on
# the submission receipt lock and replays the same report without another row.
owner_app="bp_qa_report_receipt_owner_$$"
waiter_app="bp_qa_report_receipt_waiter_$$"
mkfifo "$qa_tmp_dir/receipt-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/receipt-owner.fifo" \
  >"$qa_tmp_dir/receipt-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/receipt-owner.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.submit_content_report(
    '$same_submission_id'::uuid,
    '$doll_same_submission'::uuid,
    'portrait',
    'same payload',
    null,
    'same@example.test',
    true
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "first execution to retain the submission receipt lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.submit_content_report(
    '$same_submission_id'::uuid,
    '$doll_same_submission'::uuid,
    'portrait',
    'same payload',
    null,
    'same@example.test',
    false
  );
" >"$qa_tmp_dir/receipt-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "response-loss retry to block on the submission receipt"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "first receipt transaction failed"
owner_pid=""
wait "$waiter_pid" || fail "receipt replay transaction failed"
waiter_pid=""
grep -Eq '"duplicate"[[:space:]]*:[[:space:]]*false' \
  "$qa_tmp_dir/receipt-owner.out" \
  || fail "first receipt execution was not marked new"
grep -Eq '"duplicate"[[:space:]]*:[[:space:]]*true' \
  "$qa_tmp_dir/receipt-waiter.out" \
  || fail "concurrent receipt retry was not marked duplicate"
receipt_state="$(
  db_value "
    select count(distinct r.id)::text
           || '|' ||
           count(distinct x.submission_id)::text
           || '|' ||
           count(distinct x.report_id)::text
      from public.content_reports r
      join public.content_report_submission_receipts x
        on x.report_id = r.id
     where r.target_id = '$doll_same_submission'::uuid;
  "
)"
[[ "$receipt_state" == "1|1|1" ]] \
  || fail "same submission did not converge to one report and one receipt"

# B) Two distinct simultaneous reports: B must wait on the same-target advisory
# lock, retain its own report, and observe `was_first=false`.
owner_app="bp_qa_report_owner_$$"
waiter_app="bp_qa_report_waiter_$$"
mkfifo "$qa_tmp_dir/report-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/report-owner.fifo" \
  >"$qa_tmp_dir/report-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/report-owner.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.submit_content_report(
    gen_random_uuid(),
    '$doll_same_target'::uuid,
    'portrait',
    null,
    null,
    null,
    true
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "first report transaction to retain its advisory lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.submit_content_report(
    gen_random_uuid(),
    '$doll_same_target'::uuid,
    'other',
    null,
    null,
    null,
    true
  );
" >"$qa_tmp_dir/report-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "second report to block on the first-pending election"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "first report transaction failed"
owner_pid=""
wait "$waiter_pid" || fail "second report transaction failed"
waiter_pid=""
grep -Eq '"was_first"[[:space:]]*:[[:space:]]*true' \
  "$qa_tmp_dir/report-owner.out" \
  || fail "first report did not win the alert election"
grep -Eq '"was_first"[[:space:]]*:[[:space:]]*false' \
  "$qa_tmp_dir/report-waiter.out" \
  || fail "second report also won the alert election"
same_target_state="$(
  db_value "
    select count(*)::text
      from public.content_reports
     where target_id = '$doll_same_target'::uuid
       and status = 'pending';
  "
)"
[[ "$same_target_state" == "2" ]] \
  || fail "same-target race did not retain exactly two pending reports"

# C) Report first: takedown waits on the doll row, then actions the committed
# report in its own transaction. No pending report survives a completed takedown.
owner_app="bp_qa_report_before_takedown_$$"
waiter_app="bp_qa_takedown_waiter_$$"
mkfifo "$qa_tmp_dir/report-first.fifo"
db_psql -qAt <"$qa_tmp_dir/report-first.fifo" \
  >"$qa_tmp_dir/report-first.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/report-first.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.submit_content_report(
    gen_random_uuid(),
    '$doll_report_first'::uuid,
    'defamation',
    null,
    null,
    null,
    true
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "report-first transaction to retain the doll KEY SHARE lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.admin_takedown_doll(
    '$admin_user'::uuid,
    '$doll_report_first'::uuid,
    'concurrency QA takedown'
  );
" >"$qa_tmp_dir/takedown-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "takedown to block behind the report"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "report-first transaction failed"
owner_pid=""
wait "$waiter_pid" || fail "report-first takedown failed"
waiter_pid=""
report_first_state="$(
  db_value "
    select (d.deleted_at is not null)::text
           || '|' ||
           count(*) filter (where r.status = 'pending')::text
           || '|' ||
           count(*) filter (where r.status = 'actioned')::text
      from public.dolls d
      left join public.content_reports r on r.target_id = d.id
     where d.id = '$doll_report_first'::uuid
     group by d.deleted_at;
  "
)"
[[ "$report_first_state" == "true|0|1" ]] \
  || fail "report-first final state is not deleted + zero pending + one actioned"

# D) Takedown first: a report waits on the doll row and resumes as an
# idempotent already-removed no-op without inserting.
owner_app="bp_qa_takedown_owner_$$"
waiter_app="bp_qa_report_after_takedown_$$"
mkfifo "$qa_tmp_dir/takedown-first.fifo"
db_psql -qAt <"$qa_tmp_dir/takedown-first.fifo" \
  >"$qa_tmp_dir/takedown-first.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/takedown-first.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_takedown_doll(
    '$admin_user'::uuid,
    '$doll_takedown_first'::uuid,
    'concurrency QA takedown'
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "takedown-first transaction to retain the doll UPDATE lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.submit_content_report(
    gen_random_uuid(),
    '$doll_takedown_first'::uuid,
    'obscene',
    null,
    null,
    null,
    true
  );
" >"$qa_tmp_dir/report-after-takedown.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "report to block behind takedown"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "takedown-first owner transaction failed"
owner_pid=""
wait "$waiter_pid" || fail "report after takedown failed"
waiter_pid=""
grep -Eq '"inserted"[[:space:]]*:[[:space:]]*false' \
  "$qa_tmp_dir/report-after-takedown.out" \
  || fail "report after takedown was not a non-insert"
grep -Eq '"already_removed"[[:space:]]*:[[:space:]]*true' \
  "$qa_tmp_dir/report-after-takedown.out" \
  || fail "report after takedown did not expose already_removed"
takedown_first_count="$(
  db_value "
    select count(*)::text
      from public.content_reports
     where target_id = '$doll_takedown_first'::uuid;
  "
)"
[[ "$takedown_first_count" == "0" ]] \
  || fail "takedown-first race created a report after deletion"

echo "content-report race QA passed:"
echo "  receipt/retry: concurrent response-loss retry converged to one row"
echo "  report/report: one first-pending winner, two retained rows"
echo "  report/takedown: takedown waited and actioned the committed report"
echo "  takedown/report: report waited and returned already_removed without insert"
