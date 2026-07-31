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
qa_db_name="${BOSS_PAEGI_QA_DB:-postgres}"
if [[ ! "$qa_db_name" =~ ^[a-zA-Z0-9_]+$ ]]; then
  echo "invalid BOSS_PAEGI_QA_DB" >&2
  exit 1
fi

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-consent-delete-race.XXXXXX")"
owner_pid=""
waiter_pid=""
consent_first_user=""
delete_first_consent_user=""
sync_first_user=""
delete_first_sync_user=""
terms_doc=""
privacy_doc=""

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
  for pid in "$owner_pid" "$waiter_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$consent_first_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$delete_first_consent_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$sync_first_user" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$delete_first_sync_user" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      select pg_catalog.set_config(
        'boss_paegi.privacy_retention_delete',
        '008904:v1',
        true
      );
      delete from public.account_deletion_cleanup_jobs
       where user_id in (
         '$consent_first_user'::uuid,
         '$delete_first_consent_user'::uuid,
         '$sync_first_user'::uuid,
         '$delete_first_sync_user'::uuid
       );
      delete from public.credit_lots
       where user_id in (
         '$consent_first_user'::uuid,
         '$delete_first_consent_user'::uuid,
         '$sync_first_user'::uuid,
         '$delete_first_sync_user'::uuid
       );
      delete from public.member_accounts
       where user_id in (
         '$consent_first_user'::uuid,
         '$delete_first_consent_user'::uuid,
         '$sync_first_user'::uuid,
         '$delete_first_sync_user'::uuid
       );
      delete from auth.users
       where id in (
         '$consent_first_user'::uuid,
         '$delete_first_consent_user'::uuid,
         '$sync_first_user'::uuid,
         '$delete_first_sync_user'::uuid
       );
      delete from public.legal_documents
       where id in (
         '$terms_doc'::uuid,
         '$privacy_doc'::uuid
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
              from public.account_deletion_cleanup_jobs
             where user_id in (
               '$consent_first_user'::uuid,
               '$delete_first_consent_user'::uuid,
               '$sync_first_user'::uuid,
               '$delete_first_sync_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.credit_lots
             where user_id in (
               '$consent_first_user'::uuid,
               '$delete_first_consent_user'::uuid,
               '$sync_first_user'::uuid,
               '$delete_first_sync_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id in (
               '$consent_first_user'::uuid,
               '$delete_first_consent_user'::uuid,
               '$sync_first_user'::uuid,
               '$delete_first_sync_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id in (
               '$consent_first_user'::uuid,
               '$delete_first_consent_user'::uuid,
               '$sync_first_user'::uuid,
               '$delete_first_sync_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id in (
               '$consent_first_user'::uuid,
               '$delete_first_consent_user'::uuid,
               '$sync_first_user'::uuid,
               '$delete_first_sync_user'::uuid
             )
          )
          + (
            select pg_catalog.count(*)
              from public.legal_documents
             where id in ('$terms_doc'::uuid, '$privacy_doc'::uuid)
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "consent/delete race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
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
  echo "consent/delete race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
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
         where datname = '$qa_db_name'
           and application_name = '$app_name'
           and backend_type = 'client backend'
           and ($predicate);
      "
    )"
    if [[ "$count" == "1" ]]; then
      return 0
    fi
    sleep 0.05
  done
  fail "timed out waiting for $description"
}

catalog_ok="$(
  db_value "
    select (
      to_regprocedure(
        'public.create_or_update_member_consent_with_profile(uuid,integer,boolean,boolean,integer,boolean,integer,text,text,text)'
      ) is not null
      and to_regprocedure(
        'public.sync_active_member_oauth_profile(uuid,text,text,text)'
      ) is not null
      and exists (
        select 1
          from pg_catalog.pg_trigger
         where tgrelid = 'public.profiles'::regclass
           and tgname = 'trg_profiles_scrub_member_consent_on_delete'
           and not tgisinternal
      )
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "0079 is not applied; run npm run qa:db:apply first"

consent_first_user="$(db_value "select gen_random_uuid();")"
delete_first_consent_user="$(db_value "select gen_random_uuid();")"
sync_first_user="$(db_value "select gen_random_uuid();")"
delete_first_sync_user="$(db_value "select gen_random_uuid();")"
terms_doc="$(db_value "select gen_random_uuid();")"
privacy_doc="$(db_value "select gen_random_uuid();")"
for id in \
  "$consent_first_user" "$delete_first_consent_user" \
  "$sync_first_user" "$delete_first_sync_user" \
  "$terms_doc" "$privacy_doc"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid UUID"
done

# This race tests consent/delete serialization, not legal publication. Reuse
# an existing current authority or bootstrap only the notice-exempt v1.
db_psql -q -c "
  insert into public.legal_documents(
    id, doc_type, status, version, effective_date, title, sections
  )
  select
    '$terms_doc'::uuid,
    'terms',
    'published',
    1,
    (clock_timestamp() at time zone 'Asia/Seoul')::date,
    'Race terms',
    '[{\"heading\":\"Terms\",\"body\":\"Race terms\"}]'::jsonb
  where not exists (
    select 1
      from public.legal_documents l
     where l.doc_type = 'terms'
       and l.status = 'published'
       and l.effective_date <=
             (clock_timestamp() at time zone 'Asia/Seoul')::date
  );
  insert into public.legal_documents(
    id, doc_type, status, version, effective_date, title, sections
  )
  select
    '$privacy_doc'::uuid,
    'privacy',
    'published',
    1,
    (clock_timestamp() at time zone 'Asia/Seoul')::date,
    'Race privacy',
    '[{\"heading\":\"Privacy\",\"body\":\"Race privacy\"}]'::jsonb
  where not exists (
    select 1
      from public.legal_documents l
     where l.doc_type = 'privacy'
       and l.status = 'published'
       and l.effective_date <=
             (clock_timestamp() at time zone 'Asia/Seoul')::date
  );
" >/dev/null

terms_version="$(
  db_value "
    select l.version
      from public.legal_documents l
     where l.doc_type = 'terms'
       and l.status = 'published'
       and l.effective_date <=
             (clock_timestamp() at time zone 'Asia/Seoul')::date
     order by l.effective_date desc, l.version desc, l.id desc
     limit 1;
  "
)"
privacy_version="$(
  db_value "
    select l.version
      from public.legal_documents l
     where l.doc_type = 'privacy'
       and l.status = 'published'
       and l.effective_date <=
             (clock_timestamp() at time zone 'Asia/Seoul')::date
     order by l.effective_date desc, l.version desc, l.id desc
     limit 1;
  "
)"
[[ "$terms_version" =~ ^[1-9][0-9]*$ ]] || fail "invalid terms version"
[[ "$privacy_version" =~ ^[1-9][0-9]*$ ]] || fail "invalid privacy version"

db_psql -q -c "
  insert into auth.users(id, email) values
    (
      '$consent_first_user'::uuid,
      'consent-first-$consent_first_user@test.local'
    ),
    (
      '$delete_first_consent_user'::uuid,
      'delete-first-consent-$delete_first_consent_user@test.local'
    ),
    (
      '$sync_first_user'::uuid,
      'sync-first-$sync_first_user@test.local'
    ),
    (
      '$delete_first_sync_user'::uuid,
      'delete-first-sync-$delete_first_sync_user@test.local'
    );
  insert into public.member_accounts(
    user_id, email, age_confirmed_at
  ) values
    (
      '$sync_first_user'::uuid,
      'sync-old@test.local',
      clock_timestamp()
    ),
    (
      '$delete_first_sync_user'::uuid,
      'delete-sync-old@test.local',
      clock_timestamp()
    );
" >/dev/null

run_owner_then_waiter() {
  scenario="$1"
  owner_sql="$2"
  waiter_sql="$3"
  owner_app="$4"
  waiter_app="$5"
  waiter_should_fail="$6"
  waiter_error="$7"

  mkfifo "$qa_tmp_dir/$scenario.fifo"
  db_psql -qAt <"$qa_tmp_dir/$scenario.fifo" \
    >"$qa_tmp_dir/$scenario-owner.out" 2>&1 &
  owner_pid="$!"
  exec 3>"$qa_tmp_dir/$scenario.fifo"
  printf "%s\n" "
    set application_name = '$owner_app';
    set statement_timeout = '15s';
    begin;
    $owner_sql
  " >&3
  wait_for_activity \
    "$owner_app" \
    "state = 'idle in transaction' and xact_start is not null" \
    "$scenario owner transaction"

  db_psql -q -c "
    set application_name = '$waiter_app';
    set statement_timeout = '15s';
    set deadlock_timeout = '100ms';
    $waiter_sql
  " >"$qa_tmp_dir/$scenario-waiter.out" 2>&1 &
  waiter_pid="$!"
  wait_for_activity \
    "$waiter_app" \
    "state = 'active' and wait_event_type = 'Lock'" \
    "$scenario waiter lock"

  printf "commit;\n\\q\n" >&3
  exec 3>&-
  wait "$owner_pid" || fail "$scenario owner transaction failed"
  owner_pid=""
  if [[ "$waiter_should_fail" == "true" ]]; then
    if wait "$waiter_pid"; then
      fail "$scenario waiter unexpectedly succeeded"
    fi
    grep -F "$waiter_error" "$qa_tmp_dir/$scenario-waiter.out" >/dev/null \
      || fail "$scenario waiter did not report $waiter_error"
  else
    wait "$waiter_pid" || fail "$scenario waiter failed"
  fi
  waiter_pid=""
}

# A) Consent commits first. Delete waits and then scrubs every just-written
# consent/profile field in its own transaction.
run_owner_then_waiter \
  "consent-first" \
  "select public.create_or_update_member_consent_with_profile(
     '$consent_first_user'::uuid,
     0,
     true,
     true,
     $terms_version,
     true,
     $privacy_version,
     'ConsentFirst',
     'https://avatar.test/consent-first.png',
     'consent-first@test.local'
   );" \
  "select public.admin_soft_delete_account(
     '$consent_first_user'::uuid
   );" \
  "bp_qa_consent_first_$$" \
  "bp_qa_delete_after_consent_$$" \
  "false" \
  ""
consent_first_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|'
           || (m.email is null)::text || '|'
           || (m.terms_version is null)::text || '|'
           || (m.privacy_version is null)::text || '|'
           || m.reconsent_required::text
      from public.profiles p
      join public.member_accounts m on m.user_id = p.id
     where p.id = '$consent_first_user'::uuid;
  "
)"
[[ "$consent_first_state" == "true|true|true|true|true" ]] \
  || fail "consent-first final state retained PII/consent after deletion"

# B) Delete commits first. A stale consent request that already entered the DB
# waits on the profile and then fails without creating a member row.
run_owner_then_waiter \
  "delete-first-consent" \
  "select public.admin_soft_delete_account(
     '$delete_first_consent_user'::uuid
   );" \
  "select public.create_or_update_member_consent_with_profile(
     '$delete_first_consent_user'::uuid,
     0,
     true,
     true,
     $terms_version,
     true,
     $privacy_version,
     'DeleteFirst',
     'https://avatar.test/delete-first.png',
     'delete-first@test.local'
   );" \
  "bp_qa_delete_first_consent_$$" \
  "bp_qa_consent_after_delete_$$" \
  "true" \
  "invalid_account"
delete_first_consent_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|' || count(m.*)::text
      from public.profiles p
      left join public.member_accounts m on m.user_id = p.id
     where p.id = '$delete_first_consent_user'::uuid
     group by p.deleted_at;
  "
)"
[[ "$delete_first_consent_state" == "true|0" ]] \
  || fail "delete-first consent race created a member row"

# C) Existing-member OAuth seed commits first. Delete waits and then scrubs it.
run_owner_then_waiter \
  "sync-first" \
  "select public.sync_active_member_oauth_profile(
     '$sync_first_user'::uuid,
     'SyncFirst',
     'https://avatar.test/sync-first.png',
     'sync-first@test.local'
   );" \
  "select public.admin_soft_delete_account(
     '$sync_first_user'::uuid
   );" \
  "bp_qa_sync_first_$$" \
  "bp_qa_delete_after_sync_$$" \
  "false" \
  ""
sync_first_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|'
           || (m.email is null)::text || '|'
           || (p.avatar_url is null)::text
      from public.profiles p
      join public.member_accounts m on m.user_id = p.id
     where p.id = '$sync_first_user'::uuid;
  "
)"
[[ "$sync_first_state" == "true|true|true" ]] \
  || fail "sync-first final state retained OAuth PII after deletion"

# D) Delete commits first. A stale callback sync waits and then cannot restore
# member/profile data.
run_owner_then_waiter \
  "delete-first-sync" \
  "select public.admin_soft_delete_account(
     '$delete_first_sync_user'::uuid
   );" \
  "select public.sync_active_member_oauth_profile(
     '$delete_first_sync_user'::uuid,
     'LateSync',
     'https://avatar.test/late-sync.png',
     'late-sync@test.local'
   );" \
  "bp_qa_delete_first_sync_$$" \
  "bp_qa_sync_after_delete_$$" \
  "true" \
  "invalid_account"
delete_first_sync_state="$(
  db_value "
    select (p.deleted_at is not null)::text || '|'
           || (m.email is null)::text || '|'
           || (p.avatar_url is null)::text
      from public.profiles p
      join public.member_accounts m on m.user_id = p.id
     where p.id = '$delete_first_sync_user'::uuid;
  "
)"
[[ "$delete_first_sync_state" == "true|true|true" ]] \
  || fail "delete-first sync race restored OAuth PII"

echo "consent/profile/delete race QA passed:"
echo "  consent-first: delete waited and scrubbed committed consent"
echo "  delete-first: consent waited, then invalid_account + no member"
echo "  sync-first: delete waited and scrubbed OAuth PII"
echo "  delete-first sync: stale callback waited, then invalid_account"
