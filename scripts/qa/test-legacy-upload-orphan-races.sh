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

db_container="supabase_db_${project_id}"
if [[ "$db_container" != supabase_db_* ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-upload-orphan-race.XXXXXX"
)"
owner_pid=""
waiter_pid=""
event_reference_first=""
event_cleanup_first=""
path_reference_first=""
path_cleanup_first=""
control_floor=""
control_enabled=""
control_window_end=""
bucket_preexisting=""

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"
}

db_value() {
  db_psql -Atq -c "$1"
}

cleanup() {
  set +e
  exec 3>&-
  for pid in "$owner_pid" "$waiter_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if [[ "$event_reference_first" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$event_cleanup_first" =~ ^[0-9a-f-]{36}$ ]] \
    && [[ "$path_reference_first" =~ ^[0-9]{6}/[0-9a-f-]{36}\.png$ ]] \
    && [[ "$path_cleanup_first" =~ ^[0-9]{6}/[0-9a-f-]{36}\.png$ ]]; then
    db_psql -q -c "
        begin;
        set local session_replication_role = replica;
        delete from public.events
         where id in (
           '$event_reference_first'::uuid,
           '$event_cleanup_first'::uuid
         );
        delete from public.storage_upload_intents
         where bucket = 'events'
           and path in ('$path_reference_first', '$path_cleanup_first');
        delete from public.storage_legacy_upload_protections
         where bucket = 'events'
           and path in ('$path_reference_first', '$path_cleanup_first');
        delete from storage.objects
         where bucket_id = 'events'
           and name in ('$path_reference_first', '$path_cleanup_first');
        commit;
      " >/dev/null 2>&1
  fi
  if [[ -n "$control_floor" && -n "$control_enabled" \
    && -n "$control_window_end" ]] \
    && [[ "$control_floor" != *"'"* ]] \
    && [[ "$control_enabled" != *"'"* ]] \
    && [[ "$control_window_end" != *"'"* ]]; then
    db_psql -q -c "
        update public.storage_legacy_upload_sweep_control
           set inventory_floor_at = '$control_floor'::timestamptz,
               enabled_at = '$control_enabled'::timestamptz,
               window_ends_at = '$control_window_end'::timestamptz
         where singleton = true;
      " >/dev/null 2>&1
  fi
  if [[ "$bucket_preexisting" == "false" ]]; then
    db_psql -q -c "
      begin;
      set local session_replication_role = replica;
      delete from storage.buckets
       where id = 'events'
         and not exists (
           select 1 from storage.objects where bucket_id = 'events'
         );
      commit;
    " >/dev/null 2>&1
  fi
  rm -f "$qa_tmp_dir"/*
  rmdir "$qa_tmp_dir" >/dev/null 2>&1
}
trap cleanup EXIT INT TERM

fail() {
  echo "legacy upload orphan race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
      tail -n 40 "$output" >&2
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

catalog_ok="$(
  db_value "
    select (
      to_regprocedure(
        'public.enqueue_legacy_signed_upload_orphans(integer)'
      ) is not null
      and exists (
        select 1
          from public.storage_legacy_upload_sweep_control
         where singleton = true
           and enabled_at is not null
      )
    )::text;
  "
)"
[[ "$catalog_ok" == "true" ]] \
  || fail "008899/0092 is not applied; run npm run qa:db:apply first"

IFS='|' read -r control_floor control_enabled control_window_end <<<"$(
  db_value "
    select inventory_floor_at::text || '|' ||
           enabled_at::text || '|' ||
           window_ends_at::text
      from public.storage_legacy_upload_sweep_control
     where singleton = true;
  "
)"
[[ -n "$control_floor" && -n "$control_enabled" \
  && -n "$control_window_end" ]] \
  || fail "could not snapshot the rollout sweep control"

event_reference_first="$(db_value "select gen_random_uuid();")"
event_cleanup_first="$(db_value "select gen_random_uuid();")"
upload_reference_first="$(db_value "select gen_random_uuid();")"
upload_cleanup_first="$(db_value "select gen_random_uuid();")"
for id in \
  "$event_reference_first" "$event_cleanup_first" \
  "$upload_reference_first" "$upload_cleanup_first"; do
  [[ "$id" =~ ^[0-9a-f-]{36}$ ]] \
    || fail "PostgreSQL returned an invalid UUID"
done
path_reference_first="260729/${upload_reference_first}.png"
path_cleanup_first="260729/${upload_cleanup_first}.png"

bucket_preexisting="$(
  db_value "select exists(select 1 from storage.buckets where id='events');"
)"
db_psql -q -c "
  insert into storage.buckets(id, name, public)
  values ('events', 'events', true)
  on conflict (id) do nothing;
  update public.storage_legacy_upload_sweep_control
     set inventory_floor_at =
           transaction_timestamp() - interval '1 day',
         enabled_at = transaction_timestamp() - interval '1 hour',
         window_ends_at =
           transaction_timestamp() + interval '1 hour 5 minutes'
   where singleton = true;
  insert into storage.objects(bucket_id, name, created_at, updated_at)
  values (
    'events',
    '$path_reference_first',
    transaction_timestamp() - interval '4 hours',
    transaction_timestamp() - interval '4 hours'
  );
" >/dev/null

# A) Reference wins the shared path lock. The scanner must wait, re-read the
# committed reference, and persist a protection instead of a cleanup receipt.
owner_app="bp_qa_upload_reference_owner_$$"
waiter_app="bp_qa_upload_scan_waiter_$$"
mkfifo "$qa_tmp_dir/reference-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/reference-owner.fifo" \
  >"$qa_tmp_dir/reference-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/reference-owner.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'storage-path:events:$path_reference_first',
      0
    )
  );
  insert into public.events(
    id, type, status, title, summary, body, cover_image_path
  )
  values (
    '$event_reference_first'::uuid,
    'notice',
    'draft',
    'reference-first race',
    'reference-first race',
    'reference-first race',
    '$path_reference_first'
  );
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "reference-first transaction to retain the path lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  select public.enqueue_legacy_signed_upload_orphans(10);
" >"$qa_tmp_dir/reference-scan-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "scanner to wait behind the committed reference"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "reference-first owner transaction failed"
owner_pid=""
wait "$waiter_pid" || fail "reference-first scanner failed"
waiter_pid=""
reference_state="$(
  db_value "
    select
      (select count(*) from public.events
        where id = '$event_reference_first'::uuid)::text || '|' ||
      (select count(*) from public.storage_upload_intents
        where bucket = 'events'
          and path = '$path_reference_first')::text || '|' ||
      (select count(*) from public.storage_legacy_upload_protections
        where bucket = 'events'
          and path = '$path_reference_first')::text;
  "
)"
[[ "$reference_state" == "1|0|1" ]] \
  || fail "reference-first ordering did not converge to reference+protection"

db_psql -q -c "
  insert into storage.objects(bucket_id, name, created_at, updated_at)
  values (
    'events',
    '$path_cleanup_first',
    transaction_timestamp() - interval '4 hours',
    transaction_timestamp() - interval '4 hours'
  );
" >/dev/null

# B) Scanner wins the same lock and writes a fenced pending receipt. The later
# attach must wait and then fail; no DB reference may point at the doomed file.
owner_app="bp_qa_upload_scan_owner_$$"
waiter_app="bp_qa_upload_attach_waiter_$$"
mkfifo "$qa_tmp_dir/scan-owner.fifo"
db_psql -qAt <"$qa_tmp_dir/scan-owner.fifo" \
  >"$qa_tmp_dir/scan-owner.out" 2>&1 &
owner_pid="$!"
exec 3>"$qa_tmp_dir/scan-owner.fifo"
printf "%s\n" "
  set application_name = '$owner_app';
  set statement_timeout = '15s';
  begin;
  select pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'storage-path:events:$path_cleanup_first',
      0
    )
  );
  select public.enqueue_legacy_signed_upload_orphans(10);
" >&3
wait_for_activity \
  "$owner_app" \
  "state = 'idle in transaction' and xact_start is not null" \
  "cleanup-first transaction to retain the path lock"

db_psql -qAt -c "
  set application_name = '$waiter_app';
  set statement_timeout = '15s';
  insert into public.events(
    id, type, status, title, summary, body, cover_image_path
  )
  values (
    '$event_cleanup_first'::uuid,
    'notice',
    'draft',
    'cleanup-first race',
    'cleanup-first race',
    'cleanup-first race',
    '$path_cleanup_first'
  );
" >"$qa_tmp_dir/attach-waiter.out" 2>&1 &
waiter_pid="$!"
wait_for_activity \
  "$waiter_app" \
  "state = 'active' and wait_event_type = 'Lock'" \
  "attach to wait behind the cleanup receipt"

printf "commit;\n\\q\n" >&3
exec 3>&-
wait "$owner_pid" || fail "cleanup-first owner transaction failed"
owner_pid=""
if wait "$waiter_pid"; then
  fail "cleanup-first attach unexpectedly committed"
fi
waiter_pid=""
grep -q "upload_cleanup_in_progress" "$qa_tmp_dir/attach-waiter.out" \
  || fail "cleanup-first attach did not fail with upload_cleanup_in_progress"
cleanup_state="$(
  db_value "
    select
      (select count(*) from public.events
        where id = '$event_cleanup_first'::uuid)::text || '|' ||
      (select status from public.storage_upload_intents
        where bucket = 'events'
          and path = '$path_cleanup_first')::text || '|' ||
      (select count(*) from public.storage_legacy_upload_protections
        where bucket = 'events'
          and path = '$path_cleanup_first')::text;
  "
)"
[[ "$cleanup_state" == "0|pending|0" ]] \
  || fail "cleanup-first ordering did not converge to a lone pending receipt"

echo "legacy upload orphan race QA passed"
echo "  reference→scan: committed reference protected, no cleanup receipt"
echo "  scan→reference: pending fenced receipt won, later attach rejected"
