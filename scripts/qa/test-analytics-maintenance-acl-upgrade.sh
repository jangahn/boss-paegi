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
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-analytics-acl-upgrade.XXXXXX"
)"
migration_output="$qa_tmp_dir/migration.out"
fixture_role="boss_paegi_0095_acl_upgrade_qa_$$"
fixture_owned=0

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" "$@"
}

drop_fixture_role() {
  db_psql -v fixture_role="$fixture_role" -Atq <<'SQL' \
    >/dev/null 2>&1 || true
select pg_catalog.format(
  'revoke all privileges on function %s from %I',
  procedure.oid::pg_catalog.regprocedure,
  :'fixture_role'
)
  from pg_catalog.pg_proc procedure
  cross join lateral pg_catalog.aclexplode(
    coalesce(
      procedure.proacl,
      pg_catalog.acldefault('f', procedure.proowner)
    )
  ) acl
 where acl.grantee = pg_catalog.to_regrole(:'fixture_role')
 group by procedure.oid
\gexec
select pg_catalog.format(
  'drop role %I',
  :'fixture_role'
)
 where pg_catalog.to_regrole(:'fixture_role') is not null
\gexec
SQL
}

cleanup() {
  original_status=$?
  trap - EXIT INT TERM
  set +e
  cleanup_failed=0

  if (( fixture_owned == 1 )); then
    drop_fixture_role
  fi
  role_residue="$(
    db_psql -v fixture_role="$fixture_role" -Atq <<'SQL' 2>/dev/null
select (pg_catalog.to_regrole(:'fixture_role') is not null)::int;
SQL
  )" || cleanup_failed=1
  if [[ "${role_residue:-unknown}" != "0" ]]; then
    cleanup_failed=1
    echo \
      "analytics maintenance ACL-upgrade QA role cleanup failed (residue=${role_residue:-unknown})" \
      >&2
  fi

  rm -f "$migration_output"
  if ! rmdir "$qa_tmp_dir" >/dev/null 2>&1; then
    cleanup_failed=1
    echo "analytics maintenance ACL-upgrade QA temp cleanup failed" >&2
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
  echo "analytics maintenance ACL-upgrade QA failed: $*" >&2
  if [[ -s "$migration_output" ]]; then
    echo "--- migration.out" >&2
    tail -n 50 "$migration_output" >&2
  fi
  exit 1
}

catalog_ready="$(
  db_psql -Atq <<'SQL'
with required(signature) as (
  values
    ('public.telemetry_rollup_days(integer)'),
    ('public.telemetry_prune()'),
    ('public.maintain_analytics_rollups(integer)'),
    ('public.prune_analytics_events(integer)'),
    ('public.admin_dismiss_report(uuid,uuid,text)'),
    ('public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)'),
    ('public.legal_sections_valid(jsonb)'),
    ('public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)'),
    ('public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)'),
    ('public.release_generation_preflight(uuid,uuid,uuid,text)')
)
select pg_catalog.concat_ws(
  '|',
  (count(*) = 10)::text,
  pg_catalog.bool_and(
    pg_catalog.to_regprocedure(signature) is not null
  )::text
)
  from required;
SQL
)"
if [[ "$catalog_ready" != "true|true" ]]; then
  fail "0094-stage RPC catalog is incomplete ($catalog_ready)"
fi

role_absent="$(
  db_psql -v fixture_role="$fixture_role" -Atq <<'SQL'
select pg_catalog.to_regrole(:'fixture_role') is null;
SQL
)"
if [[ "$role_absent" != "t" ]]; then
  fail "throwaway ACL role unexpectedly exists before the test"
fi

db_psql -v fixture_role="$fixture_role" -Atq <<'SQL' >/dev/null
create role :"fixture_role" nologin noinherit;

grant execute on function public.telemetry_rollup_days(integer)
  to :"fixture_role" with grant option;
grant execute on function public.telemetry_prune()
  to :"fixture_role" with grant option;
grant execute on function public.maintain_analytics_rollups(integer)
  to :"fixture_role" with grant option;
grant execute on function public.prune_analytics_events(integer)
  to :"fixture_role" with grant option;
grant execute on function public.admin_dismiss_report(uuid,uuid,text)
  to :"fixture_role" with grant option;
grant execute on function
  public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)
  to :"fixture_role" with grant option;
grant execute on function public.legal_sections_valid(jsonb)
  to :"fixture_role" with grant option;
grant execute on function
  public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)
  to :"fixture_role" with grant option;
grant execute on function
  public.record_generation_preflight_result(
    uuid,uuid,uuid,text,text,text,jsonb,text
  )
  to :"fixture_role" with grant option;
grant execute on function
  public.release_generation_preflight(uuid,uuid,uuid,text)
  to :"fixture_role" with grant option;
SQL
fixture_owned=1

seeded_grants="$(
  db_psql -v fixture_role="$fixture_role" -Atq <<'SQL'
with required(signature) as (
  values
    ('public.telemetry_rollup_days(integer)'),
    ('public.telemetry_prune()'),
    ('public.maintain_analytics_rollups(integer)'),
    ('public.prune_analytics_events(integer)'),
    ('public.admin_dismiss_report(uuid,uuid,text)'),
    ('public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)'),
    ('public.legal_sections_valid(jsonb)'),
    ('public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)'),
    ('public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)'),
    ('public.release_generation_preflight(uuid,uuid,uuid,text)')
),
fixture_acl as (
  select procedure.oid,
         acl.privilege_type,
         acl.is_grantable
    from required
    join pg_catalog.pg_proc procedure
      on procedure.oid = pg_catalog.to_regprocedure(required.signature)
    cross join lateral pg_catalog.aclexplode(
      coalesce(
        procedure.proacl,
        pg_catalog.acldefault('f', procedure.proowner)
      )
    ) acl
   where acl.grantee = pg_catalog.to_regrole(:'fixture_role')
)
select pg_catalog.concat_ws(
  '|',
  (count(*) = 10)::text,
  pg_catalog.bool_and(privilege_type = 'EXECUTE')::text,
  pg_catalog.bool_and(is_grantable)::text
)
  from fixture_acl;
SQL
)"
if [[ "$seeded_grants" != "true|true|true" ]]; then
  fail "WITH GRANT OPTION fixture did not cover all ten RPCs ($seeded_grants)"
fi

if ! (
  BOSS_PAEGI_LOCAL_ANALYTICS_MAINTENANCE_BOUNDS_FIXTURE=1 \
    node scripts/qa/render-local-analytics-maintenance-bounds.mjs \
    | docker exec -i "$db_container" \
        psql -X -v ON_ERROR_STOP=1 \
          -U "$db_user" \
          -d "$db_name"
) >"$migration_output" 2>&1; then
  fail "authorized rendered 0095 application failed"
fi

db_psql -v fixture_role="$fixture_role" -Atq <<'SQL' >/dev/null
select pg_catalog.set_config(
  'boss_paegi.qa_acl_fixture_role',
  :'fixture_role',
  false
);
do $qa$
declare
  v_signature text;
  v_function_oid oid;
  v_service_role_oid oid := pg_catalog.to_regrole('service_role');
  v_fixture_role_oid oid := pg_catalog.to_regrole(
    pg_catalog.current_setting('boss_paegi.qa_acl_fixture_role')
  );
begin
  if v_service_role_oid is null or v_fixture_role_oid is null then
    raise exception 'expected QA ACL roles are missing';
  end if;

  foreach v_signature in array array[
    'public.telemetry_rollup_days(integer)',
    'public.telemetry_prune()',
    'public.maintain_analytics_rollups(integer)',
    'public.prune_analytics_events(integer)'
  ]
  loop
    v_function_oid := pg_catalog.to_regprocedure(v_signature);
    if not exists (
      select 1
        from pg_catalog.pg_proc procedure
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) acl
       where procedure.oid = v_function_oid
         and acl.grantee = v_service_role_oid
         and acl.privilege_type = 'EXECUTE'
         and not acl.is_grantable
    )
    or exists (
      select 1
        from pg_catalog.pg_proc procedure
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) acl
       where procedure.oid = v_function_oid
         and acl.privilege_type = 'EXECUTE'
         and acl.grantee not in (
           procedure.proowner,
           v_service_role_oid
         )
    ) then
      raise exception 'maintenance exact ACL mismatch after 0095: %',
        v_signature;
    end if;
  end loop;

  foreach v_signature in array array[
    'public.admin_dismiss_report(uuid,uuid,text)',
    'public.admin_settle_stuck_order_idempotent(uuid,uuid,text,uuid)',
    'public.legal_sections_valid(jsonb)',
    'public.record_generation_pick_provider_result(uuid,uuid,uuid,text,text)',
    'public.record_generation_preflight_result(uuid,uuid,uuid,text,text,text,jsonb,text)',
    'public.release_generation_preflight(uuid,uuid,uuid,text)'
  ]
  loop
    v_function_oid := pg_catalog.to_regprocedure(v_signature);
    if exists (
      select 1
        from pg_catalog.pg_proc procedure
        cross join lateral pg_catalog.aclexplode(
          coalesce(
            procedure.proacl,
            pg_catalog.acldefault('f', procedure.proowner)
          )
        ) acl
       where procedure.oid = v_function_oid
         and acl.privilege_type = 'EXECUTE'
         and acl.grantee <> procedure.proowner
    ) then
      raise exception 'superseded RPC residual ACL after 0095: %',
        v_signature;
    end if;
  end loop;

  if exists (
    select 1
      from pg_catalog.pg_proc procedure
      cross join lateral pg_catalog.aclexplode(
        coalesce(
          procedure.proacl,
          pg_catalog.acldefault('f', procedure.proowner)
        )
      ) acl
     where procedure.oid = any(array[
       pg_catalog.to_regprocedure(
         'public.telemetry_rollup_days(integer)'
       ),
       pg_catalog.to_regprocedure(
         'public.telemetry_prune()'
       ),
       pg_catalog.to_regprocedure(
         'public.maintain_analytics_rollups(integer)'
       ),
       pg_catalog.to_regprocedure(
         'public.prune_analytics_events(integer)'
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
       and acl.grantee = v_fixture_role_oid
  ) then
    raise exception 'throwaway role retained an ACL after 0095';
  end if;
end;
$qa$;
SQL

drop_fixture_role
fixture_owned=0

role_absent="$(
  db_psql -v fixture_role="$fixture_role" -Atq <<'SQL'
select pg_catalog.to_regrole(:'fixture_role') is null;
SQL
)"
if [[ "$role_absent" != "t" ]]; then
  fail "throwaway ACL role remains after successful cleanup"
fi

echo \
  "analytics maintenance ACL-upgrade QA passed: 10 WITH GRANT OPTION fixtures removed exactly"
