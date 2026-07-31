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
db_user="${QA_DB_USER:-supabase_admin}"
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 2
fi

psql_safety="$(
  docker exec "$db_container" \
    psql -X -qAt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" \
    -c "
      select pg_catalog.concat_ws(
        '|',
        (pg_catalog.inet_server_addr() is null)::text,
        (pg_catalog.current_database() = '$db_name')::text,
        coalesce(
          (
            select role_row.rolsuper::text
              from pg_catalog.pg_roles role_row
             where role_row.rolname = current_user
          ),
          'false'
        )
      );
    "
)"
if [[ "$psql_safety" != "true|true|true" ]]; then
  echo "fingerprint tamper QA requires a local socket, exact DB, and superuser" >&2
  exit 1
fi

fingerprint_ctes="$(
  node --input-type=module -e '
    import {
      renderOAuthRelationFingerprintCtes,
    } from "./scripts/qa/oauth-relation-fingerprints.mjs";
    process.stdout.write(renderOAuthRelationFingerprintCtes());
  '
)"
expected_relation_count="$(
  node --input-type=module -e '
    import {
      OAUTH_CATALOG_RELATION_NAMES,
    } from "./scripts/qa/oauth-relation-fingerprints.mjs";
    process.stdout.write(String(OAUTH_CATALOG_RELATION_NAMES.length));
  '
)"
if [[ ! "$expected_relation_count" =~ ^[1-9][0-9]*$ ]]; then
  echo "OAuth relation fingerprint inventory is empty or invalid" >&2
  exit 1
fi
expected_fingerprints="$(
  node --input-type=module -e '
    import {
      OAUTH_CATALOG_RELATION_NAMES,
      OAUTH_EXPECTED_RELATION_FINGERPRINTS,
    } from "./scripts/qa/oauth-relation-fingerprints.mjs";
    process.stdout.write(
      OAUTH_CATALOG_RELATION_NAMES.map(
        (relationName) =>
          `${relationName}|${
            OAUTH_EXPECTED_RELATION_FINGERPRINTS[relationName]
          }`,
      ).join("\n"),
    );
  '
)"

discover_fingerprints() {
  node scripts/qa/oauth-relation-fingerprints.mjs --discover \
    | docker exec -i "$db_container" \
        psql -X -qAt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name"
}

baseline_fingerprints="$(discover_fingerprints)"
if [[ "$baseline_fingerprints" != "$expected_fingerprints" ]]; then
  echo "relation fingerprint baseline does not match the source manifest" >&2
  exit 1
fi
repeat_fingerprints="$(discover_fingerprints)"
if [[ "$repeat_fingerprints" != "$baseline_fingerprints" ]]; then
  echo "relation fingerprints are nondeterministic across identical sessions" >&2
  exit 1
fi
baseline_line_count="$(
  printf '%s\n' "$baseline_fingerprints" \
    | awk 'NF { count += 1 } END { print count + 0 }'
)"
if [[ "$baseline_line_count" != "$expected_relation_count" ]]; then
  echo "relation fingerprint discovery count mismatch" >&2
  exit 1
fi
if ! printf '%s\n' "$baseline_fingerprints" \
  | awk -F '|' '
      NF != 2 || $1 !~ /^public[.][a-z0-9_]+$/ ||
        $2 !~ /^[0-9a-f]{64}$/ { bad = 1 }
      END { exit bad }
    '; then
  echo "relation fingerprint discovery output is malformed" >&2
  exit 1
fi

hostile_fingerprints="$(
  {
    printf '%s\n' \
      "set search_path = auth, public, pg_catalog;" \
      "set TimeZone = 'Pacific/Honolulu';" \
      "set DateStyle = 'German, DMY';" \
      "set IntervalStyle = 'sql_standard';" \
      "set bytea_output = 'escape';" \
      "set extra_float_digits = '-1';" \
      "set quote_all_identifiers = 'on';" \
      "set standard_conforming_strings = 'off';"
    node scripts/qa/oauth-relation-fingerprints.mjs --discover
  } | docker exec -i "$db_container" \
        psql -X -qAt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name"
)"
if [[ "$hostile_fingerprints" != "$baseline_fingerprints" ]]; then
  echo "relation fingerprints depend on hostile session settings" >&2
  exit 1
fi

emit_inventory_readiness() {
  printf '%s\n' \
    "with $fingerprint_ctes" \
    "select 1 / case" \
    "  when pg_catalog.count(*) = $expected_relation_count" \
    "   and pg_catalog.bool_and(" \
    "     (catalog_document ->> 'exists')::boolean" \
    "   )" \
    "   and pg_catalog.bool_and(" \
    "     catalog_document #>> '{class,kind}' = 'r'" \
    "   )" \
    "  then 1 else 0 end" \
    "  from relation_catalog_documents;"
}

emit_global_baseline_capture() {
  printf '%s\n' \
    "with $fingerprint_ctes" \
    "insert into pg_temp.bp_qa_oauth_relation_fingerprint_baseline (" \
    "  relation_name," \
    "  catalog_sha256" \
    ")" \
    "select relation_name, catalog_sha256" \
    "  from actual_relation_fingerprints;"
}

emit_case_baseline_capture() {
  local label="$1"
  local relation_name="$2"
  printf '%s\n' \
    "with $fingerprint_ctes" \
    "insert into pg_temp.bp_qa_oauth_relation_fingerprint_case (" \
    "  case_label," \
    "  catalog_sha256" \
    ")" \
    "select '$label', catalog_sha256" \
    "  from actual_relation_fingerprints" \
    " where relation_name = '$relation_name';"
}

emit_changed_assertion() {
  local relation_name="$1"
  local baseline_table="$2"
  local baseline_key_column="$3"
  local baseline_key="$4"
  printf '%s\n' \
    "with $fingerprint_ctes" \
    "select 1 / case" \
    "  when (" \
    "    select pg_catalog.count(*)" \
    "      from actual_relation_fingerprints" \
    "     where relation_name = '$relation_name'" \
    "  ) = 1" \
    "   and (" \
    "    select pg_catalog.count(*)" \
    "      from pg_temp.$baseline_table" \
    "     where $baseline_key_column = '$baseline_key'" \
    "  ) = 1" \
    "   and (" \
    "    select catalog_sha256" \
    "      from actual_relation_fingerprints" \
    "     where relation_name = '$relation_name'" \
    "  ) is distinct from (" \
    "    select catalog_sha256" \
    "      from pg_temp.$baseline_table" \
    "     where $baseline_key_column = '$baseline_key'" \
    "  )" \
    "  then 1 else 0 end;"
}

emit_restored_assertion() {
  local relation_name="$1"
  printf '%s\n' \
    "with $fingerprint_ctes" \
    "select 1 / case" \
    "  when (" \
    "    select pg_catalog.count(*)" \
    "      from actual_relation_fingerprints" \
    "     where relation_name = '$relation_name'" \
    "  ) = 1" \
    "   and (" \
    "    select catalog_sha256" \
    "      from actual_relation_fingerprints" \
    "     where relation_name = '$relation_name'" \
    "  ) = (" \
    "    select catalog_sha256" \
    "      from pg_temp.bp_qa_oauth_relation_fingerprint_baseline" \
    "     where relation_name = '$relation_name'" \
    "  )" \
    "  then 1 else 0 end;"
}

emit_global_case() {
  local relation_name="$1"
  local mutation_sql="$2"
  printf 'begin;\n%s\n' "$mutation_sql"
  emit_changed_assertion \
    "$relation_name" \
    "bp_qa_oauth_relation_fingerprint_baseline" \
    "relation_name" \
    "$relation_name"
  printf 'rollback;\n'
  emit_restored_assertion "$relation_name"
}

emit_seeded_case() {
  local label="$1"
  local relation_name="$2"
  local setup_sql="$3"
  local mutation_sql="$4"
  printf 'begin;\n%s\n' "$setup_sql"
  emit_case_baseline_capture "$label" "$relation_name"
  printf '%s\n' "$mutation_sql"
  emit_changed_assertion \
    "$relation_name" \
    "bp_qa_oauth_relation_fingerprint_case" \
    "case_label" \
    "$label"
  printf 'rollback;\n'
  emit_restored_assertion "$relation_name"
}

{
  printf '%s\n' \
    "\\set ON_ERROR_STOP on" \
    "\\o /dev/null" \
    "select pg_catalog.pg_advisory_lock(" \
    "  pg_catalog.hashtextextended(" \
    "    'boss-paegi:oauth-relation-fingerprint-tamper'," \
    "    0" \
    "  )" \
    ");" \
    "create temporary table" \
    "  bp_qa_oauth_relation_fingerprint_baseline (" \
    "    relation_name text primary key," \
    "    catalog_sha256 text not null" \
    "  ) on commit preserve rows;" \
    "create temporary table" \
    "  bp_qa_oauth_relation_fingerprint_case (" \
    "    case_label text primary key," \
    "    catalog_sha256 text not null" \
    "  ) on commit preserve rows;"
  emit_inventory_readiness
  emit_global_baseline_capture

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "alter table public.oauth_auth_session_id_tombstones
       add column bp_qa_fingerprint_extra bigint;"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "alter table public.oauth_auth_session_id_tombstones
       alter column tombstoned_at
       set default '2000-01-01T00:00:00Z'::pg_catalog.timestamptz;"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "grant select (session_id)
       on public.oauth_auth_session_id_tombstones
       to authenticated;"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "grant usage
       on type public.oauth_auth_session_id_tombstones
       to authenticated;"

  emit_global_case \
    "public.oauth_flow_intents" \
    "alter table public.oauth_flow_intents
       add constraint bp_qa_fingerprint_exclusion
       exclude using gist (
         pg_catalog.tstzrange(created_at, created_at, '[)') with &&
       );"

  emit_seeded_case \
    "index_option" \
    "public.oauth_flow_intents" \
    "create index bp_qa_fingerprint_probe_idx
       on public.oauth_flow_intents (provider);" \
    "alter index public.bp_qa_fingerprint_probe_idx
       set (fillfactor = 73);"

  emit_seeded_case \
    "index_opclass" \
    "public.oauth_flow_intents" \
    "create index bp_qa_fingerprint_probe_idx
       on public.oauth_flow_intents (provider);" \
    "drop index public.bp_qa_fingerprint_probe_idx;
     create index bp_qa_fingerprint_probe_idx
       on public.oauth_flow_intents (
         provider pg_catalog.text_pattern_ops
       );"

  emit_seeded_case \
    "index_collation" \
    "public.oauth_flow_intents" \
    "create index bp_qa_fingerprint_probe_idx
       on public.oauth_flow_intents (provider);" \
    "drop index public.bp_qa_fingerprint_probe_idx;
     create index bp_qa_fingerprint_probe_idx
       on public.oauth_flow_intents (
         provider collate pg_catalog.\"C\"
       );"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "create function pg_temp.bp_qa_fingerprint_trigger()
       returns trigger
       language plpgsql
       as \$qa\$
       begin
         return new;
       end;
       \$qa\$;
     create trigger bp_qa_fingerprint_extra_trigger
       before insert
       on public.oauth_auth_session_id_tombstones
       for each row
       execute function pg_temp.bp_qa_fingerprint_trigger();"

  emit_seeded_case \
    "internal_trigger_enablement" \
    "public.oauth_flow_intents" \
    "alter table public.oauth_flow_intents
       disable trigger trg_oauth_flow_tombstone_auth_session_ids;" \
    "alter table public.oauth_flow_intents
       disable trigger all;"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "create policy bp_qa_fingerprint_extra_policy
       on public.oauth_auth_session_id_tombstones
       for select
       to authenticated
       using (false);"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "create rule bp_qa_fingerprint_extra_rule
       as on update
       to public.oauth_auth_session_id_tombstones
       do also nothing;"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "create table public.bp_qa_fingerprint_inheritance_child ()
       inherits (public.oauth_auth_session_id_tombstones);"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "create table public.bp_qa_fingerprint_inheritance_parent ();
     alter table public.oauth_auth_session_id_tombstones
       inherit public.bp_qa_fingerprint_inheritance_parent;"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "alter table public.oauth_auth_session_id_tombstones
       set (fillfactor = 71, autovacuum_enabled = false);"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "create publication bp_qa_fingerprint_publication
       for table only public.oauth_auth_session_id_tombstones
       with (publish = 'insert');"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "create publication bp_qa_fingerprint_all_tables
       for all tables
       with (publish = 'insert');"

  emit_global_case \
    "public.oauth_auth_session_id_tombstones" \
    "create publication bp_qa_fingerprint_schema
       for tables in schema public
       with (publish = 'insert');"

  printf '%s\n' \
    "select 1 / case" \
    "  when pg_catalog.count(*) = $expected_relation_count" \
    "  then 1 else 0 end" \
    "  from pg_temp.bp_qa_oauth_relation_fingerprint_baseline;" \
    "select 1 / case" \
    "  when pg_catalog.pg_advisory_unlock(" \
    "    pg_catalog.hashtextextended(" \
    "      'boss-paegi:oauth-relation-fingerprint-tamper'," \
    "      0" \
    "    )" \
    "  )" \
    "  then 1 else 0 end;"
} | docker exec -i "$db_container" \
      psql -X -qAt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name"

postflight_fingerprints="$(discover_fingerprints)"
if [[ "$postflight_fingerprints" != "$baseline_fingerprints" ]]; then
  echo "relation fingerprint tamper QA left catalog residue" >&2
  exit 1
fi

echo "OAuth relation fingerprint tamper PASS: relations=$expected_relation_count cases=18"
