-- 0113: utm_medium·utm_campaign 하드 제거 (v1.09, 2026-08-29 사용자 결정).
--
-- 근거(전수 실측): 두 필드는 수집·저장·검증에만 존재하고 소비처가 0 — 롤업 dim 에 없고,
-- 어드민 미표시, 소스 판정(source_value)은 utm_source 만 쓴다. 운영 방침이 "utm_source
-- 1차원에 세부 인코딩"으로 확정돼 영구 불용 표면이므로 최소수집 원칙에 따라 소멸시킨다.
-- 재도입이 필요해지면 additive 컬럼 추가로 충분(과거 raw 는 어차피 90일 소멸).
--
-- 무중단 근거: 적재 RPC(record_public_analytics_event)는 p_event **jsonb** 를 받으므로
-- 시그니처 불변 — 구 코드가 두 키를 계속 보내도 새 본문이 읽지 않을 뿐이다(키 무시).
-- 순서: ①함수 본문 교체(컬럼 참조 제거) ②kind_shape 제약 재정의 ③컬럼 drop — 한 트랜잭션.

begin;

-- ── 1) 적재 RPC 본문 교체 — prod pg_get_functiondef 를 정본으로 두 필드 참조만 제거 ──
CREATE OR REPLACE FUNCTION public.record_public_analytics_event(p_actor_key text, p_member_state text, p_event jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '250ms'
AS $function$
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
      viral_type
    )
    values (
      'visit',
      p_member_state,
      p_event->>'source_scope',
      p_event->>'source_kind',
      p_event->>'source_value',
      p_event->>'referrer_domain',
      p_event->>'utm_source',
      p_event->>'viral_type'
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
$function$;
-- CREATE OR REPLACE 는 기존 exact-ACL(service_role only)을 보존한다.

-- ── 2) kind_shape 제약 재정의(share 분기의 두 IS NULL 항 제거 — 나머지는 prod 정의 그대로) ──
alter table public.analytics_events drop constraint analytics_events_kind_shape;
alter table public.analytics_events add constraint analytics_events_kind_shape check (
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
      and viral_type is null
    )
    when 'conversion' then (
      conversion_step is not null and source_scope = 'first_touch'
      and source_kind is not null and source_value is not null
      and surface is null and target is null and score_tier is null and result is null
    )
    else false
  end
);

-- ── 3) 컬럼·데이터 소멸 ──
alter table public.analytics_events drop column utm_medium;
alter table public.analytics_events drop column utm_campaign;

notify pgrst, 'reload schema';
commit;
