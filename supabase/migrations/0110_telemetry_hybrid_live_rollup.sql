-- 0110: 게임플레이 분석 하이브리드(오늘=raw 라이브·과거=일별 롤업) — 집계 정의 단일 소스화 + 세션단위 dim 확장.
--
-- 설계(v1.06 어드민 기간 윈도우):
--  · `telemetry_rollup_rows_for_day(p_day)` = 하루치 집계의 **단일 소스**. cron(`telemetry_rollup_days`)은
--    이 함수 출력을 INSERT 하고, 어드민 getter 는 같은 함수를 p_day=오늘로 직접 SELECT(라이브) — 두 경로의
--    의미 드리프트를 구조적으로 차단한다. 어드민은 롤업을 `day_kst < 오늘` 만 읽는다(이중계산 차단).
--  · 기존 dim(weapon·map·funnel_step) 의미는 문자 그대로 보존(0095 본문 이관). pgTAP
--    analytics_maintenance_bounds 의 본문 마커(검증→lock→loop 순서)·펀널 8행/일 계약도 유지.
--  · 세션단위 지표(편중/맵고착/효율/퍼포먼스)가 롤업을 탈 수 있도록 dim 확장:
--      sess_stat(스칼라 합계, measure_a=값) · sess_main_weapon · sess_start_map(분포 카운트)
--      sess_sps_all/sess_sps_pure(메인무기 점수/초 히스토그램, dim_key='<weapon>|<bucket>')
--      sess_perf_avg/sess_perf_p95(device_class 프레임타임 히스토그램) · sess_perf_dev(정확 세션수·렉수)
--    중앙값은 히스토그램 근사(연속 일자 합산 가능한 유일한 표현). 버킷은 **저장 포맷이라 불변 상수**:
--      sps 폭 1(점/초)·cap 3000 (prod 실측 2026-08-29: p50 623·p99 1355·max 2752)
--      perf 폭 1ms·cap 200 (실측 avg max 89.6ms·p95 max 100ms), 렉 경계 33ms 는 sess_perf_dev 로 정확 집계
--  · 재방문(getMemberActivity)·최악 top5 는 일단위 분해 불가/개별 행이라 raw 직조회 유지(코드 주석 참조).
--
-- ⚠ 백필: 신규 sess_* dim 만 insert 한다. 과거 일자의 기존 weapon/map/funnel_step 행은 **절대 delete-재계산
--   금지** — 익명 raw 가 30일 prune 으로 이미 소실돼 재계산하면 정확한 역사가 파괴된다(잔존 raw 기준 백필이라
--   과거 sess_* 값은 '잔존 세션 표본' 근사임을 어드민 화면이 각주로 고지). 일상 cron 은 3일 재계산이라 안전.

-- ── 1) 하루치 집계 단일 소스 ────────────────────────────────────────────────
create or replace function public.telemetry_rollup_rows_for_day(p_day date)
returns table(
  dim_type text,
  dim_key text,
  sessions int,
  hits bigint,
  score bigint,
  attempts int,
  switches int,
  measure_a numeric
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  -- lib/weapon-keys.ts WEAPON_KEYS 정의 순서(메인무기 동률 3순위 tie-break) — 무기 추가 시 함께 갱신.
  c_weapon_order constant text[] :=
    array['fist','hammer','slap','book','keyboard','paper','gun','grab','pen'];
  -- lib/admin-analytics 의 기존 세션단위 집계 상수와 동일(의미 이관 — 단일 소스는 이제 여기).
  c_min_valid_duration_ms constant int := 3000;   -- throughput 유효 최소 플레이 시간
  c_sps_bucket_cap constant int := 3000;          -- 점수/초 히스토그램 cap(폭 1)
  c_perf_bucket_cap constant int := 200;          -- 프레임타임 히스토그램 cap(폭 1ms)
  c_perf_lag_p95_ms constant numeric := 33;       -- p95 렉 경계(≈30fps 미달)
  v_lo timestamptz;
  v_hi timestamptz;
begin
  if p_day is null then
    raise exception 'telemetry_rollup_rows_for_day_invalid_day' using errcode = '22023';
  end if;
  v_lo := (p_day::timestamp at time zone 'Asia/Seoul');
  v_hi := ((p_day + 1)::timestamp at time zone 'Asia/Seoul');

  return query
  with sess as (
    select
      ts.id,
      ts.device_class,
      ts.end_reason,
      ts.duration_ms,
      ts.score as raw_score,
      ts.distinct_weapons,
      ts.distinct_maps,
      ts.start_map,
      ts.avg_frame_ms,
      ts.p95_frame_ms,
      ts.first_hit_ms,
      ts.first_switch_ms,
      ts.first_ult_ms,
      ts.weapon_summary,
      ts.map_summary,
      w.dw_summary,
      w.hits_total,
      w.hits_sumsq,
      mw.main_weapon,
      msw.map_switches,
      -- distinct 무기수: summary(hits>0 key) 우선, 없으면 컬럼 fallback(기존 JS distinctWeaponsOf 이관)
      case when w.dw_summary > 0 then w.dw_summary
           else greatest(coalesce(ts.distinct_weapons, 0), 0) end as dw_eff
    from public.telemetry_sessions ts
    left join lateral (
      select
        count(*) filter (where coalesce((e.value->>'hits')::numeric, 0) > 0) as dw_summary,
        coalesce(sum(coalesce((e.value->>'hits')::numeric, 0))
          filter (where coalesce((e.value->>'hits')::numeric, 0) > 0), 0) as hits_total,
        coalesce(sum(power(coalesce((e.value->>'hits')::numeric, 0), 2))
          filter (where coalesce((e.value->>'hits')::numeric, 0) > 0), 0) as hits_sumsq
      from jsonb_each(ts.weapon_summary) e
    ) w on true
    left join lateral (
      -- 메인무기: hits desc → score desc → 고정 무기순서 → key(기존 JS mainWeaponOf 이관)
      select e.key as main_weapon
      from jsonb_each(ts.weapon_summary) e
      where coalesce((e.value->>'hits')::numeric, 0) > 0
      order by
        (e.value->>'hits')::numeric desc,
        coalesce((e.value->>'score')::numeric, 0) desc,
        coalesce(array_position(c_weapon_order, e.key), 2147483647),
        e.key
      limit 1
    ) mw on true
    left join lateral (
      select coalesce(sum(coalesce((e.value->>'switches')::numeric, 0)), 0) as map_switches
      from jsonb_each(ts.map_summary) e
    ) msw on true
    where ts.started_at >= v_lo and ts.started_at < v_hi
  ),
  eligible as (
    -- throughput 표본: 완료 + 유효 duration + 메인무기 존재(기존 JS 게이트 이관)
    select
      s.main_weapon,
      s.dw_eff,
      (coalesce(s.raw_score, 0)::numeric / (s.duration_ms / 1000.0)) as sps
    from sess s
    where s.end_reason in ('normal', 'time_limit', 'score_limit')
      and coalesce(s.duration_ms, 0) > c_min_valid_duration_ms
      and s.main_weapon is not null
  )
  -- 무기 차원(0095 의미 보존 — summary 의 key 별, hits=0 key 포함)
  select 'weapon'::text, e.key, count(distinct s.id)::int,
    coalesce(sum((e.value->>'hits')::numeric), 0)::bigint,
    coalesce(sum((e.value->>'score')::numeric), 0)::bigint,
    coalesce(sum((e.value->>'attempts')::numeric), 0)::int,
    coalesce(sum((e.value->>'switches')::numeric), 0)::int,
    0::numeric
  from sess s, lateral jsonb_each(s.weapon_summary) e
  group by e.key
  union all
  -- 맵 차원(0095 의미 보존)
  select 'map'::text, e.key, count(distinct s.id)::int,
    coalesce(sum((e.value->>'hits')::numeric), 0)::bigint,
    coalesce(sum((e.value->>'score')::numeric), 0)::bigint,
    coalesce(sum((e.value->>'attempts')::numeric), 0)::int,
    coalesce(sum((e.value->>'switches')::numeric), 0)::int,
    0::numeric
  from sess s, lateral jsonb_each(s.map_summary) e
  group by e.key
  union all
  -- 펀널 단계(0095 의미 보존 — 항상 8행/일)
  select 'funnel_step'::text, f.step, f.cnt::int, 0::bigint, 0::bigint, 0::int, 0::int, 0::numeric
  from (
    select 'entered' as step, count(*) as cnt from sess
    union all select 'first_hit', count(*) from sess where first_hit_ms is not null
    union all select 'first_switch', count(*) from sess where first_switch_ms is not null
    union all select 'first_ult', count(*) from sess where first_ult_ms is not null
    union all select 'completed', count(*) from sess where end_reason = 'normal'
    union all select 'forced', count(*) from sess where end_reason in ('time_limit', 'score_limit')
    union all select 'abandoned', count(*) from sess where end_reason in ('abandon', 'reload', 'hidden_timeout')
    union all select 'multi_map', count(*) from sess where distinct_maps >= 2
  ) f
  union all
  -- 세션단위 스칼라 합계(measure_a=값) — 항상 12행/일(빈 날 0)
  select 'sess_stat'::text, t.k, 0::int, 0::bigint, 0::bigint, 0::int, 0::int, t.v
  from (
    select 'sessions_total' as k, count(*)::numeric as v from sess
    union all select 'weapon_sessions', count(*) from sess where dw_eff >= 1
    union all select 'single_weapon_sessions', count(*) from sess where dw_eff = 1
    union all select 'distinct_weapons_sum', coalesce(sum(dw_eff) filter (where dw_eff >= 1), 0) from sess
    union all select 'hhi_sum',
      coalesce(sum(hits_sumsq / (hits_total * hits_total)) filter (where hits_total > 0), 0) from sess
    union all select 'hhi_sessions', count(*) from sess where hits_total > 0
    union all select 'map_sessions', count(*) from sess where start_map is not null
    union all select 'single_map_sessions', count(*) from sess
      where start_map is not null and greatest(coalesce(distinct_maps, 0), 0) = 1
    union all select 'distinct_maps_sum',
      coalesce(sum(greatest(coalesce(distinct_maps, 0), 0)) filter (where start_map is not null), 0) from sess
    union all select 'map_switch_sum',
      coalesce(sum(map_switches) filter (where start_map is not null), 0) from sess
    union all select 'throughput_eligible', count(*) from eligible
    union all select 'perf_sessions', count(*) from sess where coalesce(avg_frame_ms, 0) > 0
  ) t
  union all
  -- 메인무기 분포(raw key — unknown 접기는 getter 가 담당)
  select 'sess_main_weapon'::text, s.main_weapon, 0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from sess s where s.main_weapon is not null
  group by s.main_weapon
  union all
  -- 시작맵 분포(raw key)
  select 'sess_start_map'::text, s.start_map, 0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from sess s where s.start_map is not null
  group by s.start_map
  union all
  -- 점수/초 히스토그램(메인무기 기준 전체 표본)
  select 'sess_sps_all'::text,
    e.main_weapon || '|' || least(floor(e.sps), c_sps_bucket_cap)::int,
    0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from eligible e
  group by e.main_weapon, least(floor(e.sps), c_sps_bucket_cap)::int
  union all
  -- 점수/초 히스토그램(단일무기 pure 표본)
  select 'sess_sps_pure'::text,
    e.main_weapon || '|' || least(floor(e.sps), c_sps_bucket_cap)::int,
    0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from eligible e
  where e.dw_eff = 1
  group by e.main_weapon, least(floor(e.sps), c_sps_bucket_cap)::int
  union all
  -- 프레임타임 히스토그램(avg) — perf 실표본(avg>0)만
  select 'sess_perf_avg'::text,
    s.device_class || '|' || least(floor(s.avg_frame_ms), c_perf_bucket_cap)::int,
    0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from sess s where coalesce(s.avg_frame_ms, 0) > 0
  group by s.device_class, least(floor(s.avg_frame_ms), c_perf_bucket_cap)::int
  union all
  -- 프레임타임 히스토그램(p95)
  select 'sess_perf_p95'::text,
    s.device_class || '|' || least(floor(s.p95_frame_ms), c_perf_bucket_cap)::int,
    0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from sess s where coalesce(s.avg_frame_ms, 0) > 0
  group by s.device_class, least(floor(s.p95_frame_ms), c_perf_bucket_cap)::int
  union all
  -- device_class 별 정확 카운트: sessions=perf 세션수, measure_a=렉 세션수(p95>33ms 정확 판정)
  select 'sess_perf_dev'::text, s.device_class,
    count(*)::int, 0::bigint, 0::bigint, 0::int, 0::int,
    count(*) filter (where s.p95_frame_ms > c_perf_lag_p95_ms)::numeric
  from sess s where coalesce(s.avg_frame_ms, 0) > 0
  group by s.device_class;
end;
$$;

revoke all on function public.telemetry_rollup_rows_for_day(date) from public, anon, authenticated;
grant execute on function public.telemetry_rollup_rows_for_day(date) to service_role;

-- ── 2) cron 롤업을 단일 소스 소비자로 재작성(0095 검증·lock·loop 마커 보존) ──
create or replace function public.telemetry_rollup_days(p_days int default 3)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  c_min_days constant int := 1;
  c_max_days constant int := 31;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_d date;
  i int;
begin
  if p_days is null or p_days not between c_min_days and c_max_days then
    raise exception 'telemetry_rollup_days_invalid_days'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('telemetry_rollups')
  );

  for i in 0 .. p_days - 1 loop
    v_d := v_today - i;

    delete from public.telemetry_rollups where day_kst = v_d;

    insert into public.telemetry_rollups(
      day_kst, dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a, updated_at
    )
    select v_d, r.dim_type, r.dim_key, r.sessions, r.hits, r.score, r.attempts, r.switches, r.measure_a, now()
    from public.telemetry_rollup_rows_for_day(v_d) r;
  end loop;

  return jsonb_build_object('ok', true, 'days', p_days);
end;
$function$;

-- CREATE OR REPLACE 는 기존 ACL 을 보존한다(0095 에서 exact-ACL 확립: owner + service_role 만).

-- ── 3) 백필: 신규 sess_* dim 만, 잔존 raw 가 있는 과거 일자에 한해 insert ──
do $backfill$
declare
  c_new_dims constant text[] := array[
    'sess_stat', 'sess_main_weapon', 'sess_start_map',
    'sess_sps_all', 'sess_sps_pure',
    'sess_perf_avg', 'sess_perf_p95', 'sess_perf_dev'
  ];
  v_min date;
  v_yesterday date := (now() at time zone 'Asia/Seoul')::date - 1;
  d date;
begin
  select min((started_at at time zone 'Asia/Seoul')::date) into v_min
  from public.telemetry_sessions;
  if v_min is null then
    return;
  end if;
  d := v_min;
  while d <= v_yesterday loop
    -- 멱등 재실행 안전: 신규 dim 만 지우고 다시 넣는다. 기존 weapon/map/funnel_step 행 무접촉.
    delete from public.telemetry_rollups
      where day_kst = d and dim_type = any(c_new_dims);
    insert into public.telemetry_rollups(
      day_kst, dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a, updated_at
    )
    select d, r.dim_type, r.dim_key, r.sessions, r.hits, r.score, r.attempts, r.switches, r.measure_a, now()
    from public.telemetry_rollup_rows_for_day(d) r
    where r.dim_type = any(c_new_dims);
    d := d + 1;
  end loop;
end;
$backfill$;

notify pgrst, 'reload schema';
