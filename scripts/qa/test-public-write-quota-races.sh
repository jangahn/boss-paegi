#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
db_container="${QA_DB_CONTAINER:-supabase_db_${project_id}}"
db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ -z "$project_id" ]] \
  || [[ "$db_container" != supabase_db_* ]] \
  || ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "public write quota race QA requires disposable local Supabase" >&2
  exit 1
fi
if [[ "$db_name" != "postgres" ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "public write quota race QA requires local postgres identifiers" >&2
  exit 2
fi

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" "$@"
}

db_value() {
  db_psql -Atq -c "$1"
}

fail() {
  echo "public write quota race QA failed: $*" >&2
  exit 1
}

qa_tmp_dir="$(mktemp -d "${TMPDIR:-/tmp}/boss-paegi-public-write-race.XXXXXX")"
member_id="94000000-0000-4000-8000-000000000001"
session_a="94000000-0000-4000-8000-000000000011"
session_b="94000000-0000-4000-8000-000000000012"
actor_a="$(printf 'a%.0s' {1..64})"
actor_b="$(printf 'b%.0s' {1..64})"
telemetry_budget_backup_hex=""
telemetry_budget_fixture_installed="false"
same_pid_a=""
same_pid_b=""
global_new_pid_a=""
global_new_pid_b=""
track_global_pid_a=""
track_global_pid_b=""
track_actor_pid_a=""
track_actor_pid_b=""
lock_holder_pid=""

cleanup() {
  original_status=$?
  set +e
  cleanup_failed=0
  cleanup_remaining=""
  budget_restore_failed=0
  for pid in \
    "$same_pid_a" "$same_pid_b" \
    "$global_new_pid_a" "$global_new_pid_b" \
    "$track_global_pid_a" "$track_global_pid_b" \
    "$track_actor_pid_a" "$track_actor_pid_b" \
    "$lock_holder_pid"; do
    if [[ -n "$pid" ]] && kill -0 "$pid" >/dev/null 2>&1; then
      kill "$pid" >/dev/null 2>&1
      wait "$pid" >/dev/null 2>&1
    fi
  done
  if ! db_psql -Aqt >"$qa_tmp_dir/cleanup.out" 2>&1 <<SQL
delete from public.analytics_events
 where kind = 'share'
   and surface = 'gallery'
   and target = 'doll';
delete from public.public_write_quota_buckets
 where actor_key in ('global', '$actor_a', '$actor_b');
delete from public.telemetry_sessions
 where id in ('$session_a'::uuid, '$session_b'::uuid);
delete from public.member_accounts where user_id = '$member_id'::uuid;
delete from auth.users where id = '$member_id'::uuid;
SQL
  then
    cleanup_failed=1
  fi
  if ! cleanup_remaining="$(
    db_value "
      select
        (
          select pg_catalog.count(*)
            from public.analytics_events
           where kind = 'share'
             and surface = 'gallery'
             and target = 'doll'
        )
        + (
          select pg_catalog.count(*)
            from public.public_write_quota_buckets
           where actor_key in ('global', '$actor_a', '$actor_b')
        )
        + (
          select pg_catalog.count(*)
            from public.telemetry_sessions
           where id in ('$session_a'::uuid, '$session_b'::uuid)
        )
        + (
          select pg_catalog.count(*)
            from public.member_accounts
           where user_id = '$member_id'::uuid
        )
        + (
          select pg_catalog.count(*)
            from public.profiles
           where id = '$member_id'::uuid
        )
        + (
          select pg_catalog.count(*)
            from auth.users
           where id = '$member_id'::uuid
        );
    " 2>>"$qa_tmp_dir/cleanup.out"
  )"; then
    cleanup_failed=1
  elif [[ "$cleanup_remaining" != "0" ]]; then
    cleanup_failed=1
  fi
  if [[ "$telemetry_budget_fixture_installed" == "true" ]]; then
    if [[ "$telemetry_budget_backup_hex" =~ ^[0-9a-f]+$ ]]; then
      db_psql -q -c "
        delete from public.telemetry_budget where id = true;
        insert into public.telemetry_budget
        select restored.*
          from pg_catalog.json_populate_record(
            null::public.telemetry_budget,
            pg_catalog.convert_from(
              pg_catalog.decode('$telemetry_budget_backup_hex', 'hex'),
              'UTF8'
            )::json
          ) as restored;
      " >>"$qa_tmp_dir/cleanup.out" 2>&1 || budget_restore_failed=1
    else
      budget_restore_failed=1
    fi
    restored_budget_hex="$(
      db_value "
        select pg_catalog.encode(
                 pg_catalog.convert_to(
                   pg_catalog.row_to_json(b)::text,
                   'UTF8'
                 ),
                 'hex'
               )
          from public.telemetry_budget b
         where b.id = true;
      " 2>>"$qa_tmp_dir/cleanup.out"
    )" || budget_restore_failed=1
    if [[ "$restored_budget_hex" != "$telemetry_budget_backup_hex" ]]; then
      budget_restore_failed=1
    fi
  fi
  if (( cleanup_failed != 0 )); then
    echo "public write quota race QA cleanup failed (remaining=${cleanup_remaining:-unknown})" >&2
  fi
  if (( budget_restore_failed != 0 )); then
    echo "public write quota race QA failed to restore telemetry_budget" >&2
  fi
  if (( cleanup_failed != 0 || budget_restore_failed != 0 )) \
    && [[ -s "$qa_tmp_dir/cleanup.out" ]]; then
    tail -n 30 "$qa_tmp_dir/cleanup.out" >&2
  fi
  case "$qa_tmp_dir" in
    "${TMPDIR:-/tmp}"/boss-paegi-public-write-race.*)
      rm -rf -- "$qa_tmp_dir"
      ;;
  esac
  if (( (cleanup_failed != 0 || budget_restore_failed != 0) \
    && original_status == 0 )); then
    exit 1
  fi
}
trap cleanup EXIT

telemetry_budget_backup_hex="$(
  db_value "
    select pg_catalog.encode(
             pg_catalog.convert_to(
               pg_catalog.row_to_json(b)::text,
               'UTF8'
             ),
             'hex'
           )
      from public.telemetry_budget b
     where b.id = true;
  "
)"
[[ "$telemetry_budget_backup_hex" =~ ^[0-9a-f]+$ ]] \
  || fail "telemetry_budget baseline is missing or invalid"

db_psql -Aqt >/dev/null <<SQL
do \$qa\$
begin
  if pg_catalog.to_regprocedure(
    'public.ingest_telemetry_delta(uuid,uuid,boolean,text,jsonb)'
  ) is null then
    raise exception 'quota migration missing';
  end if;
  if pg_catalog.to_regprocedure(
    'public.record_public_analytics_event(text,text,jsonb)'
  ) is null then
    raise exception 'analytics quota RPC missing';
  end if;
end
\$qa\$;
delete from public.telemetry_sessions
 where id in ('$session_a'::uuid, '$session_b'::uuid);
delete from public.member_accounts where user_id = '$member_id'::uuid;
delete from auth.users where id = '$member_id'::uuid;
insert into auth.users(id, email)
values ('$member_id'::uuid, 'public-write-race@test.local');
insert into public.member_accounts(user_id, email)
values ('$member_id'::uuid, 'public-write-race@test.local');
update public.telemetry_budget
   set degrade_mode = 'full',
       over_budget = false,
       new_sessions_today = 0,
       day_kst = (
         pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
       )::date
 where id = true;
SQL
telemetry_budget_fixture_installed="true"

# Same absent session, two real connections: A holds the transaction-level
# advisory/global/actor locks after ingest; B must wait, observe the committed
# row, and consume request-only quota rather than a second new-session unit.
db_psql -Aqt >/dev/null <<SQL
delete from public.public_write_quota_buckets where endpoint = 'telemetry';
delete from public.telemetry_sessions
 where id in ('$session_a'::uuid, '$session_b'::uuid);
SQL
(
  db_psql -Aqt >"$qa_tmp_dir/same-a.out" <<SQL
begin;
select public.ingest_telemetry_delta(
  '$session_a'::uuid,
  '$member_id'::uuid,
  true,
  '$actor_a',
  '{"deviceClass":"desktop-pointer","summary":{"seqHigh":1,"durationMs":1000,"totals":{"score":1,"hitCount":1}},"events":[]}'::jsonb
)->>'ok';
select pg_catalog.pg_sleep(0.2);
commit;
SQL
) &
same_pid_a=$!
sleep 0.05
(
  db_psql -Aqt >"$qa_tmp_dir/same-b.out" <<SQL
select public.ingest_telemetry_delta(
  '$session_a'::uuid,
  '$member_id'::uuid,
  true,
  '$actor_a',
  '{"deviceClass":"desktop-pointer","summary":{"seqHigh":2,"durationMs":1100,"totals":{"score":2,"hitCount":2}},"events":[]}'::jsonb
)->>'ok';
SQL
) &
same_pid_b=$!
wait "$same_pid_a"
wait "$same_pid_b"
same_state="$(
  db_psql -Aqt <<SQL
select
  (select pg_catalog.count(*) from public.telemetry_sessions
    where id = '$session_a'::uuid)::text
  || '|' ||
  (select request_count::text || ':' || new_session_count::text
     from public.public_write_quota_buckets
    where endpoint = 'telemetry' and actor_key = '$actor_a')
  || '|' ||
  (select request_count::text || ':' || new_session_count::text
     from public.public_write_quota_buckets
    where endpoint = 'telemetry' and actor_key = 'global');
SQL
)"
[[ "$(grep -c '^true$' "$qa_tmp_dir/same-a.out")" == "1" ]] \
  || fail "same-session connection A did not ingest"
[[ "$(grep -c '^true$' "$qa_tmp_dir/same-b.out")" == "1" ]] \
  || fail "same-session connection B did not converge"
[[ "$same_state" == "1|2:1|2:1" ]] \
  || fail "same-session absent-row decision was not exact ($same_state)"

# Two distinct random sessions race for the final global new-session unit.
db_psql -Aqt >/dev/null <<SQL
delete from public.public_write_quota_buckets where endpoint = 'telemetry';
delete from public.telemetry_sessions
 where id in ('$session_a'::uuid, '$session_b'::uuid);
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count, new_session_count
)
values
  ('telemetry', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, 'global', 0, 1999),
  ('telemetry', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, '$actor_a', 0, 0),
  ('telemetry', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, '$actor_b', 0, 0);
SQL
for suffix in a b; do
  if [[ "$suffix" == "a" ]]; then
    race_session="$session_a"
    race_actor="$actor_a"
  else
    race_session="$session_b"
    race_actor="$actor_b"
  fi
  (
    db_psql -Aqt >"$qa_tmp_dir/global-new-$suffix.out" <<SQL
select coalesce(
  public.ingest_telemetry_delta(
    '$race_session'::uuid,
    '$member_id'::uuid,
    true,
    '$race_actor',
    '{"deviceClass":"desktop-pointer","summary":{"seqHigh":1,"durationMs":1000,"totals":{"score":1,"hitCount":1}},"events":[]}'::jsonb
  )->>'reason',
  'accepted'
);
SQL
  ) &
  if [[ "$suffix" == "a" ]]; then
    global_new_pid_a=$!
  else
    global_new_pid_b=$!
  fi
done
wait "$global_new_pid_a"
wait "$global_new_pid_b"
global_new_results="$(
  command sed -n '/^accepted$/p;/^global_new_session_quota$/p' \
    "$qa_tmp_dir/global-new-a.out" "$qa_tmp_dir/global-new-b.out" \
    | sort | paste -s -d, -
)"
global_new_state="$(
  db_psql -Aqt <<SQL
select
  (select pg_catalog.count(*) from public.telemetry_sessions
    where id in ('$session_a'::uuid, '$session_b'::uuid))::text
  || '|' ||
  (select request_count::text || ':' || new_session_count::text
     from public.public_write_quota_buckets
    where endpoint = 'telemetry' and actor_key = 'global')
  || '|' ||
  (select pg_catalog.sum(request_count)::text || ':' ||
          pg_catalog.sum(new_session_count)::text
     from public.public_write_quota_buckets
    where endpoint = 'telemetry'
      and actor_key in ('$actor_a', '$actor_b'));
SQL
)"
[[ "$global_new_results" == "accepted,global_new_session_quota" ]] \
  || fail "global new-session race outcomes drifted ($global_new_results)"
[[ "$global_new_state" == "1|1:2000|1:1" ]] \
  || fail "global new-session race exceeded boundary ($global_new_state)"

# Two distinct actors race for the final global analytics request unit.
db_psql -Aqt >/dev/null <<SQL
delete from public.public_write_quota_buckets where endpoint = 'track';
delete from public.analytics_events
 where kind = 'share' and surface = 'gallery' and target = 'doll';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values
  ('track', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, 'global', 1999),
  ('track', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, '$actor_a', 0),
  ('track', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, '$actor_b', 0);
SQL
for suffix in a b; do
  if [[ "$suffix" == "a" ]]; then
    race_actor="$actor_a"
  else
    race_actor="$actor_b"
  fi
  (
    db_psql -Aqt >"$qa_tmp_dir/track-global-$suffix.out" <<SQL
select case
  when result->>'accepted' = 'true' then 'accepted'
  else result->>'reason'
end
from (
  select public.record_public_analytics_event(
    '$race_actor',
    'anon',
    '{"kind":"share","surface":"gallery","target":"doll","score_tier":null,"result":"attempt"}'::jsonb
  ) result
) q;
SQL
  ) &
  if [[ "$suffix" == "a" ]]; then
    track_global_pid_a=$!
  else
    track_global_pid_b=$!
  fi
done
wait "$track_global_pid_a"
wait "$track_global_pid_b"
track_global_results="$(
  command sed -n '/^accepted$/p;/^global_request_quota$/p' \
    "$qa_tmp_dir/track-global-a.out" "$qa_tmp_dir/track-global-b.out" \
    | sort | paste -s -d, -
)"
track_global_state="$(
  db_psql -Aqt <<SQL
select
  (select pg_catalog.count(*) from public.analytics_events
    where kind = 'share'
      and surface = 'gallery'
      and target = 'doll')::text
  || '|' ||
  (select request_count::text
     from public.public_write_quota_buckets
    where endpoint = 'track' and actor_key = 'global')
  || '|' ||
  (select pg_catalog.sum(request_count)::text
     from public.public_write_quota_buckets
    where endpoint = 'track'
      and actor_key in ('$actor_a', '$actor_b'));
SQL
)"
[[ "$track_global_results" == "accepted,global_request_quota" ]] \
  || fail "track global race outcomes drifted ($track_global_results)"
[[ "$track_global_state" == "1|2000|1" ]] \
  || fail "track global race exceeded boundary ($track_global_state)"

# Two concurrent writes by one actor race for its final per-actor unit.
db_psql -Aqt >/dev/null <<SQL
delete from public.public_write_quota_buckets where endpoint = 'track';
delete from public.analytics_events
 where kind = 'share' and surface = 'gallery' and target = 'doll';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values
  ('track', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, 'global', 0),
  ('track', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, '$actor_a', 199);
SQL
for suffix in a b; do
  (
    db_psql -Aqt >"$qa_tmp_dir/track-actor-$suffix.out" <<SQL
select case
  when result->>'accepted' = 'true' then 'accepted'
  else result->>'reason'
end
from (
  select public.record_public_analytics_event(
    '$actor_a',
    'member',
    '{"kind":"share","surface":"gallery","target":"doll","score_tier":null,"result":"attempt"}'::jsonb
  ) result
) q;
SQL
  ) &
  if [[ "$suffix" == "a" ]]; then
    track_actor_pid_a=$!
  else
    track_actor_pid_b=$!
  fi
done
wait "$track_actor_pid_a"
wait "$track_actor_pid_b"
track_actor_results="$(
  command sed -n '/^accepted$/p;/^actor_request_quota$/p' \
    "$qa_tmp_dir/track-actor-a.out" "$qa_tmp_dir/track-actor-b.out" \
    | sort | paste -s -d, -
)"
track_actor_state="$(
  db_psql -Aqt <<SQL
select
  (select pg_catalog.count(*) from public.analytics_events
    where kind = 'share'
      and surface = 'gallery'
      and target = 'doll')::text
  || '|' ||
  (select request_count::text
     from public.public_write_quota_buckets
    where endpoint = 'track' and actor_key = '$actor_a')
  || '|' ||
  (select request_count::text
     from public.public_write_quota_buckets
    where endpoint = 'track' and actor_key = 'global');
SQL
)"
[[ "$track_actor_results" == "accepted,actor_request_quota" ]] \
  || fail "track actor race outcomes drifted ($track_actor_results)"
[[ "$track_actor_state" == "1|200|1" ]] \
  || fail "track actor race exceeded boundary ($track_actor_state)"

# A deliberately held global row must fail fast instead of queueing another
# public request behind a one-second lock holder.
db_psql -Aqt >/dev/null <<SQL
delete from public.public_write_quota_buckets where endpoint = 'track';
delete from public.analytics_events
 where kind = 'share' and surface = 'gallery' and target = 'doll';
insert into public.public_write_quota_buckets(
  endpoint, day_kst, actor_key, request_count
)
values
  ('track', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, 'global', 0),
  ('track', (
    pg_catalog.clock_timestamp() at time zone 'Asia/Seoul'
  )::date, '$actor_a', 0);
SQL
(
  db_psql -Aqt >"$qa_tmp_dir/lock-holder.out" <<SQL
begin;
select actor_key
  from public.public_write_quota_buckets
 where endpoint = 'track' and actor_key = 'global'
 for update;
select pg_catalog.pg_sleep(1);
commit;
SQL
) &
lock_holder_pid=$!
sleep 0.15
db_psql -Aqt >"$qa_tmp_dir/lock-contender.out" <<SQL
select case
  when result->>'accepted' = 'true' then 'accepted'
  else result->>'reason'
end
from (
  select public.record_public_analytics_event(
    '$actor_a',
    'anon',
    '{"kind":"share","surface":"gallery","target":"doll","score_tier":null,"result":"attempt"}'::jsonb
  ) result
) q;
SQL
wait "$lock_holder_pid"
lock_state="$(
  db_psql -Aqt <<SQL
select
  (select pg_catalog.count(*) from public.analytics_events
    where kind = 'share'
      and surface = 'gallery'
      and target = 'doll')::text
  || '|' ||
  (select request_count::text
     from public.public_write_quota_buckets
    where endpoint = 'track' and actor_key = 'global')
  || '|' ||
  (select request_count::text
     from public.public_write_quota_buckets
    where endpoint = 'track' and actor_key = '$actor_a');
SQL
)"
[[ "$(command sed -n '/^quota_busy$/p' "$qa_tmp_dir/lock-contender.out")" == "quota_busy" ]] \
  || fail "contended global lock did not return retryable quota_busy"
[[ "$lock_state" == "0|0|0" ]] \
  || fail "lock-timeout drop mutated analytics state ($lock_state)"

echo "public write quota race QA passed: telemetry, analytics, lock-timeout"
