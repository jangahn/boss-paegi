# race 하네스 공용 세션 동기화 — 폴링 상한을 러너 속도와 무관하게 만든다.
#
# 계약(docs/checkout-rework.md PR-B):
#  - 호출 파일이 `db_value <query>` 와 `fail <message>` 를 먼저 정의해 두어야 한다.
#  - 상한 120s(2400×0.05s) — 기존 파일별 8/10/12s 상한은 two-core CI 러너에서
#    상대 세션이 목표 상태에 도달하기 전에 포기하는 flake 의 원천이었다.
#    성공 경로는 여전히 수십 ms 에 반환되므로 상한 확대는 성공 시간에 영향 없음.
#  - datname 필터는 두지 않는다: application_name 이 mktemp 유래 고유 접두사라
#    QA 컨테이너 안에서 그 자체로 유일하다.
#  - pg_stat_activity 에 별칭을 붙이지 않는다 — 일부 호출자의 predicate 가
#    `pg_stat_activity.pid` 정규 이름을 참조한다.
#  - 타임아웃 시 해당 앱 세션들의 상태 스냅샷을 stderr 에 덤프한 뒤 fail 위임.
#
# shellcheck shell=bash

WAIT_SYNC_ATTEMPTS="${WAIT_SYNC_ATTEMPTS:-2400}"

# 세션이 **이미 수행한 사실**(자기 출력의 마커)을 기다린다 — pg_stat_activity 의
# 순간 상태 폴링과 달리 상대가 마커 이후 어떤 상태로 넘어가도 놓치지 않는다.
# 프로세스가 마커 없이 죽으면 즉시 실패(상한까지 기다리지 않음).
wait_for_output_marker() {
  local pid="$1"
  local output_file="$2"
  local marker="$3"
  local description="$4"
  for _ in $(seq 1 "$WAIT_SYNC_ATTEMPTS"); do
    if grep -Fq "$marker" "$output_file" 2>/dev/null; then
      return 0
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      # 마커가 종료 직전 flush 됐을 수 있으니 마지막으로 한 번 더 본다.
      if grep -Fq "$marker" "$output_file" 2>/dev/null; then
        return 0
      fi
      fail "session exited before $description"
    fi
    sleep 0.05
  done
  fail "timed out waiting for $description"
}

wait_for_activity() {
  local app_name="$1"
  local predicate="$2"
  local description="$3"
  local count=""
  for _ in $(seq 1 "$WAIT_SYNC_ATTEMPTS"); do
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
  {
    echo "wait-sync: timed out after $((WAIT_SYNC_ATTEMPTS / 20))s — sessions for application_name='$app_name':"
    db_value "
      select coalesce(
        pg_catalog.string_agg(
          pg_catalog.format(
            'pid=%s state=%s wait=%s/%s xact_start=%s query=%s',
            pid, state, wait_event_type, wait_event, xact_start,
            pg_catalog.left(query, 120)
          ),
          pg_catalog.chr(10)
        ),
        '(no session)'
      )
        from pg_catalog.pg_stat_activity
       where application_name = '$app_name';
    " || true
  } >&2
  fail "timed out waiting for $description"
}
