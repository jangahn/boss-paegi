#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

if (( $# != 0 )); then
  echo "usage: $0" >&2
  exit 2
fi

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
if [[ ! "$project_id" =~ ^[A-Za-z0-9][A-Za-z0-9_-]*$ ]]; then
  echo "Supabase project_id is missing or unsafe" >&2
  exit 1
fi

default_db_container="supabase_db_${project_id}"
db_container="${QA_DB_CONTAINER:-$default_db_container}"
if [[ "$db_container" != "$default_db_container" ]] \
  && [[ "$db_container" != "$default_db_container"-* ]] \
  && [[ "$db_container" != "$default_db_container"_* ]]; then
  echo "QA_DB_CONTAINER must be the local project container or its disposable derivative" >&2
  exit 2
fi
if ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi
if [[ "$(docker inspect -f '{{.State.Running}}' "$db_container")" != "true" ]]; then
  echo "disposable local Supabase database container is stopped: $db_container" >&2
  exit 1
fi
container_image="$(docker inspect -f '{{.Config.Image}}' "$db_container")"
if [[ "$container_image" != *"supabase/postgres"* ]]; then
  echo "refusing non-Supabase PostgreSQL container: $db_container" >&2
  exit 1
fi

db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 2
fi

qa_tmp_dir="$(
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-oauth-catalog-locks.XXXXXX"
)"
holder_output="$qa_tmp_dir/holder.out"
holder_pid=""
holder_app="boss_paegi_oauth_catalog_mutation_locks_qa"
fixture_session_id="00000000-0000-4000-8000-00000000c093"
explicit_publication="bp_qa_oauth_catalog_lock_explicit"
all_tables_publication="bp_qa_oauth_catalog_lock_all_tables"
schema_publication="bp_qa_oauth_catalog_lock_schema"
blocked_count=0
immediate_count=0
excluded_count=0

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" "$@"
}

db_value() {
  db_psql -Atq -c "$1"
}

terminate_holder() {
  db_psql -v holder_app="$holder_app" -Atq <<'SQL' \
    >/dev/null 2>&1 || true
select pg_catalog.pg_terminate_backend(activity.pid)
  from pg_catalog.pg_stat_activity activity
 where activity.application_name = :'holder_app'
   and activity.pid <> pg_catalog.pg_backend_pid();
SQL
  if [[ -n "$holder_pid" ]]; then
    wait "$holder_pid" >/dev/null 2>&1 || true
    holder_pid=""
  fi
}

cleanup() {
  original_status=$?
  trap - EXIT INT TERM
  set +e
  cleanup_failed=0

  terminate_holder

  cleanup_residue="$(
    db_value "
      select pg_catalog.concat_ws(
        '|',
        (
          not exists (
            select 1
              from pg_catalog.pg_roles role_row
             where role_row.rolname =
                   'bp_oauth_catalog_lock_sentinel'
          )
        )::text,
        (
          not exists (
            select 1
              from public.oauth_auth_session_id_tombstones tombstone
             where tombstone.session_id =
                   '$fixture_session_id'::uuid
          )
        )::text,
        (
          not exists (
            select 1
              from pg_catalog.pg_publication publication
             where publication.pubname in (
               '$explicit_publication',
               '$all_tables_publication',
               '$schema_publication'
             )
          )
        )::text,
        (
          not exists (
            select 1
              from pg_catalog.pg_attribute attribute
             where attribute.attrelid =
                   'public.oauth_flow_intents'::pg_catalog.regclass
               and attribute.attname =
                   'bp_qa_catalog_lock_probe'
               and not attribute.attisdropped
          )
        )::text
      );
    " 2>"$qa_tmp_dir/cleanup.out"
  )" || cleanup_failed=1
  if [[ "$cleanup_residue" != "true|true|true|true" ]]; then
    cleanup_failed=1
  fi

  if (( cleanup_failed != 0 )); then
    echo "OAuth catalog mutation lock QA cleanup failed (residue=${cleanup_residue:-unknown})" >&2
    if [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
      tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
    fi
  fi
  rm -f "$qa_tmp_dir"/*.out
  if ! rmdir "$qa_tmp_dir" >/dev/null 2>&1; then
    cleanup_failed=1
    echo "OAuth catalog mutation lock QA temp cleanup failed" >&2
  fi

  if (( cleanup_failed != 0 && original_status == 0 )); then
    exit 1
  fi
  exit "$original_status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

fail() {
  echo "OAuth catalog mutation lock QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
      tail -n 30 "$output" >&2
    fi
  done
  exit 1
}

catalog_residue_snapshot() {
  db_psql -Atq <<'SQL'
with catalog_rows(catalog_row) as (
  select pg_catalog.format(
           'relation|%I.%I|owner=%s|kind=%s|acl=%s',
           namespace.nspname,
           relation.relname,
           pg_catalog.pg_get_userbyid(relation.relowner),
           relation.relkind,
           coalesce(relation.relacl::text, '<null>')
         )
    from pg_catalog.pg_class relation
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
   where namespace.nspname in ('auth', 'public')
  union all
  select pg_catalog.format(
           'column|%I.%I|%s|%I|acl=%s',
           namespace.nspname,
           relation.relname,
           attribute.attnum,
           attribute.attname,
           coalesce(attribute.attacl::text, '<null>')
         )
    from pg_catalog.pg_attribute attribute
    join pg_catalog.pg_class relation
      on relation.oid = attribute.attrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
   where namespace.nspname in ('auth', 'public')
     and attribute.attnum > 0
  union all
  select pg_catalog.format(
           'type|%I.%I|owner=%s|kind=%s|acl=%s',
           namespace.nspname,
           type_row.typname,
           pg_catalog.pg_get_userbyid(type_row.typowner),
           type_row.typtype,
           coalesce(type_row.typacl::text, '<null>')
         )
    from pg_catalog.pg_type type_row
    join pg_catalog.pg_namespace namespace
      on namespace.oid = type_row.typnamespace
   where namespace.nspname in ('auth', 'public')
  union all
  select pg_catalog.format(
           'function|%I.%I(%s)|owner=%s|acl=%s|config=%s',
           namespace.nspname,
           procedure.proname,
           pg_catalog.pg_get_function_identity_arguments(procedure.oid),
           pg_catalog.pg_get_userbyid(procedure.proowner),
           coalesce(procedure.proacl::text, '<null>'),
           coalesce(procedure.proconfig::text, '<null>')
         )
    from pg_catalog.pg_proc procedure
    join pg_catalog.pg_namespace namespace
      on namespace.oid = procedure.pronamespace
   where namespace.nspname = 'public'
  union all
  select pg_catalog.format(
           'publication|%I|owner=%s|all=%s|i=%s|u=%s|d=%s|t=%s|root=%s',
           publication.pubname,
           pg_catalog.pg_get_userbyid(publication.pubowner),
           publication.puballtables,
           publication.pubinsert,
           publication.pubupdate,
           publication.pubdelete,
           publication.pubtruncate,
           publication.pubviaroot
         )
    from pg_catalog.pg_publication publication
  union all
  select pg_catalog.format(
           'publication_relation|%I|%I.%I|attrs=%s|qual=%s',
           publication.pubname,
           namespace.nspname,
           relation.relname,
           coalesce(
             publication_relation.prattrs::text,
             '<null>'
           ),
           coalesce(
             pg_catalog.pg_get_expr(
               publication_relation.prqual,
               publication_relation.prrelid
             ),
             '<null>'
           )
         )
    from pg_catalog.pg_publication_rel publication_relation
    join pg_catalog.pg_publication publication
      on publication.oid = publication_relation.prpubid
    join pg_catalog.pg_class relation
      on relation.oid = publication_relation.prrelid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = relation.relnamespace
  union all
  select pg_catalog.format(
           'publication_schema|%I|%I',
           publication.pubname,
           namespace.nspname
         )
    from pg_catalog.pg_publication_namespace publication_namespace
    join pg_catalog.pg_publication publication
      on publication.oid = publication_namespace.pnpubid
    join pg_catalog.pg_namespace namespace
      on namespace.oid = publication_namespace.pnnspid
  union all
  select pg_catalog.format(
           'role|%I|super=%s|create_role=%s|replication=%s',
           role_row.rolname,
           role_row.rolsuper,
           role_row.rolcreaterole,
           role_row.rolreplication
         )
    from pg_catalog.pg_roles role_row
   where role_row.rolname = 'bp_oauth_catalog_lock_sentinel'
  union all
  select pg_catalog.format(
           'fixture|%s|%s|%s',
           tombstone.session_id,
           tombstone.tombstoned_at,
           tombstone.reason
         )
    from public.oauth_auth_session_id_tombstones tombstone
   where tombstone.session_id =
         '00000000-0000-4000-8000-00000000c093'::uuid
)
select pg_catalog.encode(
         pg_catalog.sha256(
           pg_catalog.convert_to(
             coalesce(
               pg_catalog.string_agg(
                 catalog_row,
                 E'\n'
                 order by catalog_row
               ),
               ''
             ),
             'UTF8'
           )
         ),
         'hex'
       )
  from catalog_rows;
SQL
}

expect_lock_timeout() {
  label="$1"
  mutation_sql="$2"
  output="$qa_tmp_dir/${label}.out"

  if {
    printf '%s\n' \
      "\\set ON_ERROR_STOP on" \
      "begin;" \
      "set local lock_timeout = '400ms';" \
      "set local statement_timeout = '4s';" \
      "$mutation_sql" \
      "rollback;"
  } | db_psql -q >"$output" 2>&1; then
    fail "$label unexpectedly bypassed the catalog mutation fence"
  fi
  if ! grep -Fq "canceling statement due to lock timeout" "$output"; then
    fail "$label failed for a reason other than the holder lock"
  fi
  blocked_count=$((blocked_count + 1))
}

safety="$(
  db_value "
    select pg_catalog.concat_ws(
      '|',
      (pg_catalog.inet_server_addr() is null)::text,
      (pg_catalog.current_database() = '$db_name')::text,
      (current_user = '$db_user')::text,
      role_row.rolsuper::text,
      role_row.rolcreaterole::text,
      role_row.rolreplication::text,
      role_row.rolbypassrls::text
    )
      from pg_catalog.pg_roles role_row
     where role_row.rolname = current_user;
  "
)"
if [[ "$safety" != "true|true|true|false|true|true|true" ]]; then
  fail "requires the local socket and Supabase managed non-superuser postgres role"
fi

catalog_ready="$(
  db_value "
    select pg_catalog.concat_ws(
      '|',
      (
        pg_catalog.to_regclass(
          'public.oauth_flow_intents'
        ) is not null
      )::text,
      (
        pg_catalog.to_regprocedure(
          'public.guard_oauth_critical_relation_truncate()'
        ) is not null
      )::text,
      (
        not exists (
          select 1
            from pg_catalog.pg_roles role_row
           where role_row.rolname =
                 'bp_oauth_catalog_lock_sentinel'
        )
      )::text,
      (
        not exists (
          select 1
            from public.oauth_auth_session_id_tombstones tombstone
           where tombstone.session_id =
                 '$fixture_session_id'::uuid
        )
      )::text,
      (
        not exists (
          select 1
            from pg_catalog.pg_publication publication
           where publication.pubname in (
             '$explicit_publication',
             '$all_tables_publication',
             '$schema_publication'
           )
        )
      )::text,
      (
        not exists (
          select 1
            from pg_catalog.pg_stat_activity activity
           where activity.application_name = '$holder_app'
        )
      )::text
    );
  "
)"
if [[ "$catalog_ready" != "true|true|true|true|true|true" ]]; then
  fail "0093 catalog baseline or isolated QA namespace is not clean"
fi

existing_publication="$(
  db_value "
    select publication.pubname
      from pg_catalog.pg_publication publication
     where publication.pubowner = (
       select role_row.oid
         from pg_catalog.pg_roles role_row
        where role_row.rolname = current_user
     )
       and publication.pubname ~ '^[A-Za-z_][A-Za-z0-9_]*$'
     order by publication.pubname
     limit 1;
  "
)"
if [[ ! "$existing_publication" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]; then
  fail "a postgres-owned existing publication is required"
fi
existing_publication_via_root="$(
  db_value "
    select publication.pubviaroot::text
      from pg_catalog.pg_publication publication
     where publication.pubname = '$existing_publication';
  "
)"
if [[ "$existing_publication_via_root" == "true" ]]; then
  toggled_publication_via_root="false"
elif [[ "$existing_publication_via_root" == "false" ]]; then
  toggled_publication_via_root="true"
else
  fail "existing publication has an invalid partition-root flag"
fi

baseline_snapshot="$(catalog_residue_snapshot)"
if [[ ! "$baseline_snapshot" =~ ^[0-9a-f]{64}$ ]]; then
  fail "could not capture the exact preflight catalog residue snapshot"
fi

catalog_locks_sql="$(
  node --input-type=module -e '
    import { readFile } from "node:fs/promises";
    import {
      catalogMutationLocksSql,
      readOAuthCatalogFunctionManifest,
    } from "./scripts/qa/apply-oauth-production-rollout.mjs";

    const [
      expandSql,
      scoreSubmissionIntegritySql,
      userMutationLockOrderSql,
    ] = await Promise.all([
      readFile(
        "./supabase/migrations/0093_oauth_flow_intents.sql",
        "utf8",
      ),
      readFile(
        "./supabase/migrations/0074_score_submission_integrity.sql",
        "utf8",
      ),
      readFile(
        "./supabase/migrations/0084_user_mutation_lock_order.sql",
        "utf8",
      ),
    ]);
    const manifest = readOAuthCatalogFunctionManifest(
      expandSql,
      {
        scoreSubmissionIntegritySql,
        userMutationLockOrderSql,
      },
    );
    process.stdout.write(catalogMutationLocksSql(manifest));
  '
)"
if [[ -z "$catalog_locks_sql" ]] \
  || [[ "$catalog_locks_sql" != *"boss-paegi:oauth-catalog-mutation-lock"* ]] \
  || [[ "$catalog_locks_sql" != *"bp_oauth_catalog_lock_sentinel"* ]]; then
  fail "source-derived OAuth catalog mutation lock SQL is malformed"
fi

{
  printf '%s\n' \
    "\\set ON_ERROR_STOP on" \
    "begin;" \
    "set local lock_timeout = '5s';" \
    "set local statement_timeout = '90s';"
  printf '%s\n' "$catalog_locks_sql"
  printf '%s\n' \
    "select pg_catalog.pg_sleep(60);" \
    "rollback;"
} | docker exec -e PGAPPNAME="$holder_app" -i "$db_container" \
      psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" \
      >"$holder_output" 2>&1 &
holder_pid=$!

holder_ready="false"
for _ in $(seq 1 200); do
  holder_ready="$(
    db_value "
      select exists (
        select 1
          from pg_catalog.pg_stat_activity activity
         where activity.application_name = '$holder_app'
           and activity.state = 'active'
           and activity.wait_event = 'PgSleep'
      )::text;
    "
  )"
  if [[ "$holder_ready" == "true" ]]; then
    break
  fi
  if ! kill -0 "$holder_pid" >/dev/null 2>&1; then
    fail "holder exited before acquiring every source-derived lock"
  fi
  sleep 0.05
done
if [[ "$holder_ready" != "true" ]]; then
  fail "holder did not reach its rollback-only proof window"
fi

select_result="$(
  db_psql -Atq <<'SQL'
set statement_timeout = '1s';
select case
  when pg_catalog.count(*) >= 0 then 'select_ok'
  else 'select_invalid'
end
  from public.oauth_flow_intents;
SQL
)" || fail "a normal new SELECT connection was blocked"
if [[ "$select_result" != "select_ok" ]]; then
  fail "normal SELECT connection returned an unexpected result"
fi
immediate_count=$((immediate_count + 1))

insert_result="$(
  db_psql -Atq <<SQL
begin;
set local lock_timeout = '400ms';
set local statement_timeout = '1s';
insert into public.oauth_auth_session_id_tombstones (
  session_id,
  tombstoned_at,
  reason
) values (
  '$fixture_session_id'::uuid,
  pg_catalog.clock_timestamp(),
  'flow_source'
);
select case
  when exists (
    select 1
      from public.oauth_auth_session_id_tombstones tombstone
     where tombstone.session_id = '$fixture_session_id'::uuid
  )
  then 'insert_ok'
  else 'insert_missing'
end;
rollback;
SQL
)" || fail "a rollback-only INSERT was blocked"
if [[ "$insert_result" != "insert_ok" ]]; then
  fail "rollback-only INSERT returned an unexpected result"
fi
immediate_count=$((immediate_count + 1))

expect_lock_timeout \
  "alter_table" \
  "alter table public.oauth_flow_intents
     add column bp_qa_catalog_lock_probe bigint;"
expect_lock_timeout \
  "relation_grant" \
  "grant select on table public.oauth_flow_intents
     to authenticated;"
expect_lock_timeout \
  "column_grant" \
  "grant select (state) on table public.oauth_flow_intents
     to authenticated;"
expect_lock_timeout \
  "composite_type_grant" \
  "grant usage on type public.oauth_flow_intents
     to authenticated;"
expect_lock_timeout \
  "function_grant" \
  "grant execute on function
     public.guard_oauth_critical_relation_truncate()
     to authenticated;"
expect_lock_timeout \
  "function_alter" \
  "alter function public.guard_oauth_critical_relation_truncate()
     cost 101;"
expect_lock_timeout \
  "existing_publication_alter" \
  "alter publication $existing_publication
     set (publish_via_partition_root =
       $toggled_publication_via_root);"
expect_lock_timeout \
  "explicit_table_publication_create" \
  "create publication $explicit_publication
     for table only public.oauth_flow_intents
     with (publish = 'insert');"

all_tables_result="$(
  db_psql -Atq <<SQL
begin;
set local lock_timeout = '400ms';
set local statement_timeout = '2s';
create publication $all_tables_publication
  for all tables
  with (publish = 'insert');
select case
  when exists (
    select 1
      from pg_catalog.pg_publication publication
     where publication.pubname = '$all_tables_publication'
       and publication.puballtables
       and publication.pubinsert
       and not publication.pubupdate
       and not publication.pubdelete
       and not publication.pubtruncate
  )
  then 'bypass_ok'
  else 'bypass_invalid'
end;
rollback;
SQL
)" || fail "managed postgres could not demonstrate the FOR ALL TABLES exclusion"
if [[ "$all_tables_result" != "bypass_ok" ]]; then
  fail "FOR ALL TABLES exclusion returned an unexpected result"
fi
excluded_count=$((excluded_count + 1))

schema_result="$(
  db_psql -Atq <<SQL
begin;
set local lock_timeout = '400ms';
set local statement_timeout = '2s';
create publication $schema_publication
  for tables in schema public
  with (publish = 'insert');
select case
  when exists (
    select 1
      from pg_catalog.pg_publication publication
      join pg_catalog.pg_publication_namespace publication_namespace
        on publication_namespace.pnpubid = publication.oid
     where publication.pubname = '$schema_publication'
       and publication_namespace.pnnspid =
             'public'::pg_catalog.regnamespace
       and not publication.puballtables
       and publication.pubinsert
       and not publication.pubupdate
       and not publication.pubdelete
       and not publication.pubtruncate
  )
  then 'bypass_ok'
  else 'bypass_invalid'
end;
rollback;
SQL
)" || fail "managed postgres could not demonstrate the schema-publication exclusion"
if [[ "$schema_result" != "bypass_ok" ]]; then
  fail "FOR TABLES IN SCHEMA exclusion returned an unexpected result"
fi
excluded_count=$((excluded_count + 1))

if ! kill -0 "$holder_pid" >/dev/null 2>&1; then
  fail "holder ended before all concurrent mutation proofs completed"
fi
if [[ "$immediate_count" != "2" ]] \
  || [[ "$blocked_count" != "8" ]] \
  || [[ "$excluded_count" != "2" ]]; then
  fail "proof inventory mismatch"
fi

terminate_holder

postflight_snapshot="$(catalog_residue_snapshot)"
if [[ "$postflight_snapshot" != "$baseline_snapshot" ]]; then
  fail "role, ACL, function config, publication, or fixture residue changed"
fi
postflight_clean="$(
  db_value "
    select pg_catalog.concat_ws(
      '|',
      (
        not exists (
          select 1
            from pg_catalog.pg_roles role_row
           where role_row.rolname =
                 'bp_oauth_catalog_lock_sentinel'
        )
      )::text,
      (
        not exists (
          select 1
            from public.oauth_auth_session_id_tombstones tombstone
           where tombstone.session_id =
                 '$fixture_session_id'::uuid
        )
      )::text,
      (
        not exists (
          select 1
            from pg_catalog.pg_publication publication
           where publication.pubname in (
             '$explicit_publication',
             '$all_tables_publication',
             '$schema_publication'
           )
        )
      )::text,
      (
        not exists (
          select 1
            from pg_catalog.pg_attribute attribute
           where attribute.attrelid =
                 'public.oauth_flow_intents'::pg_catalog.regclass
             and attribute.attname =
                 'bp_qa_catalog_lock_probe'
             and not attribute.attisdropped
        )
      )::text
    );
  "
)"
if [[ "$postflight_clean" != "true|true|true|true" ]]; then
  fail "rollback residue postflight failed"
fi

echo "OAuth catalog mutation lock PASS: immediate=2 blocked=8 excluded_noncooperative_privileged_actor=2"
