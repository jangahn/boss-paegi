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

default_db_container="supabase_db_${project_id}"
db_container="${QA_DB_CONTAINER:-$default_db_container}"
if [[ "$db_container" != "$default_db_container" ]] \
  && [[ "$db_container" != "$default_db_container"-* ]] \
  && [[ "$db_container" != "$default_db_container"_* ]]; then
  echo "QA_DB_CONTAINER must be the local project container or its disposable derivative" >&2
  exit 2
fi
if ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "local Supabase database container is not running: $db_container" >&2
  exit 1
fi

if docker exec -i "$db_container" \
  psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
  < supabase/migrations/0094_oauth_flow_migration_contract.sql \
  >/dev/null 2>&1; then
  echo "raw 0094 unexpectedly bypassed provider qualification" >&2
  exit 1
fi

postcondition="$(
  docker exec "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc "
      select pg_catalog.concat_ws(
        '|',
        (
          pg_catalog.to_regprocedure(
            'public.assert_oauth_rollout_deployment_qualification(text)'
          ) is not null
        )::text,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.reassign_anon_data(uuid,uuid)',
          'EXECUTE'
        )::text,
        pg_catalog.has_function_privilege(
          'service_role',
          'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)',
          'EXECUTE'
        )::text,
        (
          select pg_catalog.count(*)::text
            from public.oauth_rollout_deployment_qualifications
        ),
        (
          pg_catalog.obj_description(
            'public.reassign_anon_data(uuid,uuid)'::regprocedure,
            'pg_proc'
          ) is null
        )::text,
        (
          pg_catalog.obj_description(
            'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)'::regprocedure,
            'pg_proc'
          ) is null
        )::text
      );
    "
)"
if [[ "$postcondition" != "true|true|true|0|true|true" ]]; then
  echo "raw 0094 failure did not roll back every contract mutation" >&2
  exit 1
fi

echo "Raw 0094 qualification guard PASS"
