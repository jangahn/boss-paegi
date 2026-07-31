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

read_state() {
  docker exec "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc "
      with post_contract_functions as (
        select pg_catalog.string_agg(
                 pg_catalog.concat_ws(
                   '|',
                   p.oid::regprocedure::text,
                   p.prosrc,
                   p.proconfig::text,
                   p.proacl::text,
                   p.prosecdef::text,
                   p.provolatile::text,
                   p.proisstrict::text,
                   p.proparallel::text
                 ),
                 E'\n'
                 order by p.oid::regprocedure::text
               ) as fingerprint_source,
               pg_catalog.count(*) as function_count
          from pg_catalog.pg_proc p
         where p.oid = any(array[
           pg_catalog.to_regprocedure(
             'public.telemetry_rollup_days(integer)'
           ),
           pg_catalog.to_regprocedure(
             'public.maintain_analytics_rollups(integer)'
           ),
           pg_catalog.to_regprocedure(
             'public.prune_analytics_events(integer)'
           ),
           pg_catalog.to_regprocedure(
             'public.telemetry_prune()'
           ),
           pg_catalog.to_regprocedure(
             'public.admin_dismiss_report(uuid,uuid,text)'
           ),
           pg_catalog.to_regprocedure(
             'public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)'
           ),
           pg_catalog.to_regprocedure(
             'public.legal_sections_valid(jsonb)'
           ),
           pg_catalog.to_regprocedure(
             'public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)'
           ),
           pg_catalog.to_regprocedure(
             'public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)'
           ),
           pg_catalog.to_regprocedure(
             'public.release_generation_preflight(uuid,uuid,uuid,text)'
           )
         ])
      )
      select pg_catalog.concat_ws(
        '|',
        pg_catalog.encode(
          pg_catalog.sha256(
            pg_catalog.convert_to(fingerprint_source, 'UTF8')
          ),
          'hex'
        ),
        function_count::text,
        (
          select pg_catalog.count(*)::text
            from public.schema_migration_journal
           where version =
             '0095_analytics_maintenance_argument_bounds'
        )
      )
        from post_contract_functions;
    "
}

contract_ready="$(
  docker exec "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres -Atc "
      select (
        not pg_catalog.has_function_privilege(
          'service_role',
          'public.reassign_anon_data(uuid,uuid)',
          'EXECUTE'
        )
        and not pg_catalog.has_function_privilege(
          'service_role',
          'public.consume_legacy_signup_migration(uuid,uuid,uuid,timestamptz,timestamptz)',
          'EXECUTE'
        )
      )::text;
    "
)"
if [[ "$contract_ready" != "true" ]]; then
  echo "0095 raw-guard test requires the completed 0094 contract stage" >&2
  exit 1
fi

before_state="$(read_state)"
if [[ "$before_state" != *"|10|0" ]]; then
  echo "0095 raw-guard precondition is not the exact ten-function, no-receipt state" >&2
  exit 1
fi

set +e
raw_output="$(
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
    < supabase/migrations/0095_analytics_maintenance_argument_bounds.sql \
    2>&1
)"
raw_status=$?
set -e
if (( raw_status == 0 )); then
  echo "raw 0095 unexpectedly bypassed the staged runner" >&2
  exit 1
fi
if [[ "$raw_output" != *"0095 requires the staged post-contract runner"* ]]; then
  echo "raw 0095 failed for an unexpected reason" >&2
  exit 1
fi

after_state="$(read_state)"
if [[ "$after_state" != "$before_state" ]]; then
  echo "raw 0095 failure did not roll back every mutation and receipt" >&2
  exit 1
fi

echo "Raw 0095 staged-runner guard PASS"
