#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

if (( $# != 0 )); then
  echo "usage: $0" >&2
  exit 2
fi

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml |
    head -n 1
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

holder_app="boss_paegi_oauth_member_holder_qa"
operation_app="boss_paegi_oauth_member_operation_qa"
holder_pid=""
operation_pid=""
fixture_owned=0
scratch_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-oauth-race.XXXXXX")"
holder_output="$scratch_dir/holder.out"
operation_output="$scratch_dir/operation.out"

psql_qa() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" "$@"
}

# Session-ID tombstones are intentionally permanent, so a repeatable harness
# must never recycle hard-coded UUIDs from an earlier successful/failed run.
fixture_ids="$(
  psql_qa -Aqt -F '|' <<'SQL'
select gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid(),
       gen_random_uuid();
SQL
)"
IFS='|' read -r \
  finalize_flow \
  finalize_source \
  finalize_source_session \
  finalize_target \
  finalize_target_session \
  finalize_score \
  consume_flow \
  consume_source \
  consume_source_session \
  consume_target \
  consume_target_session \
  consume_score <<<"$fixture_ids"

terminate_apps() {
  psql_qa \
    -v holder_app="$holder_app" \
    -v operation_app="$operation_app" \
    -Aqt <<'SQL' >/dev/null 2>&1 || true
select pg_catalog.pg_terminate_backend(a.pid)
  from pg_catalog.pg_stat_activity a
 where a.application_name in (
   :'holder_app',
   :'operation_app'
 )
   and a.pid <> pg_catalog.pg_backend_pid();
SQL
  if [[ -n "$holder_pid" ]]; then
    wait "$holder_pid" >/dev/null 2>&1 || true
    holder_pid=""
  fi
  if [[ -n "$operation_pid" ]]; then
    wait "$operation_pid" >/dev/null 2>&1 || true
    operation_pid=""
  fi
}

cleanup() {
  local original_status=$?
  local cleanup_failed=0
  local cleanup_remaining=""
  terminate_apps
  if (( fixture_owned == 1 )); then
    if ! psql_qa \
      -v finalize_flow="$finalize_flow" \
      -v consume_flow="$consume_flow" \
      -v finalize_source="$finalize_source" \
      -v finalize_target="$finalize_target" \
      -v consume_source="$consume_source" \
      -v consume_target="$consume_target" \
      -v finalize_score="$finalize_score" \
      -v consume_score="$consume_score" \
      -Aqt <<'SQL' >/dev/null 2>&1
begin;
delete from public.oauth_flow_intents
 where flow_id in (
   :'finalize_flow'::uuid,
   :'consume_flow'::uuid
 );
delete from public.scores
 where id in (
   :'finalize_score'::uuid,
   :'consume_score'::uuid
 );
-- The receipt is intentionally append-only in every real execution path.
-- This superuser-only bypass is confined to the disposable local QA database
-- so repeatable race fixtures can be removed without weakening production.
set local session_replication_role = replica;
delete from public.anon_data_reassignments
 where source_user_id in (
   :'finalize_source'::uuid,
   :'consume_source'::uuid
 );
set local session_replication_role = origin;
delete from public.member_accounts
 where user_id in (
   :'finalize_target'::uuid,
   :'consume_target'::uuid
 );
delete from auth.users
 where id in (
   :'finalize_source'::uuid,
   :'finalize_target'::uuid,
   :'consume_source'::uuid,
   :'consume_target'::uuid
 );
commit;
SQL
    then
      cleanup_failed=1
    fi
    if ! cleanup_remaining="$(
      psql_qa \
        -v finalize_flow="$finalize_flow" \
        -v consume_flow="$consume_flow" \
        -v finalize_source="$finalize_source" \
        -v finalize_target="$finalize_target" \
        -v consume_source="$consume_source" \
        -v consume_target="$consume_target" \
        -v finalize_score="$finalize_score" \
        -v consume_score="$consume_score" \
        -Aqt <<'SQL'
select
  (
    select pg_catalog.count(*)
      from public.oauth_flow_intents
     where flow_id in (
       :'finalize_flow'::uuid,
       :'consume_flow'::uuid
     )
  )
  + (
    select pg_catalog.count(*)
      from public.oauth_anon_auth_cleanup_jobs
     where flow_id in (
       :'finalize_flow'::uuid,
       :'consume_flow'::uuid
     )
  )
  + (
    select pg_catalog.count(*)
      from public.scores
     where id in (
       :'finalize_score'::uuid,
       :'consume_score'::uuid
     )
  )
  + (
    select pg_catalog.count(*)
      from public.member_accounts
     where user_id in (
       :'finalize_target'::uuid,
       :'consume_target'::uuid
     )
  )
  + (
    select pg_catalog.count(*)
      from auth.users
     where id in (
       :'finalize_source'::uuid,
       :'finalize_target'::uuid,
       :'consume_source'::uuid,
       :'consume_target'::uuid
     )
  );
SQL
    )"; then
      cleanup_failed=1
    elif [[ "$cleanup_remaining" != "0" ]]; then
      cleanup_failed=1
    fi
  fi
  rm -f "$holder_output" "$operation_output"
  rmdir "$scratch_dir" >/dev/null 2>&1 || true
  if (( cleanup_failed != 0 )); then
    echo \
      "OAuth member-race cleanup failed (remaining=${cleanup_remaining:-unknown})" \
      >&2
    if (( original_status == 0 )); then
      trap - EXIT
      exit 1
    fi
  fi
}
trap cleanup EXIT

fixtures_absent="$(
  psql_qa \
    -v finalize_flow="$finalize_flow" \
    -v consume_flow="$consume_flow" \
    -v finalize_source="$finalize_source" \
    -v finalize_target="$finalize_target" \
    -v finalize_source_session="$finalize_source_session" \
    -v finalize_target_session="$finalize_target_session" \
    -v finalize_score="$finalize_score" \
    -v consume_source="$consume_source" \
    -v consume_target="$consume_target" \
    -v consume_source_session="$consume_source_session" \
    -v consume_target_session="$consume_target_session" \
    -v consume_score="$consume_score" \
    -Aqt <<'SQL'
select not exists (
  select 1
    from public.oauth_flow_intents
   where flow_id in (
     :'finalize_flow'::uuid,
     :'consume_flow'::uuid
   )
)
and not exists (
  select 1
    from auth.users
   where id in (
     :'finalize_source'::uuid,
     :'finalize_target'::uuid,
     :'consume_source'::uuid,
     :'consume_target'::uuid
   )
)
and not exists (
  select 1
    from public.anon_data_reassignments
   where source_user_id in (
     :'finalize_source'::uuid,
     :'consume_source'::uuid
   )
)
and not exists (
  select 1
    from public.oauth_auth_session_id_tombstones
   where session_id in (
     :'finalize_source_session'::uuid,
     :'finalize_target_session'::uuid,
     :'consume_source_session'::uuid,
     :'consume_target_session'::uuid
   )
)
and not exists (
  select 1
    from public.scores
   where id in (
     :'finalize_score'::uuid,
     :'consume_score'::uuid
   )
);
SQL
)"
if [[ "$fixtures_absent" != "t" ]]; then
  echo "OAuth member-race fixture already exists; refusing to delete unowned data" >&2
  exit 1
fi
fixture_owned=1

create_fixture() {
  local flow_id="$1"
  local source_user_id="$2"
  local source_session_id="$3"
  local target_user_id="$4"
  local target_session_id="$5"
  local state="$6"
  local score_id="$7"

  psql_qa \
    -v flow_id="$flow_id" \
    -v source_user_id="$source_user_id" \
    -v source_session_id="$source_session_id" \
    -v target_user_id="$target_user_id" \
    -v target_session_id="$target_session_id" \
    -v fixture_state="$state" \
    -v score_id="$score_id" \
    -Aqt <<'SQL' >/dev/null
insert into auth.users(
  id,
  email,
  is_anonymous,
  created_at,
  updated_at
)
values
  (
    :'source_user_id'::uuid,
    'oauth-member-race-source-' || :'source_user_id' || '@test.local',
    true,
    pg_catalog.clock_timestamp() - interval '10 minutes',
    pg_catalog.clock_timestamp() - interval '10 minutes'
  ),
  (
    :'target_user_id'::uuid,
    'oauth-member-race-target-' || :'target_user_id' || '@test.local',
    false,
    pg_catalog.clock_timestamp() - interval '9 minutes',
    pg_catalog.clock_timestamp() - interval '9 minutes'
  );

insert into auth.sessions(id, user_id, created_at, updated_at)
values
  (
    :'source_session_id'::uuid,
    :'source_user_id'::uuid,
    pg_catalog.clock_timestamp() - interval '5 minutes',
    pg_catalog.clock_timestamp() - interval '5 minutes'
  ),
  (
    :'target_session_id'::uuid,
    :'target_user_id'::uuid,
    pg_catalog.clock_timestamp() - interval '4 minutes',
    pg_catalog.clock_timestamp() - interval '4 minutes'
  );

insert into public.scores(
  id,
  owner_id,
  score,
  weapon,
  duration_ms
)
values (
  :'score_id'::uuid,
  :'source_user_id'::uuid,
  95,
  'fist',
  1000
);

insert into public.score_highlights(
  score_id,
  highlight_clip_path
)
values (
  :'score_id'::uuid,
  :'source_user_id' || '/member-race.webm'
);

insert into public.oauth_flow_intents(
  flow_id,
  source_user_id,
  source_session_id,
  source_access_token_sha256,
  source_refresh_token_sha256,
  source_is_anonymous,
  provider,
  requested_next,
  state,
  target_user_id,
  target_session_id,
  target_auth_created_at,
  target_auth_instance_id,
  target_session_created_at,
  target_access_token_sha256,
  target_refresh_token_sha256,
  destination,
  action,
  created_at,
  expires_at,
  claimed_at,
  finished_at,
  released_at
)
select
  :'flow_id'::uuid,
  :'source_user_id'::uuid,
  :'source_session_id'::uuid,
  pg_catalog.repeat('1', 64),
  pg_catalog.repeat('2', 64),
  true,
  'google',
  '/consent',
  :'fixture_state',
  :'target_user_id'::uuid,
  :'target_session_id'::uuid,
  target_user.created_at,
  target_user.instance_id,
  target_session.created_at,
  pg_catalog.repeat('a', 64),
  pg_catalog.repeat('b', 64),
  case when :'fixture_state' = 'completed' then '/consent' end,
  case when :'fixture_state' = 'completed' then 'continue' end,
  timing.v_now - interval '5 minutes',
  timing.v_now + interval '5 minutes',
  timing.v_now - interval '4 minutes',
  case
    when :'fixture_state' = 'completed'
      then timing.v_now - interval '3 minutes'
  end,
  case
    when :'fixture_state' = 'completed'
      then timing.v_now - interval '2 minutes'
  end
from (
  select pg_catalog.clock_timestamp() as v_now
) as timing
join auth.users as target_user
  on target_user.id = :'target_user_id'::uuid
join auth.sessions as target_session
  on target_session.id = :'target_session_id'::uuid
 and target_session.user_id = target_user.id;

insert into public.oauth_anon_auth_cleanup_jobs(
  cleanup_id,
  flow_id,
  source_user_id,
  source_auth_created_at,
  source_auth_instance_id,
  created_at,
  recover_until
)
select
  :'flow_id'::uuid,
  :'flow_id'::uuid,
  source_user.id,
  source_user.created_at,
  source_user.instance_id,
  flow.created_at,
  flow.expires_at + interval '30 days 5 seconds'
from auth.users as source_user
join public.oauth_flow_intents as flow
  on flow.flow_id = :'flow_id'::uuid
where source_user.id = :'source_user_id'::uuid;
SQL
}

wait_for_holder() {
  local ready="f"
  for _ in {1..120}; do
    ready="$(
      psql_qa -v holder_app="$holder_app" -Aqt <<'SQL'
select exists (
  select 1
    from pg_catalog.pg_stat_activity
   where application_name = :'holder_app'
     and wait_event = 'PgSleep'
);
SQL
    )"
    if [[ "$ready" == "t" ]]; then
      return
    fi
    if ! kill -0 "$holder_pid" >/dev/null 2>&1; then
      echo "OAuth member-race holder exited before acquiring its lock" >&2
      exit 1
    fi
    sleep 0.05
  done
  echo "OAuth member-race holder did not become ready" >&2
  exit 1
}

wait_for_operation_lock() {
  local blocked="f"
  for _ in {1..120}; do
    blocked="$(
      psql_qa -v operation_app="$operation_app" -Aqt <<'SQL'
select exists (
  select 1
    from pg_catalog.pg_stat_activity
   where application_name = :'operation_app'
     and wait_event_type = 'Lock'
);
SQL
    )"
    if [[ "$blocked" == "t" ]]; then
      return
    fi
    if ! kill -0 "$operation_pid" >/dev/null 2>&1; then
      echo "OAuth migration operation did not wait on the member fence" >&2
      exit 1
    fi
    sleep 0.05
  done
  echo "OAuth migration operation never reached the member lock" >&2
  exit 1
}

start_member_holder() {
  local target_user_id="$1"
  docker exec -e PGAPPNAME="$holder_app" -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" \
    -v target_user_id="$target_user_id" <<'SQL' \
    >"$holder_output" 2>&1 &
begin;
select public.bp_user_mutation_lock(:'target_user_id'::uuid);
insert into public.member_accounts(user_id)
values (:'target_user_id'::uuid);
select pg_catalog.pg_sleep(5);
commit;
SQL
  holder_pid=$!
  wait_for_holder
}

create_fixture \
  "$finalize_flow" \
  "$finalize_source" \
  "$finalize_source_session" \
  "$finalize_target" \
  "$finalize_target_session" \
  "claimed" \
  "$finalize_score"
start_member_holder "$finalize_target"

docker exec -e PGAPPNAME="$operation_app" -i "$db_container" \
  psql -X -Aqt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" \
  -v flow_id="$finalize_flow" \
  -v source_user_id="$finalize_source" \
  -v source_session_id="$finalize_source_session" \
  -v target_user_id="$finalize_target" \
  -v target_session_id="$finalize_target_session" <<'SQL' \
  >"$operation_output" 2>&1 &
select public.finalize_oauth_flow_intent(
  :'flow_id'::uuid,
  :'source_user_id'::uuid,
  :'source_session_id'::uuid,
  'google',
  '/consent',
  'completed',
  :'target_user_id'::uuid,
  :'target_session_id'::uuid,
  pg_catalog.repeat('a', 64),
  pg_catalog.repeat('b', 64),
  '/consent',
  'continue'
);
SQL
operation_pid=$!
wait_for_operation_lock
wait "$holder_pid"
holder_pid=""
wait "$operation_pid"
operation_pid=""

# Finalize deliberately records the callback outcome without publishing it to
# the browser. Release is the next durable boundary and owns the exact
# target-member no-transfer/quarantine decision.
finalize_release="$(
  psql_qa \
    -v flow_id="$finalize_flow" \
    -v target_user_id="$finalize_target" \
    -v target_session_id="$finalize_target_session" \
    -Aqt <<'SQL'
select public.release_oauth_flow_intent(
  :'flow_id'::uuid,
  :'target_user_id'::uuid,
  :'target_session_id'::uuid,
  pg_catalog.repeat('a', 64),
  pg_catalog.repeat('b', 64)
)->>'ok';
SQL
)"
if [[ "$finalize_release" != "true" ]]; then
  echo "finalize/member race release did not commit" >&2
  exit 1
fi

finalize_converged="$(
  psql_qa \
    -v flow_id="$finalize_flow" \
    -v source_user_id="$finalize_source" \
    -v score_id="$finalize_score" \
    -Aqt <<'SQL'
select exists (
  select 1
    from public.oauth_flow_intents as flow
    join public.oauth_anon_auth_cleanup_jobs as cleanup
      using (flow_id)
    join public.profiles as source_profile
      on source_profile.id = flow.source_user_id
    join auth.users as source_user
      on source_user.id = flow.source_user_id
    join public.scores as score
      on score.id = :'score_id'::uuid
     and score.owner_id = flow.source_user_id
    join public.score_highlights as highlight
      on highlight.score_id = score.id
    join public.oauth_quarantined_score_highlights as marker
      on marker.score_id = highlight.score_id
     and marker.flow_id = flow.flow_id
   where flow.flow_id = :'flow_id'::uuid
     and flow.state = 'completed'
     and flow.migration_result =
       '{"ok":true,"skipped":"target_already_member"}'::jsonb
     and flow.migration_consumed_at is not null
     and cleanup.status = 'quarantined'
     and cleanup.quarantine_reason = 'target_already_member'
     and cleanup.quarantined_at is not null
     and cleanup.recover_until > cleanup.quarantined_at
     and cleanup.access_revoked_at is not null
     and cleanup.armed_at is null
     and cleanup.finished_at is null
     and cleanup.last_error is null
     and source_profile.deleted_at is not null
     and source_profile.display_name = '탈퇴한 사용자'
     and source_profile.avatar_url is null
     and source_user.is_anonymous
     and highlight.highlight_deleted_at is not null
     and marker.quarantined_at = cleanup.quarantined_at
     and not exists (
       select 1
         from auth.sessions as source_session
        where source_session.user_id = :'source_user_id'::uuid
     )
     and not exists (
       select 1
         from public.anon_data_reassignments as receipt
        where receipt.source_user_id = :'source_user_id'::uuid
     )
);
SQL
)"
if [[ "$finalize_converged" != "t" ]]; then
  echo "finalize/member race did not converge to quarantined no-transfer" >&2
  exit 1
fi

create_fixture \
  "$consume_flow" \
  "$consume_source" \
  "$consume_source_session" \
  "$consume_target" \
  "$consume_target_session" \
  "completed" \
  "$consume_score"
start_member_holder "$consume_target"

docker exec -e PGAPPNAME="$operation_app" -i "$db_container" \
  psql -X -Aqt -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" \
  -v flow_id="$consume_flow" \
  -v source_user_id="$consume_source" \
  -v target_user_id="$consume_target" \
  -v target_session_id="$consume_target_session" <<'SQL' \
  >"$operation_output" 2>&1 &
select public.consume_oauth_flow_intent_migration(
  :'flow_id'::uuid,
  :'target_user_id'::uuid,
  :'target_session_id'::uuid,
  :'source_user_id'::uuid,
  pg_catalog.repeat('a', 64),
  pg_catalog.repeat('b', 64)
);
SQL
operation_pid=$!
wait_for_operation_lock
wait "$holder_pid"
holder_pid=""
wait "$operation_pid"
operation_pid=""

consume_converged="$(
  psql_qa \
    -v flow_id="$consume_flow" \
    -v source_user_id="$consume_source" \
    -v score_id="$consume_score" \
    -Aqt <<'SQL'
select exists (
  select 1
    from public.oauth_flow_intents as flow
    join public.oauth_anon_auth_cleanup_jobs as cleanup
      using (flow_id)
    join public.profiles as source_profile
      on source_profile.id = flow.source_user_id
    join auth.users as source_user
      on source_user.id = cleanup.source_user_id
    join public.scores as score
      on score.id = :'score_id'::uuid
     and score.owner_id = flow.source_user_id
    join public.score_highlights as highlight
      on highlight.score_id = score.id
    join public.oauth_quarantined_score_highlights as marker
      on marker.score_id = highlight.score_id
     and marker.flow_id = flow.flow_id
   where flow.flow_id = :'flow_id'::uuid
     and flow.migration_result =
       '{"ok":true,"skipped":"target_already_member"}'::jsonb
     and flow.migration_consumed_at is not null
     and cleanup.status = 'quarantined'
     and cleanup.quarantine_reason = 'target_already_member'
     and cleanup.quarantined_at is not null
     and cleanup.recover_until > cleanup.quarantined_at
     and cleanup.access_revoked_at is not null
     and cleanup.armed_at is null
     and cleanup.finished_at is null
     and cleanup.last_error is null
     and source_profile.deleted_at is not null
     and source_profile.display_name = '탈퇴한 사용자'
     and source_profile.avatar_url is null
     and source_user.is_anonymous
     and highlight.highlight_deleted_at is not null
     and marker.quarantined_at = cleanup.quarantined_at
)
and not exists (
  select 1
    from public.anon_data_reassignments
   where source_user_id = :'source_user_id'::uuid
)
and not exists (
  select 1
    from auth.sessions as source_session
   where source_session.user_id = :'source_user_id'::uuid
);
SQL
)"
if [[ "$consume_converged" != "t" ]]; then
  echo "consume/member race transferred data or failed quarantined no-transfer convergence" >&2
  exit 1
fi

echo "OAuth finalize/consume member-lock races QA passed"
