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
  echo "disposable local Supabase database container is not running: $db_container" >&2
  exit 1
fi

db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 2
fi

locked_flow_id="00000000-0000-4000-8000-000000000093"
follower_flow_id="00000000-0000-4000-8000-000000000094"
holder_app="boss_paegi_oauth_prune_lock_qa"
holder_pid=""
fixture_owned=0

psql_qa() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" "$@"
}

terminate_holder() {
  psql_qa -v holder_app="$holder_app" -Aqt <<'SQL' >/dev/null 2>&1 || true
select pg_catalog.pg_terminate_backend(a.pid)
  from pg_catalog.pg_stat_activity a
 where a.application_name = :'holder_app'
   and a.pid <> pg_catalog.pg_backend_pid();
SQL
  if [[ -n "$holder_pid" ]]; then
    wait "$holder_pid" >/dev/null 2>&1 || true
    holder_pid=""
  fi
}

cleanup() {
  terminate_holder
  if (( fixture_owned == 1 )); then
    psql_qa \
      -v locked_flow_id="$locked_flow_id" \
      -v follower_flow_id="$follower_flow_id" \
      -Aqt <<'SQL' >/dev/null 2>&1 || true
delete from public.oauth_flow_intents
 where flow_id in (
   :'locked_flow_id'::uuid,
   :'follower_flow_id'::uuid
 );
SQL
  fi
}
trap cleanup EXIT

fixture_absent="$(
  psql_qa \
    -v locked_flow_id="$locked_flow_id" \
    -v follower_flow_id="$follower_flow_id" \
    -Aqt <<'SQL'
select count(*) = 0
  from public.oauth_flow_intents
 where flow_id in (
   :'locked_flow_id'::uuid,
   :'follower_flow_id'::uuid
 );
SQL
)"
if [[ "$fixture_absent" != "t" ]]; then
  echo "OAuth prune lock fixtures already exist; refusing to delete unowned data" >&2
  exit 1
fi

psql_qa \
  -v locked_flow_id="$locked_flow_id" \
  -v follower_flow_id="$follower_flow_id" \
  -Aqt <<'SQL' >/dev/null
insert into public.oauth_flow_intents (
  flow_id,
  source_user_id,
  source_session_id,
  source_access_token_sha256,
  source_refresh_token_sha256,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  created_at,
  expires_at,
  finished_at
)
select fixture.flow_id,
       fixture.source_user_id,
       fixture.source_session_id,
       fixture.access_digest,
       fixture.refresh_digest,
       false,
       'google',
       '/',
       'cancelled',
       '1900-01-01 00:00:00+00'::timestamptz,
       '1900-01-01 00:10:00+00'::timestamptz,
       '1900-01-01 00:11:00+00'::timestamptz
  from (
    values
      (
        :'locked_flow_id'::uuid,
        '10000000-0000-4000-8000-000000000093'::uuid,
        '20000000-0000-4000-8000-000000000093'::uuid,
        pg_catalog.repeat('a', 64),
        pg_catalog.repeat('b', 64)
      ),
      (
        :'follower_flow_id'::uuid,
        '10000000-0000-4000-8000-000000000094'::uuid,
        '20000000-0000-4000-8000-000000000094'::uuid,
        pg_catalog.repeat('c', 64),
        pg_catalog.repeat('d', 64)
      )
  ) as fixture(
    flow_id,
    source_user_id,
    source_session_id,
    access_digest,
    refresh_digest
  );
SQL
fixture_owned=1

docker exec -e PGAPPNAME="$holder_app" -i "$db_container" \
  psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" \
  -v locked_flow_id="$locked_flow_id" <<'SQL' >/dev/null 2>&1 &
begin;
select pg_catalog.pg_advisory_xact_lock(
  pg_catalog.hashtextextended(
    'oauth-flow:' || :'locked_flow_id',
    0
  )
);
select pg_catalog.pg_sleep(60);
rollback;
SQL
holder_pid=$!

holder_ready="f"
for _ in {1..100}; do
  holder_ready="$(
    psql_qa -v holder_app="$holder_app" -Aqt <<'SQL'
select exists (
  select 1
    from pg_catalog.pg_stat_activity a
   where a.application_name = :'holder_app'
     and a.wait_event = 'PgSleep'
);
SQL
)"
  if [[ "$holder_ready" == "t" ]]; then
    break
  fi
  if ! kill -0 "$holder_pid" >/dev/null 2>&1; then
    echo "OAuth prune lock holder exited before acquiring the fixture fence" >&2
    exit 1
  fi
  sleep 0.1
done
if [[ "$holder_ready" != "t" ]]; then
  echo "OAuth prune lock holder did not become ready" >&2
  exit 1
fi

psql_qa -Aqt <<'SQL' >/dev/null
do $$
declare
  v_ack jsonb;
begin
  v_ack := public.prune_oauth_flow_intents(1);
  if v_ack is distinct from pg_catalog.jsonb_build_object(
    'expiredPending', 0,
    'boundRecoveryConverged', 0,
    'prunedTerminal', 1,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 0,
    'terminalRetentionBacklog', 1,
    'unconsumedMigrationBacklog', 0,
    'unreleasedContinueBacklog', 0,
    'unboundClaimBacklog', 0,
    'boundRecoveryBacklog', 0
  ) then
    raise exception 'locked-head starvation acknowledgement mismatch: %',
      v_ack;
  end if;
  if exists (
    select 1
      from public.oauth_flow_intents
     where flow_id =
       '00000000-0000-4000-8000-000000000094'::uuid
  ) then
    raise exception 'unlocked follower was starved behind locked head';
  end if;
  if not exists (
    select 1
      from public.oauth_flow_intents
     where flow_id =
       '00000000-0000-4000-8000-000000000093'::uuid
  ) then
    raise exception 'locked head was unexpectedly pruned';
  end if;
end;
$$;
SQL

terminate_holder

psql_qa -Aqt <<'SQL' >/dev/null
do $$
declare
  v_ack jsonb;
begin
  v_ack := public.prune_oauth_flow_intents(1);
  if v_ack is distinct from pg_catalog.jsonb_build_object(
    'expiredPending', 0,
    'boundRecoveryConverged', 0,
    'prunedTerminal', 1,
    'targetAuthorityLossConverged', 0,
    'targetAuthorityLossBacklog', 0,
    'pendingExpiryBacklog', 0,
    'terminalRetentionBacklog', 0,
    'unconsumedMigrationBacklog', 0,
    'unreleasedContinueBacklog', 0,
    'unboundClaimBacklog', 0,
    'boundRecoveryBacklog', 0
  ) then
    raise exception 'released terminal prune acknowledgement mismatch: %', v_ack;
  end if;
  if exists (
    select 1
      from public.oauth_flow_intents
     where flow_id =
       '00000000-0000-4000-8000-000000000093'::uuid
  ) then
    raise exception 'released terminal fixture was not pruned';
  end if;
end;
$$;
SQL
fixture_owned=0

echo "OAuth prune locked-head starvation race QA passed"
