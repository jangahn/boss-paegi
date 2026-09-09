-- 0124: 유입 원본 저장 — UA 원문 · 외부 레퍼러 전체 URL (2026-09-09, v1.31)
-- '직접' 유입의 실체를 방문 단위로 특정할 수 없었다(레퍼러 도메인·정규화 소스만 저장). 통제할 수 없는 경로를
-- 분석하려면 UA 를 미리 파싱한 버킷이 아니라 원문을 남겨야 한다 — 분류는 분석 시점에(어드민 원본 이벤트 뷰어가 읽는다).
--  · ua           — 서버가 요청 헤더에서 읽어 전 kind 에 기록(클라 값 불신, 512자)
--  · referrer_url — 방문 비콘의 document.referrer 를 서버 sanitize(http(s)/android-app, fragment 제거, 1024자)한 값. visit 전용
-- 보존은 기존 raw 90일 prune 그대로. 개인정보처리방침 v1 1항 유입 줄은 같은 날 in-place 교체(사용자 결정, 버전·시행일 유지).
-- 무중단: RPC 는 p_event jsonb 시그니처 불변 — 구 클라(키 없음)는 null 로 들어온다. 컬럼 추가 → CHECK 재정의 → RPC 교체 순.

alter table public.analytics_events add column if not exists ua text;
alter table public.analytics_events add column if not exists referrer_url text;

-- kind_shape: referrer_url 은 visit 전용(ua 는 전 kind 허용). 0114 정의 + 두 항.
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
        and viral_type is null and landing is null and referrer_url is null
      )
      when 'conversion' then (
        conversion_step is not null and source_scope = 'first_touch'
        and source_kind is not null and source_value is not null
        and surface is null and target is null and score_tier is null and result is null
        and landing is null and referrer_url is null
      )
      else false
    end
  );

-- 적재 RPC — 0114 본문 + ua(전 kind)·referrer_url(visit). DB 쪽도 방어적으로 길이를 자른다(빈 문자열은 null).
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
  v_ua text;
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
  v_ua := nullif(pg_catalog.left(p_event->>'ua', 512), '');
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
      landing,
      ua,
      referrer_url
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
      p_event->>'landing',
      v_ua,
      nullif(pg_catalog.left(p_event->>'referrer_url', 1024), '')
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
      result,
      ua
    )
    values (
      'share',
      p_member_state,
      p_event->>'surface',
      p_event->>'target',
      v_score_tier,
      p_event->>'result',
      v_ua
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
      conversion_step,
      ua
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
      p_event->>'conversion_step',
      v_ua
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
