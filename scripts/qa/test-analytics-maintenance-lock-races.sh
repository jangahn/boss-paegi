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
  mktemp -d "${TMPDIR:-/tmp}/boss-paegi-analytics-lock-races.XXXXXX"
)"
run_prefix="boss_paegi_analytics_lock_qa_$$"
holder_pid=""
waiter_pid=""

db_psql() {
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" "$@"
}

terminate_run_sessions() {
  db_psql -v run_prefix="$run_prefix" -Atq <<'SQL' >/dev/null 2>&1 || true
select pg_catalog.pg_terminate_backend(activity.pid)
  from pg_catalog.pg_stat_activity activity
 where activity.application_name like :'run_prefix' || '%'
   and activity.pid <> pg_catalog.pg_backend_pid();
SQL
}

cleanup() {
  original_status=$?
  trap - EXIT INT TERM
  set +e
  cleanup_failed=0

  terminate_run_sessions
  if [[ -n "$holder_pid" ]]; then
    wait "$holder_pid" >/dev/null 2>&1 || true
    holder_pid=""
  fi
  if [[ -n "$waiter_pid" ]]; then
    wait "$waiter_pid" >/dev/null 2>&1 || true
    waiter_pid=""
  fi

  session_residue="$(
    db_psql -v run_prefix="$run_prefix" -Atq <<'SQL' 2>/dev/null
select count(*)
  from pg_catalog.pg_stat_activity activity
 where activity.application_name like :'run_prefix' || '%';
SQL
  )" || cleanup_failed=1
  if [[ "${session_residue:-unknown}" != "0" ]]; then
    cleanup_failed=1
    echo \
      "analytics maintenance lock-race QA session cleanup failed (residue=${session_residue:-unknown})" \
      >&2
  fi

  rm -f "$qa_tmp_dir"/*.out
  if ! rmdir "$qa_tmp_dir" >/dev/null 2>&1; then
    cleanup_failed=1
    echo "analytics maintenance lock-race QA temp cleanup failed" >&2
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
  echo "analytics maintenance lock-race QA failed: $*" >&2
  for output in "$qa_tmp_dir"/*.out; do
    if [[ -s "$output" ]]; then
      echo "--- $(basename "$output")" >&2
      tail -n 40 "$output" >&2
    fi
  done
  exit 1
}

# 세션 동기화 프리미티브(출력 마커·activity 폴링) — 상한 120s, 러너 속도 무관.
source scripts/qa/lib/wait-sync.sh

# 유지보수 RPC 호출 + ack 검증 SQL 본문. operation 은 allowlist 검증 후 리터럴
# 삽입한다(psql 변수 불필요 — holder 는 fifo 명령 스트림이라 -v 를 쓸 수 없음).
maintenance_session_sql() {
  local operation="$1"
  local statement_timeout="$2"

  case "$operation" in
    telemetry | telemetry_prune | rollup | prune) ;;
    *)
      echo "invalid analytics maintenance operation: $operation" >&2
      return 2
      ;;
  esac
  case "$statement_timeout" in
    30s) ;;
    *)
      echo "unsupported statement_timeout: $statement_timeout" >&2
      return 2
      ;;
  esac

  cat <<SQL
begin;
select pg_catalog.set_config('statement_timeout', '$statement_timeout', true);
select pg_catalog.set_config(
  'boss_paegi.qa_analytics_maintenance_operation',
  '$operation',
  true
);
SQL
  cat <<'SQL'

do $qa$
declare
  v_operation text := pg_catalog.current_setting(
    'boss_paegi.qa_analytics_maintenance_operation'
  );
  v_ack jsonb;
  v_key_count int;
  v_numeric_key text;
  v_expected_cutoff date :=
    (pg_catalog.now() at time zone 'Asia/Seoul')::date - 90;
begin
  case v_operation
    when 'telemetry' then
      v_ack := public.telemetry_rollup_days(1);
    when 'telemetry_prune' then
      v_ack := public.telemetry_prune();
    when 'rollup' then
      v_ack := public.maintain_analytics_rollups(1);
    when 'prune' then
      v_ack := public.prune_analytics_events(90);
    else
      raise exception 'unsupported analytics maintenance operation: %',
        v_operation;
  end case;

  if v_operation in ('telemetry', 'rollup') then
    if v_ack is distinct from pg_catalog.jsonb_build_object(
      'ok', true,
      'days', 1
    ) then
      raise exception '% acknowledgement mismatch: %',
        v_operation,
        v_ack;
    end if;
  elsif v_operation = 'prune' then
    if pg_catalog.jsonb_typeof(v_ack) is distinct from 'object' then
      raise exception 'prune acknowledgement is not an object: %', v_ack;
    end if;

    select count(*)
      into v_key_count
      from pg_catalog.jsonb_object_keys(v_ack);
    if v_key_count <> 3
       or not (v_ack ?& array['ok', 'deleted', 'cutoff'])
       or v_ack->'ok' is distinct from 'true'::jsonb
       or pg_catalog.jsonb_typeof(v_ack->'deleted')
            is distinct from 'number'
       or v_ack->>'deleted' !~ '^[0-9]+$'
       or v_ack->>'cutoff' is distinct from v_expected_cutoff::text then
      raise exception 'prune acknowledgement mismatch: %', v_ack;
    end if;
  else
    if pg_catalog.jsonb_typeof(v_ack) is distinct from 'object' then
      raise exception 'telemetry prune acknowledgement is not an object: %',
        v_ack;
    end if;

    select count(*)
      into v_key_count
      from pg_catalog.jsonb_object_keys(v_ack);
    if v_key_count <> 5
       or not (
         v_ack ?& array[
           'ok',
           'timeline_nulled',
           'anon_deleted',
           'over_budget_deleted',
           'bytes'
         ]
       )
       or v_ack->'ok' is distinct from 'true'::jsonb then
      raise exception 'telemetry prune acknowledgement mismatch: %', v_ack;
    end if;

    foreach v_numeric_key in array array[
      'timeline_nulled',
      'anon_deleted',
      'over_budget_deleted',
      'bytes'
    ]
    loop
      if pg_catalog.jsonb_typeof(v_ack->v_numeric_key)
           is distinct from 'number'
         or v_ack->>v_numeric_key !~ '^[0-9]+$' then
        raise exception
          'telemetry prune numeric acknowledgement mismatch (%): %',
          v_numeric_key,
          v_ack;
      end if;
    end loop;
  end if;
end;
$qa$;
SQL
}

# waiter — 단방향: RPC(holder 의 advisory lock 에 블록) → 완료 마커 → rollback.
run_waiter_session() {
  local app_name="$1"
  local operation="$2"

  {
    maintenance_session_sql "$operation" 30s
    printf '%s\n' '\echo analytics_maintenance_lock_waiter_done'
    printf 'rollback;\n'
  } | docker exec -e PGAPPNAME="$app_name" -i "$db_container"     psql -X -v ON_ERROR_STOP=1 -Atq -U "$db_user" -d "$db_name"
}

wait_for_advisory_block() {
  local waiter_app="$1"
  local waiter_output="$2"
  local waiter_state="f|f|f"

  for _ in $(seq 1 "$WAIT_SYNC_ATTEMPTS"); do
    waiter_state="$(
      db_psql -v waiter_app="$waiter_app" -Atq <<'SQL'
select pg_catalog.concat_ws(
  '|',
  exists (
    select 1
      from pg_catalog.pg_stat_activity activity
     where activity.application_name = :'waiter_app'
       and activity.wait_event_type = 'Lock'
       and pg_catalog.lower(activity.wait_event) = 'advisory'
  )::text,
  exists (
    select 1
      from pg_catalog.pg_stat_activity activity
     where activity.application_name = :'waiter_app'
  )::text,
  exists (
    select 1
      from pg_catalog.pg_stat_activity activity
     where activity.application_name = :'waiter_app'
       and activity.wait_event_type = 'Lock'
       and pg_catalog.lower(activity.wait_event) <> 'advisory'
  )::text
);
SQL
    )"
    if [[ "$waiter_state" == "true|true|false" ]]; then
      return 0
    fi
    if [[ "$waiter_state" == "false|true|true" ]]; then
      fail "waiter reached a non-advisory lock instead of the maintenance fence ($waiter_app)"
    fi
    if [[ "$waiter_state" == "false|false|false" ]] \
      && [[ -s "$waiter_output" ]]; then
      fail "waiter completed without observing an advisory lock ($waiter_app)"
    fi
    sleep 0.05
  done

  fail "waiter did not block on the expected advisory lock ($waiter_app)"
}

wait_for_waiter_completion() {
  local waiter_app="$1"
  local waiter_output="$2"

  # holder 가 락을 놓은 뒤라 waiter 는 유한 시간 안에 끝난다(statement_timeout
  # 30s 백스톱). 프로세스 join 은 폴링과 달리 결정론적이다.
  if ! wait "$waiter_pid"; then
    waiter_pid=""
    fail "waiter failed after the holder released its lock ($waiter_app)"
  fi
  waiter_pid=""

  if ! grep -Fxq \
    "analytics_maintenance_lock_waiter_done" \
    "$waiter_output"; then
    fail "waiter completion marker is missing ($waiter_app)"
  fi
}

run_phase() {
  local phase="$1"
  local holder_operation="$2"
  local waiter_operation="$3"
  local holder_app="${run_prefix}_${phase}_holder"
  local waiter_app="${run_prefix}_${phase}_waiter"
  local holder_output="$qa_tmp_dir/${phase}-holder.out"
  local waiter_output="$qa_tmp_dir/${phase}-waiter.out"
  local holder_fifo="$qa_tmp_dir/${phase}-holder.fifo"

  # holder — fifo 명령 스트림: RPC 로 advisory lock 을 잡은 "사실"을 자기 출력의
  # 준비 마커로 알리고, 검증이 끝나면 rollback 신호를 받아 스스로 락을 놓는다.
  # (구 방식은 pg_sleep(60)+pg_terminate — holder 준비를 pg_stat_activity 의
  # PgSleep 순간 상태로 폴링해 two-core 러너에서 확률적으로 오판했다.)
  mkfifo "$holder_fifo"
  docker exec -e PGAPPNAME="$holder_app" -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -Atq -U "$db_user" -d "$db_name" \
    <"$holder_fifo" >"$holder_output" 2>&1 &
  holder_pid=$!
  exec 3>"$holder_fifo"
  maintenance_session_sql "$holder_operation" 30s >&3
  printf '%s\n' '\echo analytics_maintenance_lock_holder_ready' >&3
  wait_for_output_marker \
    "$holder_pid" \
    "$holder_output" \
    "analytics_maintenance_lock_holder_ready" \
    "holder to acquire the maintenance advisory lock ($holder_app)"

  run_waiter_session \
    "$waiter_app" \
    "$waiter_operation" >"$waiter_output" 2>&1 &
  waiter_pid=$!
  wait_for_advisory_block "$waiter_app" "$waiter_output"

  printf 'rollback;\n\\q\n' >&3
  exec 3>&-
  rm -f "$holder_fifo"
  if ! wait "$holder_pid"; then
    holder_pid=""
    fail "holder session failed ($holder_app)"
  fi
  holder_pid=""

  wait_for_waiter_completion "$waiter_app" "$waiter_output"
}

catalog_ready="$(
  db_psql -Atq <<'SQL'
select pg_catalog.concat_ws(
  '|',
  (
    pg_catalog.to_regprocedure(
      'public.telemetry_rollup_days(integer)'
    ) is not null
  )::text,
  (
    pg_catalog.to_regprocedure(
      'public.maintain_analytics_rollups(integer)'
    ) is not null
  )::text,
  (
    pg_catalog.to_regprocedure(
      'public.telemetry_prune()'
    ) is not null
  )::text,
  (
    pg_catalog.to_regprocedure(
      'public.prune_analytics_events(integer)'
    ) is not null
  )::text
);
SQL
)"
if [[ "$catalog_ready" != "true|true|true|true" ]]; then
  fail "0095 analytics maintenance functions are not installed ($catalog_ready)"
fi

run_phase tel_self telemetry telemetry
run_phase tel_prune_self telemetry_prune telemetry_prune
run_phase tel_to_prune telemetry telemetry_prune
run_phase prune_to_tel telemetry_prune telemetry
run_phase rollup_to_prune rollup prune
run_phase prune_to_rollup prune rollup

echo \
  "analytics maintenance lock-race QA passed: telemetry rollup/prune and analytics rollup/prune serialization"
