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
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-legal-race.XXXXXX"
)"
owner_pid=""
waiter_pid=""
admin_id=""
doc_type=""

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
  if [[ "$admin_id" =~ ^[0-9a-f-]{36}$ ]]; then
    if ! db_psql -q -c "
      begin;
      delete from public.legal_operation_receipts
       where admin_user_id = '$admin_id'::uuid;
      delete from public.legal_documents_audit
       where admin_user_id = '$admin_id'::uuid;
      delete from public.legal_documents
       where created_by = '$admin_id'::uuid;
      delete from public.member_accounts
       where user_id = '$admin_id'::uuid;
      delete from auth.users
       where id = '$admin_id'::uuid;
      commit;
    " >"$qa_tmp_dir/cleanup.out" 2>&1; then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      db_value "
        select
          (
            select pg_catalog.count(*)
              from public.legal_operation_receipts
             where admin_user_id = '$admin_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.legal_documents_audit
             where admin_user_id = '$admin_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.legal_documents
             where created_by = '$admin_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.member_accounts
             where user_id = '$admin_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from public.profiles
             where id = '$admin_id'::uuid
          )
          + (
            select pg_catalog.count(*)
              from auth.users
             where id = '$admin_id'::uuid
          );
      " 2>>"$qa_tmp_dir/cleanup.out"
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "legal state-machine race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
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
  echo "legal state-machine race QA failed: $*" >&2
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
  for _ in $(seq 1 160); do
    count="$(
      db_value "
        select count(*)
          from pg_catalog.pg_stat_activity
         where application_name = '$app_name'
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

new_uuid() {
  db_value "select gen_random_uuid();"
}

catalog_ok="$(
  db_value "
    select (
      to_regprocedure(
        'public.admin_save_legal_draft(text,text,jsonb,text,text,uuid,uuid,timestamptz)'
      ) is not null
      and to_regprocedure(
        'public.admin_publish_legal(text,date,uuid,uuid,uuid,timestamptz)'
      ) is not null
      and to_regprocedure(
        'public.admin_unpublish_legal(text,uuid,uuid,uuid,integer)'
      ) is not null
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "0081 is not applied; run npm run qa:db:apply first"

# Avoid altering any pre-existing draft/reservation. Current and historical
# published rows are harmless: fixture versions are tracked by admin identity
# and removed in cleanup.
doc_type="$(
  db_value "
    select candidate
      from (values ('terms'), ('privacy')) d(candidate)
     where not exists (
       select 1
         from public.legal_documents l
        where l.doc_type = candidate
          and (
            l.status = 'draft'
            or (
              l.status = 'published'
              and l.effective_date >
                (clock_timestamp() at time zone 'Asia/Seoul')::date
            )
          )
     )
     order by candidate
     limit 1;
  "
)"
[[ "$doc_type" == "terms" || "$doc_type" == "privacy" ]] \
  || fail "both legal document types already have a draft or reservation"

admin_id="$(new_uuid)"
[[ "$admin_id" =~ ^[0-9a-f-]{36}$ ]] \
  || fail "PostgreSQL returned an invalid admin UUID"
db_psql -q -c "
  insert into auth.users(id, email)
  values (
    '$admin_id'::uuid,
    'legal-race-$admin_id@example.test'
  );
  insert into public.member_accounts(user_id, gen_credits, is_admin)
  values ('$admin_id'::uuid, 0, true);
" >/dev/null

initial_save_op="$(new_uuid)"
initial_save="$(
  db_value "
    select public.admin_save_legal_draft(
      '$doc_type',
      'Initial race draft',
      '[{\"heading\":\"Race\",\"body\":\"Initial\"}]'::jsonb,
      null,
      null,
      '$admin_id'::uuid,
      '$initial_save_op'::uuid,
      null
    );
  "
)"
draft_id="$(
  db_value "select ('$initial_save'::jsonb->>'draft_id')::uuid;"
)"
base_zero="$(
  db_value "select '$initial_save'::jsonb->>'draft_updated_at';"
)"
[[ "$draft_id" =~ ^[0-9a-f-]{36}$ && -n "$base_zero" ]] \
  || fail "initial strict save returned malformed identity"

# A) save -> publish: publish read an old revision, waits on the same advisory
# lock, then fails CAS. The newly saved draft must not be deleted.
owner_app="bp_qa_legal_save_owner_$$"
waiter_app="bp_qa_legal_publish_waiter_$$"
save_op="$(new_uuid)"
publish_op="$(new_uuid)"
mkfifo "$qa_tmp_dir/save-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/save-owner.fifo" \
  >"$qa_tmp_dir/save-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/save-owner.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_save_legal_draft(
    '$doc_type',
    'Concurrent save wins',
    '[{\"heading\":\"Race\",\"body\":\"Saved before publish\"}]'::jsonb,
    null,
    null,
    '$admin_id'::uuid,
    '$save_op'::uuid,
    '$base_zero'::timestamptz
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "save transaction to retain its legal advisory lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.admin_publish_legal(
    '$doc_type',
    (clock_timestamp() at time zone 'Asia/Seoul')::date,
    '$admin_id'::uuid,
    '$publish_op'::uuid,
    '$draft_id'::uuid,
    '$base_zero'::timestamptz
  );
" >"$qa_tmp_dir/publish-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "stale publish to block behind save"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "save-first owner transaction failed"
owner_pid=""
if wait "$waiter_pid"; then
  fail "stale publish unexpectedly succeeded after concurrent save"
fi
waiter_pid=""
grep -q "version_conflict" "$qa_tmp_dir/publish-waiter.out" \
  || fail "stale publish did not fail with version_conflict"
save_first_state="$(
  db_value "
    select count(*)::text || '|' || min(title)
      from public.legal_documents
     where doc_type = '$doc_type'
       and status = 'draft'
       and created_by = '$admin_id'::uuid;
  "
)"
[[ "$save_first_state" == "1|Concurrent save wins" ]] \
  || fail "save-first race lost or corrupted the committed draft"

# B) publish -> save: save waits, then sees the draft was consumed and fails
# CAS. It must not recreate a stale editor snapshot after publish.
base_one="$(
  db_value "
    select updated_at::text
      from public.legal_documents
     where id = '$draft_id'::uuid;
  "
)"
owner_app="bp_qa_legal_publish_owner_$$"
waiter_app="bp_qa_legal_save_waiter_$$"
publish_op="$(new_uuid)"
stale_save_op="$(new_uuid)"
mkfifo "$qa_tmp_dir/publish-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/publish-owner.fifo" \
  >"$qa_tmp_dir/publish-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/publish-owner.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_publish_legal(
    '$doc_type',
    (clock_timestamp() at time zone 'Asia/Seoul')::date,
    '$admin_id'::uuid,
    '$publish_op'::uuid,
    '$draft_id'::uuid,
    '$base_one'::timestamptz
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "publish transaction to retain its legal advisory lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.admin_save_legal_draft(
    '$doc_type',
    'Stale editor resurrection',
    '[{\"heading\":\"Race\",\"body\":\"Must not return\"}]'::jsonb,
    null,
    null,
    '$admin_id'::uuid,
    '$stale_save_op'::uuid,
    '$base_one'::timestamptz
  );
" >"$qa_tmp_dir/save-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "stale save to block behind publish"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "publish-first owner transaction failed"
owner_pid=""
if wait "$waiter_pid"; then
  fail "stale save unexpectedly recreated a consumed draft"
fi
waiter_pid=""
grep -q "version_conflict" "$qa_tmp_dir/save-waiter.out" \
  || fail "publish-first stale save did not fail with version_conflict"
publish_first_state="$(
  db_value "
    select
      count(*) filter (where status = 'draft')::text
      || '|' ||
      count(*) filter (
        where status = 'published' and title = 'Concurrent save wins'
      )::text
      from public.legal_documents
     where doc_type = '$doc_type'
       and created_by = '$admin_id'::uuid;
  "
)"
[[ "$publish_first_state" == "0|1" ]] \
  || fail "publish-first race did not preserve exactly the published snapshot"

# Create a future reservation, then exercise both orderings with save.
future_save_op="$(new_uuid)"
future_save="$(
  db_value "
    select public.admin_save_legal_draft(
      '$doc_type',
      'Reserved content',
      '[{\"heading\":\"Race\",\"body\":\"Reservation\"}]'::jsonb,
      null,
      null,
      '$admin_id'::uuid,
      '$future_save_op'::uuid,
      null
    );
  "
)"
future_publish_op="$(new_uuid)"
future_publish="$(
  db_value "
    select public.admin_publish_legal(
      '$doc_type',
      ((clock_timestamp() at time zone 'Asia/Seoul')::date + 31),
      '$admin_id'::uuid,
      '$future_publish_op'::uuid,
      ('$future_save'::jsonb->>'draft_id')::uuid,
      ('$future_save'::jsonb->>'draft_updated_at')::timestamptz
    );
  "
)"
reservation_id="$(
  db_value "select '$future_publish'::jsonb->>'published_id';"
)"
reservation_version="$(
  db_value "select '$future_publish'::jsonb->>'version';"
)"

# C) save -> unpublish: unpublish waits and must preserve the newer draft
# instead of restoring the older reservation over it.
owner_app="bp_qa_legal_save_before_unpublish_$$"
waiter_app="bp_qa_legal_unpublish_waiter_$$"
concurrent_save_op="$(new_uuid)"
unpublish_op="$(new_uuid)"
mkfifo "$qa_tmp_dir/save-before-unpublish.fifo"
db_psql -qAt <"$qa_tmp_dir/save-before-unpublish.fifo" \
  >"$qa_tmp_dir/save-before-unpublish.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/save-before-unpublish.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_save_legal_draft(
    '$doc_type',
    'New draft survives unpublish',
    '[{\"heading\":\"Race\",\"body\":\"Newer than reservation\"}]'::jsonb,
    null,
    null,
    '$admin_id'::uuid,
    '$concurrent_save_op'::uuid,
    null
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "save-before-unpublish transaction"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.admin_unpublish_legal(
    '$doc_type',
    '$admin_id'::uuid,
    '$unpublish_op'::uuid,
    '$reservation_id'::uuid,
    '$reservation_version'::integer
  );
" >"$qa_tmp_dir/unpublish-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "unpublish to block behind a newer draft save"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "save-before-unpublish owner failed"
owner_pid=""
wait "$waiter_pid" || fail "unpublish waiter failed"
waiter_pid=""
save_unpublish_state="$(
  db_value "
    select
      count(*) filter (
        where status = 'draft' and title = 'New draft survives unpublish'
      )::text
      || '|' ||
      count(*) filter (where id = '$reservation_id'::uuid)::text
      from public.legal_documents
     where doc_type = '$doc_type';
  "
)"
[[ "$save_unpublish_state" == "1|0" ]] \
  || fail "unpublish overwrote the newer draft or retained its reservation"

# Publish that draft as another reservation so unpublish can win the reverse
# ordering with no draft present.
new_draft_id="$(
  db_value "
    select id
      from public.legal_documents
     where doc_type = '$doc_type'
       and status = 'draft'
       and created_by = '$admin_id'::uuid;
  "
)"
new_draft_base="$(
  db_value "
    select updated_at::text
      from public.legal_documents
     where id = '$new_draft_id'::uuid;
  "
)"
second_future_publish_op="$(new_uuid)"
second_future="$(
  db_value "
    select public.admin_publish_legal(
      '$doc_type',
      ((clock_timestamp() at time zone 'Asia/Seoul')::date + 41),
      '$admin_id'::uuid,
      '$second_future_publish_op'::uuid,
      '$new_draft_id'::uuid,
      '$new_draft_base'::timestamptz
    );
  "
)"
second_reservation_id="$(
  db_value "select '$second_future'::jsonb->>'published_id';"
)"
second_reservation_version="$(
  db_value "select '$second_future'::jsonb->>'version';"
)"

# D) unpublish -> save: the stale no-draft save waits, then fails CAS rather
# than overwriting the restored reservation snapshot.
owner_app="bp_qa_legal_unpublish_owner_$$"
waiter_app="bp_qa_legal_save_after_unpublish_$$"
second_unpublish_op="$(new_uuid)"
stale_empty_save_op="$(new_uuid)"
mkfifo "$qa_tmp_dir/unpublish-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/unpublish-owner.fifo" \
  >"$qa_tmp_dir/unpublish-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/unpublish-owner.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.admin_unpublish_legal(
    '$doc_type',
    '$admin_id'::uuid,
    '$second_unpublish_op'::uuid,
    '$second_reservation_id'::uuid,
    '$second_reservation_version'::integer
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "unpublish transaction to retain its legal advisory lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.admin_save_legal_draft(
    '$doc_type',
    'Stale empty editor',
    '[{\"heading\":\"Race\",\"body\":\"Must not overwrite restore\"}]'::jsonb,
    null,
    null,
    '$admin_id'::uuid,
    '$stale_empty_save_op'::uuid,
    null
  );
" >"$qa_tmp_dir/save-after-unpublish.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "stale no-draft save to block behind unpublish"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "unpublish-first owner transaction failed"
owner_pid=""
if wait "$waiter_pid"; then
  fail "stale no-draft save overwrote the restored reservation"
fi
waiter_pid=""
grep -q "version_conflict" "$qa_tmp_dir/save-after-unpublish.out" \
  || fail "unpublish-first stale save did not fail with version_conflict"
unpublish_first_state="$(
  db_value "
    select
      count(*) filter (
        where status = 'draft' and title = 'New draft survives unpublish'
      )::text
      || '|' ||
      count(*) filter (where id = '$second_reservation_id'::uuid)::text
      from public.legal_documents
     where doc_type = '$doc_type';
  "
)"
[[ "$unpublish_first_state" == "1|0" ]] \
  || fail "unpublish-first race did not preserve exactly its restored draft"

# E) An operation UUID is global, not scoped to doc_type. Different document
# locks must still converge on one receipt instead of racing into a raw unique
# violation.
if [[ "$doc_type" == "terms" ]]; then
  other_doc_type="privacy"
else
  other_doc_type="terms"
fi
shared_operation_id="$(new_uuid)"
owner_app="bp_qa_legal_operation_owner_$$"
waiter_app="bp_qa_legal_operation_waiter_$$"
mkfifo "$qa_tmp_dir/operation-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/operation-owner.fifo" \
  >"$qa_tmp_dir/operation-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/operation-owner.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select public.bp_legal_operation_replay(
    '$shared_operation_id'::uuid,
    '$doc_type',
    'save_draft',
    '{\"request\":\"one\"}'::jsonb,
    '$admin_id'::uuid
  );
  select public.bp_record_legal_operation(
    '$shared_operation_id'::uuid,
    '$doc_type',
    'save_draft',
    '{\"request\":\"one\"}'::jsonb,
    '{\"ok\":true}'::jsonb,
    '$admin_id'::uuid
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "operation receipt owner to retain its global advisory lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.bp_legal_operation_replay(
    '$shared_operation_id'::uuid,
    '$other_doc_type',
    'save_draft',
    '{\"request\":\"two\"}'::jsonb,
    '$admin_id'::uuid
  );
" >"$qa_tmp_dir/operation-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "conflicting cross-document operation UUID to block globally"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "operation receipt owner transaction failed"
owner_pid=""
if wait "$waiter_pid"; then
  fail "conflicting cross-document operation UUID unexpectedly replayed"
fi
waiter_pid=""
grep -q "request_conflict" "$qa_tmp_dir/operation-waiter.out" \
  || fail "global operation collision did not fail as request_conflict"
receipt_count="$(
  db_value "
    select count(*)
      from public.legal_operation_receipts
     where operation_id = '$shared_operation_id'::uuid;
  "
)"
[[ "$receipt_count" == "1" ]] \
  || fail "global operation race did not retain exactly one receipt"

echo "legal state-machine race QA passed: transition/order races=5"
