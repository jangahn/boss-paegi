-- 0114: analytics_events.landing — 진입 페이지(세션 단위) 측정 (v1.10)
--
-- 배경: 유입 카드는 "어디서 왔나"(source)만 알고 "어디로 들어왔나"는 몰랐다. lottogen 에는 있는
-- 랜딩 지표를 같은 개념·같은 용어로 이식한다. 저장은 경로 첫 세그먼트를 화이트리스트로 축약한
-- 토큰뿐이고 원본 URL·쿼리·식별자는 저장하지 않는다(무PII 원칙 불변).
--
-- 세션 단위: 클라의 기존 CURRENT_VISIT_KEY(탭세션 1회) 플래그가 그대로 보장한다 — 추가 게이트 없음.
-- 기존 지표 무영향: 칼럼은 nullable 추가, 기존 metric 계산식 무수정, RPC 시그니처 불변.
-- 과거 소급 불가: 배포 이전 행은 landing NULL → 집계에서 '' 버킷('수집 전')으로 노출한다.

alter table public.analytics_events add column if not exists landing text;

-- 허용 토큰(클라·서버 화이트리스트와 동일 목록). source_kind_check 와 같은 형태로 fail-closed.
alter table public.analytics_events drop constraint if exists analytics_events_landing_check;
alter table public.analytics_events
  add constraint analytics_events_landing_check
  check (
    landing is null or landing = any (array[
      'home','play','gallery','leaderboard','generate','doll','share','history',
      'news','badges','account','credits','faq','terms','privacy','login','other'
    ]::text[])
  );

-- kind_shape 확장 — landing 은 visit 전용(share·conversion 에 섞이면 거부).
-- visit 은 NULL 허용: 배포 이전 행이 전부 NULL 이라 NOT NULL 을 걸면 기존 데이터가 위반한다.
alter table public.analytics_events drop constraint analytics_events_kind_shape;
alter table public.analytics_events
  add constraint analytics_events_kind_shape
  check (
    case kind
      when 'visit' then (
        source_scope is not null and source_kind is not null and source_value is not null
        and surface is null and target is null and score_tier is null
        and conversion_step is null and result is null
      )
      when 'share' then (
        surface is not null and target is not null
        and (target = 'score' or score_tier is null)
        and conversion_step is null and source_scope is null and source_kind is null
        and source_value is null and referrer_domain is null and utm_source is null
        and viral_type is null and landing is null
      )
      when 'conversion' then (
        conversion_step is not null and source_scope = 'first_touch'
        and source_kind is not null and source_value is not null
        and surface is null and target is null and score_tier is null and result is null
        and landing is null
      )
      else false
    end
  );

-- 롤업 metric 허용 목록에도 visit_by_landing 을 더한다.
-- (함수만 고치면 테이블 CHECK 에서 거부된다 — CI pgTAP 가 실측으로 잡아준 지점.)
alter table public.analytics_rollups drop constraint analytics_rollups_metric_check;
alter table public.analytics_rollups
  add constraint analytics_rollups_metric_check
  check (metric = any (array[
    'visit_by_source','visit_by_landing','share_by_surface','share_by_target',
    'share_by_score_tier','share_by_member_state','share_game_over','score_submit',
    'play_session','conversion_play_by_source','conversion_signup_by_source',
    'viral_inbound_by_type'
  ]::text[]));

-- ── 적재 RPC — 프로드 실물 정의를 그대로 가져와 visit 분기에만 landing 을 추가한다.
--    (통째 재작성 금지: 원본의 exception 핸들러(quota_busy) 같은 계약이 소실될 수 있다.)
CREATE OR REPLACE FUNCTION public.record_public_analytics_event(p_actor_key text, p_member_state text, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '250ms'
AS $$
declare
  v_kind text;
  v_quota text;
  v_score_tier smallint;
begin
  if p_member_state not in ('anon', 'member')
     or p_event is null
     or pg_catalog.jsonb_typeof(p_event) <> 'object' then
    raise exception 'invalid_public_analytics_event'
      using errcode = 'P0001';
  end if;
  v_kind := p_event->>'kind';
  if v_kind not in ('visit', 'share', 'conversion') then
    raise exception 'invalid_public_analytics_event'
      using errcode = 'P0001';
  end if;

  v_quota := public.bp_consume_public_write_quota(
    'track', p_actor_key, false
  );
  if v_quota <> 'accepted' then
    return pg_catalog.jsonb_build_object(
      'accepted', false, 'reason', v_quota
    );
  end if;

  if v_kind = 'visit' then
    insert into public.analytics_events(
      kind,
      member_state,
      source_scope,
      source_kind,
      source_value,
      referrer_domain,
      utm_source,
      viral_type,
      landing
    )
    values (
      'visit',
      p_member_state,
      p_event->>'source_scope',
      p_event->>'source_kind',
      p_event->>'source_value',
      p_event->>'referrer_domain',
      p_event->>'utm_source',
      p_event->>'viral_type',
      p_event->>'landing'
    );
  elsif v_kind = 'share' then
    if pg_catalog.jsonb_typeof(p_event->'score_tier') = 'number' then
      v_score_tier := (p_event->>'score_tier')::smallint;
    end if;
    insert into public.analytics_events(
      kind,
      member_state,
      surface,
      target,
      score_tier,
      result
    )
    values (
      'share',
      p_member_state,
      p_event->>'surface',
      p_event->>'target',
      v_score_tier,
      p_event->>'result'
    );
  else
    if p_event->>'conversion_step' not in ('play', 'signup') then
      raise exception 'invalid_public_analytics_event'
        using errcode = 'P0001';
    end if;
    insert into public.analytics_events(
      kind,
      member_state,
      source_scope,
      source_kind,
      source_value,
      referrer_domain,
      utm_source,
      viral_type,
      conversion_step
    )
    values (
      'conversion',
      p_member_state,
      p_event->>'source_scope',
      p_event->>'source_kind',
      p_event->>'source_value',
      p_event->>'referrer_domain',
      p_event->>'utm_source',
      p_event->>'viral_type',
      p_event->>'conversion_step'
    );
  end if;

  return pg_catalog.jsonb_build_object('accepted', true);
exception
  when lock_not_available or query_canceled then
    return pg_catalog.jsonb_build_object(
      'accepted', false, 'reason', 'quota_busy'
    );
end;
$$;

revoke all on function public.record_public_analytics_event(text, text, jsonb) from public, anon, authenticated;
grant execute on function public.record_public_analytics_event(text, text, jsonb) to service_role;

-- ── 롤업 소스 RPC — 프로드 실물 정의에 visit_by_landing 메트릭 한 줄만 추가.
--    오늘(라이브)·과거(롤업) 가 같은 함수를 지나가므로 기간 창 계약이 자동으로 따라온다.
--    반환 시그니처 불변 → create or replace 로 충분(권한 재부여는 안전하게 함께).
CREATE OR REPLACE FUNCTION public.analytics_rollup_rows_for_day(p_day date)
 RETURNS TABLE(metric text, dim1 text, dim2 text, dim3 text, dim4 text, value bigint)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $$
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
  -- visit_by_landing(d1=source_scope, d2=landing) — 진입 페이지. 세션 단위 카드는 d1='current' 만 집계
  -- (채널 카드와 같은 규율). landing NULL(수집 이전 행)은 '' 버킷 = 어드민에서 '수집 전'.
  select 'visit_by_landing'::text,
    coalesce(e.source_scope, ''), coalesce(e.landing, ''), ''::text, ''::text,
    count(*)::bigint
  from public.analytics_events e
  where e.kind = 'visit' and e.day_kst = p_day
  group by e.source_scope, e.landing
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
