-- 0111: 공유·유입 분석 하이브리드(오늘=raw 라이브·과거=일별 롤업) — 집계 정의 단일 소스화.
--
-- 0110(텔레메트리)과 동일 설계: `analytics_rollup_rows_for_day(p_day)` 가 하루치 집계의 단일 소스.
-- cron(`maintain_analytics_rollups`)은 이 함수 출력을 INSERT 하고, 어드민 getter 는 같은 함수를
-- p_day=오늘로 직접 SELECT(라이브)한다. 어드민은 롤업을 `day_kst < 오늘` 만 읽는다.
-- metric 별 dim 의미는 0049/0095 와 문자 그대로 동일(주석은 0049 참조). 신규 metric 없음.
-- pgTAP analytics_maintenance_bounds 의 본문 마커(검증→lock→loop)·무조건 metric 3종/일 계약 유지.
-- 격리 도메인 불변(analytics_* 전용 + scores 읽기집계) — 0049 의 불변 규칙 그대로.

-- ── 1) 하루치 집계 단일 소스 ────────────────────────────────────────────────
create or replace function public.analytics_rollup_rows_for_day(p_day date)
returns table(
  metric text,
  dim1 text,
  dim2 text,
  dim3 text,
  dim4 text,
  value bigint
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_lo timestamptz;
  v_hi timestamptz;
begin
  if p_day is null then
    raise exception 'analytics_rollup_rows_for_day_invalid_day' using errcode = '22023';
  end if;
  v_lo := (p_day::timestamp at time zone 'Asia/Seoul');
  v_hi := ((p_day + 1)::timestamp at time zone 'Asia/Seoul');

  return query
  -- visit_by_source(d1=source_scope, d2=source_kind, d3=source_value)
  select 'visit_by_source'::text,
    coalesce(e.source_scope, ''), coalesce(e.source_kind, ''), coalesce(e.source_value, ''), ''::text,
    count(*)::bigint
  from public.analytics_events e
  where e.kind = 'visit' and e.day_kst = p_day
  group by e.source_scope, e.source_kind, e.source_value
  union all
  -- viral_inbound_by_type(d1=viral_type) — first_touch + viral visit
  select 'viral_inbound_by_type'::text, coalesce(e.viral_type, ''), ''::text, ''::text, ''::text, count(*)::bigint
  from public.analytics_events e
  where e.kind = 'visit' and e.source_scope = 'first_touch' and e.source_kind = 'viral' and e.day_kst = p_day
  group by e.viral_type
  union all
  -- share 분포
  select 'share_by_surface'::text, coalesce(e.surface, ''), ''::text, ''::text, ''::text, count(*)::bigint
  from public.analytics_events e
  where e.kind = 'share' and e.day_kst = p_day
  group by e.surface
  union all
  select 'share_by_target'::text, coalesce(e.target, ''), ''::text, ''::text, ''::text, count(*)::bigint
  from public.analytics_events e
  where e.kind = 'share' and e.day_kst = p_day
  group by e.target
  union all
  select 'share_by_score_tier'::text, coalesce(e.score_tier::text, ''), ''::text, ''::text, ''::text, count(*)::bigint
  from public.analytics_events e
  where e.kind = 'share' and e.target = 'score' and e.day_kst = p_day
  group by e.score_tier
  union all
  select 'share_by_member_state'::text, e.member_state, ''::text, ''::text, ''::text, count(*)::bigint
  from public.analytics_events e
  where e.kind = 'share' and e.day_kst = p_day
  group by e.member_state
  union all
  -- 게임오버 공유(전환 분자): surface=game_over AND target=score (무조건 1행/일)
  select 'share_game_over'::text, ''::text, ''::text, ''::text, ''::text, count(*)::bigint
  from public.analytics_events e
  where e.kind = 'share' and e.surface = 'game_over' and e.target = 'score' and e.day_kst = p_day
  union all
  -- 전환(source별)
  select 'conversion_play_by_source'::text, coalesce(e.source_kind, ''), coalesce(e.source_value, ''), ''::text, ''::text, count(*)::bigint
  from public.analytics_events e
  where e.kind = 'conversion' and e.conversion_step = 'play' and e.day_kst = p_day
  group by e.source_kind, e.source_value
  union all
  select 'conversion_signup_by_source'::text, coalesce(e.source_kind, ''), coalesce(e.source_value, ''), ''::text, ''::text, count(*)::bigint
  from public.analytics_events e
  where e.kind = 'conversion' and e.conversion_step = 'signup' and e.day_kst = p_day
  group by e.source_kind, e.source_value
  union all
  -- score_submit(전환 분모) + play_session(볼륨): scores KST day 읽기집계(무조건 각 1행/일)
  select 'score_submit'::text, ''::text, ''::text, ''::text, ''::text, count(*)::bigint
  from public.scores s
  where s.created_at >= v_lo and s.created_at < v_hi
  union all
  select 'play_session'::text, ''::text, ''::text, ''::text, ''::text, count(distinct s.telemetry_session_id)::bigint
  from public.scores s
  where s.created_at >= v_lo and s.created_at < v_hi and s.telemetry_session_id is not null;
end;
$$;

revoke all on function public.analytics_rollup_rows_for_day(date) from public, anon, authenticated;
grant execute on function public.analytics_rollup_rows_for_day(date) to service_role;

-- ── 2) cron 롤업을 단일 소스 소비자로 재작성(0095 검증·lock·loop 마커 보존) ──
create or replace function public.maintain_analytics_rollups(
  p_days int default 7
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $function$
declare
  c_min_days constant int := 1;
  c_max_days constant int := 91;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_d date;
  i int;
begin
  if p_days is null or p_days not between c_min_days and c_max_days then
    raise exception 'maintain_analytics_rollups_invalid_days'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('analytics_rollups')
  );

  for i in 0 .. p_days - 1 loop
    v_d := v_today - i;

    delete from public.analytics_rollups where day_kst = v_d;

    insert into public.analytics_rollups(
      day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at
    )
    select v_d, r.metric, r.dim1, r.dim2, r.dim3, r.dim4, r.value, now()
    from public.analytics_rollup_rows_for_day(v_d) r;
  end loop;

  return jsonb_build_object('ok', true, 'days', p_days);
end;
$function$;

-- CREATE OR REPLACE 는 기존 exact-ACL(owner + service_role) 을 보존한다(0095).

notify pgrst, 'reload schema';
