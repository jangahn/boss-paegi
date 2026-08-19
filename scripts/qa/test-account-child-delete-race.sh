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

qa_db_name="${QA_DB_NAME:-postgres}"
if [[ ! "$qa_db_name" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME must be a simple PostgreSQL identifier" >&2
  exit 2
fi

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-child-delete-race.XXXXXX")"
writer_pid=""
delete_pid=""
delete_owner_pid=""
writer_waiter_pid=""
generation_first_user=""
delete_first_user=""
profile_first_user=""
profile_delete_first_user=""
profile_first_session=""
profile_delete_first_session=""
report_delete_first_user=""
telemetry_delete_first_user=""
report_score=""
telemetry_session=""

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d "$qa_db_name" "$@"
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
  for pid in "$writer_pid" "$delete_pid" "$delete_owner_pid" "$writer_waiter_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$generation_first_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$delete_first_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$profile_first_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$profile_delete_first_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$report_delete_first_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$telemetry_delete_first_user" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      delete from public.score_highlights
       where score_id in (
         select id from public.scores
          where owner_id in (
            '$generation_first_user'::uuid,
            '$delete_first_user'::uuid,
            '$profile_first_user'::uuid,
            '$profile_delete_first_user'::uuid,
            '$report_delete_first_user'::uuid,
            '$telemetry_delete_first_user'::uuid
          )
       );
      delete from public.score_stats
       where score_id in (
         select id from public.scores
          where owner_id in (
            '$generation_first_user'::uuid,
            '$delete_first_user'::uuid,
            '$profile_first_user'::uuid,
            '$profile_delete_first_user'::uuid,
            '$report_delete_first_user'::uuid,
            '$telemetry_delete_first_user'::uuid
          )
       );
      delete from public.user_badges
       where owner_id in (
         '$generation_first_user'::uuid,
         '$delete_first_user'::uuid,
         '$profile_first_user'::uuid,
         '$profile_delete_first_user'::uuid,
         '$report_delete_first_user'::uuid,
         '$telemetry_delete_first_user'::uuid
       );
      delete from public.telemetry_sessions
       where owner_id in (
         '$generation_first_user'::uuid,
         '$delete_first_user'::uuid,
         '$profile_first_user'::uuid,
         '$profile_delete_first_user'::uuid,
         '$report_delete_first_user'::uuid,
         '$telemetry_delete_first_user'::uuid
       );
      delete from public.scores
       where owner_id in (
         '$generation_first_user'::uuid,
         '$delete_first_user'::uuid,
         '$profile_first_user'::uuid,
         '$profile_delete_first_user'::uuid,
         '$report_delete_first_user'::uuid,
         '$telemetry_delete_first_user'::uuid
       );
      delete from public.ai_generations
       where owner_id in (
         '$generation_first_user'::uuid,
         '$delete_first_user'::uuid,
         '$profile_first_user'::uuid,
         '$profile_delete_first_user'::uuid,
         '$report_delete_first_user'::uuid,
         '$telemetry_delete_first_user'::uuid
       );
      delete from public.dolls
       where owner_id in (
         '$generation_first_user'::uuid,
         '$delete_first_user'::uuid,
         '$profile_first_user'::uuid,
         '$profile_delete_first_user'::uuid,
         '$report_delete_first_user'::uuid,
         '$telemetry_delete_first_user'::uuid
       );
      delete from public.account_deletion_cleanup_jobs
       where user_id in (
         '$generation_first_user'::uuid,
         '$delete_first_user'::uuid,
         '$profile_first_user'::uuid,
         '$profile_delete_first_user'::uuid,
         '$report_delete_first_user'::uuid,
         '$telemetry_delete_first_user'::uuid
       );
      delete from public.member_accounts
       where user_id in (
         '$generation_first_user'::uuid,
         '$delete_first_user'::uuid,
         '$profile_first_user'::uuid,
         '$profile_delete_first_user'::uuid,
         '$report_delete_first_user'::uuid,
         '$telemetry_delete_first_user'::uuid
       );
      delete from auth.users
       where id in (
         '$generation_first_user'::uuid,
         '$delete_first_user'::uuid,
         '$profile_first_user'::uuid,
         '$profile_delete_first_user'::uuid,
         '$report_delete_first_user'::uuid,
         '$telemetry_delete_first_user'::uuid
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
              from public.user_badges
             where owner_id in (
               '$generation_first_user'::uuid,
               '$delete_first_user'::uuid,
               '$profile_first_user'::uuid,
               '$profile_delete_first_user'::uuid,
               '$report_delete_first_user'::uuid,
               '$telemetry_delete_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.telemetry_sessions
             where owner_id in (
               '$generation_first_user'::uuid,
               '$delete_first_user'::uuid,
               '$profile_first_user'::uuid,
               '$profile_delete_first_user'::uuid,
               '$report_delete_first_user'::uuid,
               '$telemetry_delete_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.scores
             where owner_id in (
               '$generation_first_user'::uuid,
               '$delete_first_user'::uuid,
               '$profile_first_user'::uuid,
               '$profile_delete_first_user'::uuid,
               '$report_delete_first_user'::uuid,
               '$telemetry_delete_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.ai_generations
             where owner_id in (
               '$generation_first_user'::uuid,
               '$delete_first_user'::uuid,
               '$profile_first_user'::uuid,
               '$profile_delete_first_user'::uuid,
               '$report_delete_first_user'::uuid,
               '$telemetry_delete_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.dolls
             where owner_id in (
               '$generation_first_user'::uuid,
               '$delete_first_user'::uuid,
               '$profile_first_user'::uuid,
               '$profile_delete_first_user'::uuid,
               '$report_delete_first_user'::uuid,
               '$telemetry_delete_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.account_deletion_cleanup_jobs
             where user_id in (
               '$generation_first_user'::uuid,
               '$delete_first_user'::uuid,
               '$profile_first_user'::uuid,
               '$profile_delete_first_user'::uuid,
               '$report_delete_first_user'::uuid,
               '$telemetry_delete_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in (
               '$generation_first_user'::uuid,
               '$delete_first_user'::uuid,
               '$profile_first_user'::uuid,
               '$profile_delete_first_user'::uuid,
               '$report_delete_first_user'::uuid,
               '$telemetry_delete_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in (
               '$generation_first_user'::uuid,
               '$delete_first_user'::uuid,
               '$profile_first_user'::uuid,
               '$profile_delete_first_user'::uuid,
               '$report_delete_first_user'::uuid,
               '$telemetry_delete_first_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in (
               '$generation_first_user'::uuid,
               '$delete_first_user'::uuid,
               '$profile_first_user'::uuid,
               '$profile_delete_first_user'::uuid,
               '$report_delete_first_user'::uuid,
               '$telemetry_delete_first_user'::uuid
             )
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "account child/delete race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
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
  echo "account child/delete race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
      tail -n 20 "$output" >&2
    fi
  done
  exit 1
}

# 세션 동기화는 공용 lib — 상한 120s(러너 속도 무관)·타임아웃 시 세션 스냅샷 덤프.
source scripts/qa/lib/wait-sync.sh

catalog_ok="$(
  db_value "
    select (
      to_regprocedure('public.create_generation_row(uuid,text)') is not null
      and to_regprocedure(
        'public.commit_score_report(uuid,uuid,jsonb,text,text[],integer,text[])'
      ) is not null
      and to_regprocedure(
        'public.bp_ingest_telemetry_delta_core(uuid,uuid,boolean,jsonb)'
      ) is not null
      and exists (
        select 1 from pg_catalog.pg_trigger
         where tgrelid = 'public.score_highlights'::regclass
           and tgname = 'trg_score_highlights_reject_deleted_owner_insert'
           and not tgisinternal
      )
      and exists (
        select 1 from pg_catalog.pg_trigger
         where tgrelid = 'public.score_stats'::regclass
           and tgname = 'trg_score_stats_reject_deleted_owner_insert'
           and not tgisinternal
           and tgenabled <> 'D'
      )
      and exists (
        select 1 from pg_catalog.pg_trigger
         where tgrelid = 'public.user_badges'::regclass
           and tgname = 'trg_user_badges_reject_deleted_owner_insert'
           and not tgisinternal
           and tgenabled <> 'D'
      )
      and exists (
        select 1 from pg_catalog.pg_trigger
         where tgrelid = 'public.telemetry_sessions'::regclass
           and tgname = 'trg_telemetry_reject_deleted_owner_insert'
           and not tgisinternal
           and tgenabled <> 'D'
      )
      and exists (
        select 1 from pg_catalog.pg_trigger
         where tgrelid = 'public.telemetry_sessions'::regclass
           and tgname =
               'trg_telemetry_reject_deleted_owner_ingest_update'
           and not tgisinternal
           and tgenabled <> 'D'
      )
      and exists (
        select 1 from pg_catalog.pg_trigger
         where tgrelid = 'public.profiles'::regclass
           and tgname = 'trg_profiles_reject_deleted_display_name_update'
           and tgenabled = 'O'
           and not tgisinternal
      )
      and (
        select count(*) = 1
          from pg_catalog.pg_policy p
         where p.polrelid = 'public.profiles'::regclass
           and p.polcmd = 'w'
      )
      and exists (
        select 1
          from pg_catalog.pg_policy p
         where p.polrelid = 'public.profiles'::regclass
           and p.polname = 'profiles: self update'
           and p.polcmd = 'w'
           and p.polpermissive
           and p.polroles = array[
             (select r.oid from pg_catalog.pg_roles r
               where r.rolname = 'authenticated')
           ]::oid[]
           and pg_catalog.pg_get_expr(p.polqual, p.polrelid)
             = '((auth.uid() = id) AND (deleted_at IS NULL) AND oauth_current_auth_session_live())'
           and pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
             = '((auth.uid() = id) AND (deleted_at IS NULL) AND oauth_current_auth_session_live())'
      )
      and not has_function_privilege(
        'service_role',
        'public.bp_reject_deleted_profile_update()',
        'EXECUTE'
      )
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "0072 lifecycle guards are not applied; run npm run qa:db:apply first"

generation_first_user="$(db_value "select gen_random_uuid();")"
delete_first_user="$(db_value "select gen_random_uuid();")"
profile_first_user="$(db_value "select gen_random_uuid();")"
profile_delete_first_user="$(db_value "select gen_random_uuid();")"
profile_first_session="$(db_value "select gen_random_uuid();")"
profile_delete_first_session="$(db_value "select gen_random_uuid();")"
report_delete_first_user="$(db_value "select gen_random_uuid();")"
telemetry_delete_first_user="$(db_value "select gen_random_uuid();")"
spare_score="$(db_value "select gen_random_uuid();")"
report_score="$(db_value "select gen_random_uuid();")"
telemetry_session="$(db_value "select gen_random_uuid();")"
for id in \
  "$generation_first_user" \
  "$delete_first_user" \
  "$profile_first_user" \
  "$profile_delete_first_user" \
  "$profile_first_session" \
  "$profile_delete_first_session" \
  "$report_delete_first_user" \
  "$telemetry_delete_first_user" \
  "$spare_score" \
  "$report_score" \
  "$telemetry_session"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || fail "PostgreSQL returned an invalid UUID"
done

db_psql -q -c "
  insert into auth.users(id, email) values
    (
      '$generation_first_user'::uuid,
      'generation-first-$generation_first_user@test.local'
    ),
    (
      '$delete_first_user'::uuid,
      'delete-first-child-$delete_first_user@test.local'
    ),
    (
      '$profile_first_user'::uuid,
      'profile-first-$profile_first_user@test.local'
    ),
    (
      '$profile_delete_first_user'::uuid,
      'profile-delete-first-$profile_delete_first_user@test.local'
    ),
    (
      '$report_delete_first_user'::uuid,
      'report-delete-first-$report_delete_first_user@test.local'
    ),
    (
      '$telemetry_delete_first_user'::uuid,
      'telemetry-delete-first-$telemetry_delete_first_user@test.local'
    );
  insert into public.member_accounts(user_id, gen_credits) values
    ('$generation_first_user'::uuid, 0),
    ('$delete_first_user'::uuid, 0),
    ('$profile_first_user'::uuid, 0),
    ('$profile_delete_first_user'::uuid, 0),
    ('$report_delete_first_user'::uuid, 0),
    ('$telemetry_delete_first_user'::uuid, 0)
  on conflict (user_id) do nothing;
  insert into auth.sessions(id, user_id, created_at, updated_at) values
    (
      '$profile_first_session'::uuid,
      '$profile_first_user'::uuid,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    ),
    (
      '$profile_delete_first_session'::uuid,
      '$profile_delete_first_user'::uuid,
      pg_catalog.clock_timestamp(),
      pg_catalog.clock_timestamp()
    );
  insert into public.scores(
    id, owner_id, score, weapon, duration_ms
  ) values
    (
      '$spare_score'::uuid,
      '$delete_first_user'::uuid,
      1,
      'fist',
      1000
    ),
    (
      '$report_score'::uuid,
      '$report_delete_first_user'::uuid,
      10,
      'fist',
      1000
    );
  insert into public.telemetry_sessions(
    id,
    owner_id,
    is_anon,
    submitter_binding,
    device_class,
    started_at
  ) values (
    '$telemetry_session'::uuid,
    '$telemetry_delete_first_user'::uuid,
    false,
    public.bp_telemetry_submitter_binding(
      '$telemetry_session'::uuid,
      '$telemetry_delete_first_user'::uuid
    ),
    'desktop-pointer',
    clock_timestamp()
  );
" >/dev/null

writer_app="bp_qa_generation_first_$$"
delete_waiter_app="bp_qa_child_delete_waiter_$$"
delete_owner_app="bp_qa_child_delete_first_$$"
writer_waiter_app="bp_qa_generation_waiter_$$"
profile_writer_app="bp_qa_profile_first_$$"
profile_delete_waiter_app="bp_qa_profile_delete_waiter_$$"
profile_delete_owner_app="bp_qa_profile_delete_first_$$"
profile_waiter_app="bp_qa_profile_waiter_$$"
report_delete_owner_app="bp_qa_report_delete_first_$$"
report_waiter_app="bp_qa_report_waiter_$$"
telemetry_delete_owner_app="bp_qa_telemetry_delete_first_$$"
telemetry_waiter_app="bp_qa_telemetry_waiter_$$"

# Active self-service nickname updates remain available before account deletion.
active_profile_update_count="$(
  db_value "
    begin;
    set local request.jwt.claims =
      '{\"sub\":\"$profile_first_user\",\"role\":\"authenticated\",\"session_id\":\"$profile_first_session\"}';
    set local role authenticated;
    with updated as (
      update public.profiles
         set display_name = 'active-self'
       where id = auth.uid()
      returning 1
    )
    select count(*) from updated;
    commit;
  "
)"
[[ "$active_profile_update_count" == "1" ]] \
  || fail "active authenticated self nickname update did not update one row"

# A) child-first: create_generation_row holds profile KEY SHARE until commit.
#    Account deletion must wait, then include the committed child in its lifecycle.
mkfifo "$qa_tmp_dir/generation-first.fifo"
db_psql -qAt <"$qa_tmp_dir/generation-first.fifo" \
  >"$qa_tmp_dir/generation-first.out" 2>&1 &
writer_pid="$!"
exec 3>"$qa_tmp_dir/generation-first.fifo"
printf "%s\n" "
  set application_name = '$writer_app';
  set statement_timeout = '15s';
  begin;
  select public.create_generation_row(
    '$generation_first_user'::uuid,
    'boss'
  );
" >&3
wait_for_activity \
  "$writer_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "generation-first transaction to hold profile KEY SHARE"

db_psql -q -c "
  set application_name = '$delete_waiter_app';
  set statement_timeout = '15s';
  select public.admin_soft_delete_account('$generation_first_user'::uuid);
" >"$qa_tmp_dir/delete-waiter.out" 2>&1 &
delete_pid="$!"
wait_for_activity \
  "$delete_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "account deletion to wait behind child writer"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$writer_pid" || fail "generation-first writer transaction failed"
writer_pid=""
wait "$delete_pid" || fail "generation-first account deletion failed"
delete_pid=""

generation_first_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|' || count(g.*)::text
      from public.profiles p
      left join public.ai_generations g
        on g.owner_id = p.id
       and g.status = 'queued'
     where p.id = '$generation_first_user'::uuid
     group by p.deleted_at;
  "
)"
[[ "$generation_first_state" == "true|1" ]] \
  || fail "generation-first final state is not deleted + one committed queued row"

# B) delete-first: soft delete holds profile FOR UPDATE. The stale generation
#    RPC waits, resumes after commit, and must fail without inserting a row.
mkfifo "$qa_tmp_dir/delete-first.fifo"
db_psql -qAt <"$qa_tmp_dir/delete-first.fifo" \
  >"$qa_tmp_dir/delete-first.out" 2>&1 &
delete_owner_pid="$!"
exec 3>"$qa_tmp_dir/delete-first.fifo"
printf "%s\n" "
  set application_name = '$delete_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_soft_delete_account('$delete_first_user'::uuid);
" >&3
wait_for_activity \
  "$delete_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "delete-first transaction to hold profile FOR UPDATE"

db_psql -q -c "
  set application_name = '$writer_waiter_app';
  set statement_timeout = '15s';
  select public.create_generation_row('$delete_first_user'::uuid, 'boss');
" >"$qa_tmp_dir/generation-waiter.out" 2>&1 &
writer_waiter_pid="$!"
wait_for_activity \
  "$writer_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "generation writer to wait behind account deletion"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$delete_owner_pid" || fail "delete-first owner transaction failed"
delete_owner_pid=""
if wait "$writer_waiter_pid"; then
  fail "delete-first generation writer unexpectedly succeeded"
fi
writer_waiter_pid=""
grep -F "account_deleted" "$qa_tmp_dir/generation-waiter.out" >/dev/null \
  || fail "delete-first generation writer did not fail with account_deleted"

delete_first_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|' || count(g.*)::text
      from public.profiles p
      left join public.ai_generations g on g.owner_id = p.id
     where p.id = '$delete_first_user'::uuid
     group by p.deleted_at;
  "
)"
[[ "$delete_first_state" == "true|0" ]] \
  || fail "delete-first final state is not deleted + zero generation rows"

# B2) report/delete lock-order: deletion owns only the canonical user advisory
#     while the profile is still active. A report must wait before reading that
#     profile; deletion can then take the row lock and commit without a cycle.
#     The report resumes against the committed deleted_at and inserts nothing.
mkfifo "$qa_tmp_dir/report-delete-first.fifo"
db_psql -qAt <"$qa_tmp_dir/report-delete-first.fifo" \
  >"$qa_tmp_dir/report-delete-first.out" 2>&1 &
delete_owner_pid="$!"
exec 3>"$qa_tmp_dir/report-delete-first.fifo"
printf "%s\n" "
  set application_name = '$report_delete_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.bp_user_mutation_lock(
    '$report_delete_first_user'::uuid
  );
" >&3
wait_for_activity \
  "$report_delete_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "report delete-first transaction to hold only the canonical user lock"

db_psql -q -c "
  set application_name = '$report_waiter_app';
  set statement_timeout = '15s';
  select public.commit_score_report(
    '$report_score'::uuid,
    '$report_delete_first_user'::uuid,
    '{}'::jsonb,
    'qa-race-persona',
    array['qa-race-badge']::text[],
    50,
    array['qa-race-badge']::text[]
  );
" >"$qa_tmp_dir/report-waiter.out" 2>&1 &
writer_waiter_pid="$!"
wait_for_activity \
  "$report_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "score report to wait on the canonical user lock before profile read"

printf "%s\n" "
  select public.admin_soft_delete_account(
    '$report_delete_first_user'::uuid
  );
  commit;
  \\q
" >&3
exec 3>&-
wait "$delete_owner_pid" \
  || fail "report delete-first account deletion deadlocked or failed"
delete_owner_pid=""
if wait "$writer_waiter_pid"; then
  fail "report delete-first score report unexpectedly succeeded"
fi
writer_waiter_pid=""
grep -F "account_deleted" "$qa_tmp_dir/report-waiter.out" >/dev/null \
  || fail "report delete-first score report did not fail with account_deleted"

report_delete_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|'
           || count(distinct st.score_id)::text || '|'
           || count(distinct ub.badge_id)::text
      from public.profiles p
      left join public.scores s
        on s.owner_id = p.id
      left join public.score_stats st
        on st.score_id = s.id
      left join public.user_badges ub
        on ub.owner_id = p.id
     where p.id = '$report_delete_first_user'::uuid
     group by p.deleted_at;
  "
)"
[[ "$report_delete_state" == "true|0|0" ]] \
  || fail "report delete-first committed post-delete report artifacts"

# B3) telemetry/delete uses the same exact schedule against the private core.
#     The existing session makes this an UPDATE path; the trigger tests below
#     separately prove that a deleted owner cannot INSERT a fresh session.
mkfifo "$qa_tmp_dir/telemetry-delete-first.fifo"
db_psql -qAt <"$qa_tmp_dir/telemetry-delete-first.fifo" \
  >"$qa_tmp_dir/telemetry-delete-first.out" 2>&1 &
delete_owner_pid="$!"
exec 3>"$qa_tmp_dir/telemetry-delete-first.fifo"
printf "%s\n" "
  set application_name = '$telemetry_delete_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.bp_user_mutation_lock(
    '$telemetry_delete_first_user'::uuid
  );
" >&3
wait_for_activity \
  "$telemetry_delete_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "telemetry delete-first transaction to hold only the canonical user lock"

db_psql -qAt -c "
  set application_name = '$telemetry_waiter_app';
  set statement_timeout = '15s';
  select public.bp_ingest_telemetry_delta_core(
    '$telemetry_session'::uuid,
    '$telemetry_delete_first_user'::uuid,
    true,
    jsonb_build_object(
      'deviceClass', 'desktop-pointer',
      'startedAt', clock_timestamp(),
      'summary', jsonb_build_object(
        'seqHigh', 1,
        'durationMs', 1000,
        'totals', jsonb_build_object(
          'score', 10,
          'hitCount', 1,
          'maxCombo', 1,
          'ultFireCount', 0
        ),
        'weaponSummary', '{}'::jsonb,
        'mapSummary', '{}'::jsonb
      ),
      'events', '[]'::jsonb
    )
  );
" >"$qa_tmp_dir/telemetry-waiter.out" 2>&1 &
writer_waiter_pid="$!"
wait_for_activity \
  "$telemetry_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "telemetry core to wait on the canonical user lock before profile read"

printf "%s\n" "
  select public.admin_soft_delete_account(
    '$telemetry_delete_first_user'::uuid
  );
  commit;
  \\q
" >&3
exec 3>&-
wait "$delete_owner_pid" \
  || fail "telemetry delete-first account deletion deadlocked or failed"
delete_owner_pid=""
wait "$writer_waiter_pid" \
  || fail "telemetry delete-first core call errored instead of rejecting"
writer_waiter_pid=""
grep -F '"reason": "account_deleted"' \
  "$qa_tmp_dir/telemetry-waiter.out" >/dev/null \
  || fail "telemetry delete-first core did not return account_deleted"

telemetry_delete_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|'
           || t.write_count::text
      from public.profiles p
      join public.telemetry_sessions t
        on t.owner_id = p.id
     where p.id = '$telemetry_delete_first_user'::uuid
       and t.id = '$telemetry_session'::uuid;
  "
)"
[[ "$telemetry_delete_state" == "true|0" ]] \
  || fail "telemetry delete-first mutated the durable session"

# C) profile-update-first: authenticated nickname UPDATE owns the profile row.
#    Deletion waits, then must overwrite the committed nickname with the scrub.
mkfifo "$qa_tmp_dir/profile-first.fifo"
db_psql -qAt <"$qa_tmp_dir/profile-first.fifo" \
  >"$qa_tmp_dir/profile-first.out" 2>&1 &
writer_pid="$!"
exec 3>"$qa_tmp_dir/profile-first.fifo"
printf "%s\n" "
  set application_name = '$profile_writer_app';
  set statement_timeout = '15s';
  begin;
  set local request.jwt.claims =
    '{\"sub\":\"$profile_first_user\",\"role\":\"authenticated\",\"session_id\":\"$profile_first_session\"}';
  set local role authenticated;
  update public.profiles
     set display_name = 'profile-first'
   where id = auth.uid();
" >&3
wait_for_activity \
  "$profile_writer_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "profile-first nickname writer to hold the profile row"

db_psql -q -c "
  set application_name = '$profile_delete_waiter_app';
  set statement_timeout = '15s';
  select public.admin_soft_delete_account('$profile_first_user'::uuid);
" >"$qa_tmp_dir/profile-delete-waiter.out" 2>&1 &
delete_pid="$!"
wait_for_activity \
  "$profile_delete_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "account deletion to wait behind the nickname writer"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$writer_pid" || fail "profile-first nickname transaction failed"
writer_pid=""
wait "$delete_pid" || fail "profile-first account deletion failed"
delete_pid=""

profile_first_state="$(
  db_value "
    select (deleted_at is not null)::text || '|' || display_name
      from public.profiles
     where id = '$profile_first_user'::uuid;
  "
)"
[[ "$profile_first_state" == "true|탈퇴한 사용자" ]] \
  || fail "profile-first final state did not converge to the deleted scrub"

# D) profile-delete-first: deletion owns the profile row. A stale authenticated
#    nickname UPDATE waits, then RLS EvalPlanQual must recheck the committed
#    deleted_at and update zero rows without restoring public PII.
mkfifo "$qa_tmp_dir/profile-delete-first.fifo"
db_psql -qAt <"$qa_tmp_dir/profile-delete-first.fifo" \
  >"$qa_tmp_dir/profile-delete-first.out" 2>&1 &
delete_owner_pid="$!"
exec 3>"$qa_tmp_dir/profile-delete-first.fifo"
printf "%s\n" "
  set application_name = '$profile_delete_owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_soft_delete_account(
    '$profile_delete_first_user'::uuid
  );
" >&3
wait_for_activity \
  "$profile_delete_owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "profile delete-first transaction to hold the profile row"

db_psql -qAt -c "
  set application_name = '$profile_waiter_app';
  set statement_timeout = '15s';
  begin;
  set local request.jwt.claims =
    '{\"sub\":\"$profile_delete_first_user\",\"role\":\"authenticated\",\"session_id\":\"$profile_delete_first_session\"}';
  set local role authenticated;
  with updated as (
    update public.profiles
       set display_name = 'stale-profile'
     where id = auth.uid()
    returning 1
  )
  select count(*) from updated;
  commit;
" >"$qa_tmp_dir/profile-waiter.out" 2>&1 &
writer_waiter_pid="$!"
wait_for_activity \
  "$profile_waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "stale nickname writer to wait behind account deletion"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$delete_owner_pid" || fail "profile delete-first transaction failed"
delete_owner_pid=""
wait "$writer_waiter_pid" \
  || fail "profile delete-first stale nickname writer errored"
writer_waiter_pid=""
profile_waiter_count="$(tr -d '[:space:]' <"$qa_tmp_dir/profile-waiter.out")"
[[ "$profile_waiter_count" == "0" ]] \
  || fail "profile delete-first stale nickname writer did not update zero rows"

profile_delete_first_state="$(
  db_value "
    select (deleted_at is not null)::text || '|' || display_name
      from public.profiles
     where id = '$profile_delete_first_user'::uuid;
  "
)"
[[ "$profile_delete_first_state" == "true|탈퇴한 사용자" ]] \
  || fail "profile delete-first final state did not preserve the deleted scrub"

# RLS-bypassing owner/service writes still hit the trigger backstop.
if db_psql -q -c "
  update public.profiles
     set display_name = 'owner-bypass'
   where id = '$profile_delete_first_user'::uuid;
" >"$qa_tmp_dir/profile-owner-bypass.out" 2>&1; then
  fail "owner-bypass nickname UPDATE for a deleted profile unexpectedly succeeded"
fi
grep -F "account_deleted" "$qa_tmp_dir/profile-owner-bypass.out" >/dev/null \
  || fail "owner-bypass nickname UPDATE did not fail with account_deleted"

# Direct child DML bypass attempts must hit the same DB trigger backstop.
if db_psql -q -c "
  insert into public.dolls(owner_id, image_url)
  values ('$delete_first_user'::uuid, 'deleted-owner.png');
" >"$qa_tmp_dir/direct-doll.out" 2>&1; then
  fail "direct doll INSERT for deleted owner unexpectedly succeeded"
fi
grep -F "account_deleted" "$qa_tmp_dir/direct-doll.out" >/dev/null \
  || fail "direct doll INSERT did not fail with account_deleted"

if db_psql -q -c "
  insert into public.scores(owner_id, score, weapon, duration_ms)
  values ('$delete_first_user'::uuid, 2, 'fist', 1000);
" >"$qa_tmp_dir/direct-score.out" 2>&1; then
  fail "direct score INSERT for deleted owner unexpectedly succeeded"
fi
grep -F "account_deleted" "$qa_tmp_dir/direct-score.out" >/dev/null \
  || fail "direct score INSERT did not fail with account_deleted"

if db_psql -q -c "
  insert into public.score_highlights(score_id, highlight_status)
  values ('$spare_score'::uuid, 'card');
" >"$qa_tmp_dir/direct-highlight.out" 2>&1; then
  fail "direct highlight INSERT for deleted owner unexpectedly succeeded"
fi
grep -F "account_deleted" "$qa_tmp_dir/direct-highlight.out" >/dev/null \
  || fail "direct highlight INSERT did not fail with account_deleted"

if db_psql -q -c "
  insert into public.score_stats(
    score_id, gameplay_stats, persona_id, badge_ids, percentile
  ) values (
    '$report_score'::uuid,
    '{}'::jsonb,
    'owner-bypass',
    array[]::text[],
    50
  );
" >"$qa_tmp_dir/direct-score-stats.out" 2>&1; then
  fail "direct score_stats INSERT for deleted owner unexpectedly succeeded"
fi
grep -F "account_deleted" "$qa_tmp_dir/direct-score-stats.out" >/dev/null \
  || fail "direct score_stats INSERT did not fail with account_deleted"

if db_psql -q -c "
  insert into public.user_badges(owner_id, badge_id, first_score_id)
  values (
    '$report_delete_first_user'::uuid,
    'owner-bypass',
    '$report_score'::uuid
  );
" >"$qa_tmp_dir/direct-user-badge.out" 2>&1; then
  fail "direct user_badges INSERT for deleted owner unexpectedly succeeded"
fi
grep -F "account_deleted" "$qa_tmp_dir/direct-user-badge.out" >/dev/null \
  || fail "direct user_badges INSERT did not fail with account_deleted"

fresh_telemetry_session="$(db_value "select gen_random_uuid();")"
[[ "$fresh_telemetry_session" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "PostgreSQL returned an invalid fresh telemetry UUID"
if db_psql -q -c "
  insert into public.telemetry_sessions(
    id, owner_id, is_anon, device_class, started_at
  ) values (
    '$fresh_telemetry_session'::uuid,
    '$telemetry_delete_first_user'::uuid,
    false,
    'desktop-pointer',
    clock_timestamp()
  );
" >"$qa_tmp_dir/direct-telemetry-insert.out" 2>&1; then
  fail "direct telemetry INSERT for deleted owner unexpectedly succeeded"
fi
grep -F "account_deleted" \
  "$qa_tmp_dir/direct-telemetry-insert.out" >/dev/null \
  || fail "direct telemetry INSERT did not fail with account_deleted"

if db_psql -q -c "
  update public.telemetry_sessions
     set write_count = write_count + 1
   where id = '$telemetry_session'::uuid;
" >"$qa_tmp_dir/direct-telemetry-update.out" 2>&1; then
  fail "direct telemetry ingest UPDATE for deleted owner unexpectedly succeeded"
fi
grep -F "account_deleted" \
  "$qa_tmp_dir/direct-telemetry-update.out" >/dev/null \
  || fail "direct telemetry ingest UPDATE did not fail with account_deleted"

echo "account child/delete race QA passed:"
echo "  child-first: delete waited; deleted + one committed queued generation"
echo "  delete-first: generation waited, then account_deleted + zero rows"
echo "  report delete-first: canonical lock-first, no stats/badge artifacts"
echo "  telemetry delete-first: canonical lock-first, write_count unchanged"
echo "  profile-first: delete waited, then overwrote nickname with the scrub"
echo "  profile delete-first: stale nickname waited, then updated zero rows"
echo "  active self nickname update remains allowed; owner bypass is rejected"
echo "  all direct child/report/telemetry writes: account_deleted backstop"
