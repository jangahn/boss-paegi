-- 0116: 게임 분석 롤업에 패기 유형 분포(persona_games) 추가 (v1.14)
--
-- telemetry_rollup_rows_for_day(p_day) 가 cron(INSERT)·어드민 오늘 라이브(SELECT)의 단일 소스이므로
-- 여기에 차원을 더하면 하이브리드(오늘=raw·어제까지=롤업)가 자동 성립한다. 유형은 제출 시점 판정값
-- (score_stats.persona_id)을 쓴다 — 공유/히스토리처럼 통계 재계산이 아니라 그때 판정된 유형(SQL 에서
-- 판정 룰 재현 불가). 본문은 프로덕션 pg_get_functiondef 실측본(0115 반영) + union 멤버 1개 추가.

CREATE OR REPLACE FUNCTION public.telemetry_rollup_rows_for_day(p_day date)
 RETURNS TABLE(dim_type text, dim_key text, sessions integer, hits bigint, score bigint, attempts integer, switches integer, measure_a numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- lib/weapon-keys.ts WEAPON_KEYS 정의 순서(메인무기 동률 3순위 tie-break) — 무기 추가 시 함께 갱신.
  c_weapon_order constant text[] :=
    array['fist','hammer','slap','book','keyboard','paper','gun','grab','pinch','pen'];
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
  group by s.device_class
  union all
  -- 패기 유형 분포(v1.14) — 제출 시점 판정 유형(score_stats.persona_id). stats 는 공개(visible) 제출에서만
  -- 커밋되므로 = 공개 제출 게임. sessions=게임 수, score=점수 합(평균 산출용). 일자 = 제출 시각 KST.
  select 'persona_games'::text, st.persona_id,
    count(*)::int, 0::bigint, coalesce(sum(s.score), 0)::bigint, 0::int, 0::int, 0::numeric
  from public.score_stats st
  join public.scores s on s.id = st.score_id
  where st.persona_id is not null
    and s.created_at >= v_lo and s.created_at < v_hi
  group by st.persona_id;
end;
$function$;

-- 과거 일자 백필 — 원본(score_stats·scores)이 영구라 전 기간 정확. 신규 dim 만 insert(기존 행 무변경).
insert into public.telemetry_rollups(day_kst, dim_type, dim_key, sessions, hits, score, attempts, switches, measure_a)
select (s.created_at at time zone 'Asia/Seoul')::date, 'persona_games', st.persona_id,
  count(*)::int, 0, coalesce(sum(s.score), 0), 0, 0, 0
from public.score_stats st
join public.scores s on s.id = st.score_id
where st.persona_id is not null
  and (s.created_at at time zone 'Asia/Seoul')::date < (now() at time zone 'Asia/Seoul')::date
group by 1, 3
on conflict (day_kst, dim_type, dim_key) do nothing;
