-- 0120: 롤 7종 — 사장님(ceo)·신입(junior)·친구(friend) 신설, 동료(coworker)→친구 흡수 (v1.25, PR-B)
--
-- 앱 어휘 단일 소스 lib/roles/ids.ts 와 동일한 7종으로 DB 어휘를 맞춘다.
--  1) CHECK 3개 해제 → 리맵 → CHECK 3개 재정의(0017·0018·008901 이 만든 이름 유지).
--     리맵: dolls(24)·ai_generations(27)·generation_preflight_reservations 의 coworker → friend.
--     이미지·통계·점수는 불변(롤은 메타데이터, 0017 결정과 동일). 트리거: dolls 는 version/moderation_version 이
--     자동 증가(0007·0085), ai_generations 는 status 불변이라 전이 트리거 무영향, privacy fence 는 scrub 행에만
--     걸리며(적용 시점 실측 0건) 안전 위해 where 절로 제외한다.
--     ⚠ 순서가 중요하다: 구 CHECK 는 'friend' 를 거절하므로 리맵 전에 해제해야 하고, 신 CHECK 는 'coworker' 를
--     거절하므로 리맵 후에 걸어야 한다(빈 로컬 DB 에선 리맵이 no-op 이라 드러나지 않는다 — 프로덕션 1차 적용 실패 교훈).
--  2) allowlist 함수 2개 — 프로덕션 pg_get_functiondef 실측본(0079·0096 반영) + 한 줄 교체.
--  코드 배포 전에 적용해도 구 코드(5롤 쓰기)는 그대로 통과한다.

alter table public.dolls drop constraint if exists dolls_role_check;
alter table public.ai_generations drop constraint if exists ai_generations_role_check;
alter table public.generation_preflight_reservations drop constraint if exists generation_preflight_reservations_role_check;

update public.dolls set role = 'friend' where role = 'coworker';
update public.ai_generations set role = 'friend' where role = 'coworker' and privacy_scrubbed_at is null;
update public.generation_preflight_reservations r set role = 'friend'
 where r.role = 'coworker'
   and not exists (
     select 1 from public.ai_generations g
      where g.id = r.generation_id and g.privacy_scrubbed_at is not null
   );

alter table public.dolls add constraint dolls_role_check
  check (role in ('boss', 'ceo', 'exec', 'teamlead', 'client', 'junior', 'friend'));
alter table public.ai_generations add constraint ai_generations_role_check
  check (role in ('boss', 'ceo', 'exec', 'teamlead', 'client', 'junior', 'friend'));
alter table public.generation_preflight_reservations add constraint generation_preflight_reservations_role_check
  check (role in ('boss', 'ceo', 'exec', 'teamlead', 'client', 'junior', 'friend'));

-- request_doll_role_update — 프로덕션 실측본 + allowlist 한 줄 교체(0079 본문 유지).
CREATE OR REPLACE FUNCTION public.request_doll_role_update(p_user_id uuid, p_doll_id uuid, p_role text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_deleted_at timestamptz;
  v_doll public.dolls%rowtype;
begin
  if p_role not in ('boss', 'ceo', 'exec', 'teamlead', 'client', 'junior', 'friend') then
    raise exception 'invalid_role' using errcode = 'P0001';
  end if;
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  select *
    into v_doll
    from public.dolls
   where id = p_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;
  if v_doll.owner_id <> p_user_id then
    raise exception 'forbidden' using errcode = 'P0001';
  end if;
  if v_doll.deleted_at is not null then
    raise exception 'doll_unavailable' using errcode = 'P0001';
  end if;
  update public.dolls set role = p_role where id = p_doll_id;
  return pg_catalog.jsonb_build_object('ok', true, 'role', p_role);
end;
$function$;

-- claim_generation_preflight — 프로덕션 실측본(0096) + allowlist 한 줄 교체.
CREATE OR REPLACE FUNCTION public.claim_generation_preflight(p_user_id uuid, p_request_id uuid, p_role text, p_image_digest text, p_requires_credit boolean, p_worker_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '2s'
AS $function$
declare
  c_user_day_limit integer := 2147483647;
  c_global_day_limit integer := 2147483647;
  c_user_inflight_limit integer := 2147483647;
  c_global_inflight_limit integer := 2147483647;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date :=
    (pg_catalog.clock_timestamp() at time zone 'Asia/Seoul')::date;
  v_tomorrow timestamptz :=
    ((v_today + 1)::timestamp at time zone 'Asia/Seoul');
  v_today_start timestamptz :=
    (v_today::timestamp at time zone 'Asia/Seoul');
  v_existing public.generation_preflight_reservations%rowtype;
  v_deleted_at timestamptz;
  v_credits integer;
  v_user_day integer;
  v_global_day integer;
  v_user_inflight integer;
  v_global_inflight integer;
  v_generation_id uuid;
begin
  if p_user_id is null
     or p_request_id is null
     or p_role not in ('boss', 'ceo', 'exec', 'teamlead', 'client', 'junior', 'friend')
     or p_image_digest is null
     or p_image_digest !~ '^[0-9a-f]{64}$'
     or p_requires_credit is null
     or p_worker_id is null then
    raise exception 'invalid_generation_preflight'
      using errcode = '22023';
  end if;

  -- Immutable request identity first, then global/day, then canonical user.
  -- Every function touching the same request follows this order.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_existing
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if found then
    -- A paid generation row is created before any face/provider cost. Follow
    -- the canonical generation object->user lock order before touching the
    -- owner so a concurrent failure/refund or account mutation cannot invert
    -- locks.
    if v_existing.generation_id is null then
      raise exception 'preflight_generation_receipt_missing'
        using errcode = 'P0001';
    end if;
    perform public.bp_mutation_object_lock(
      'generation', v_existing.generation_id::text
    );
    perform public.bp_user_mutation_lock(p_user_id);
    select p.deleted_at
      into v_deleted_at
      from public.profiles p
     where p.id = p_user_id
     for key share;
    if not found or v_deleted_at is not null then
      raise exception 'account_deleted' using errcode = 'P0001';
    end if;
    if v_existing.owner_id <> p_user_id
       or v_existing.role <> p_role
       or v_existing.image_digest <> p_image_digest
       or v_existing.requires_credit <> p_requires_credit then
      raise exception 'preflight_idempotency_conflict'
        using errcode = 'P0001';
    end if;
    if v_existing.state in ('claimed', 'accepted')
       and v_existing.expires_at <= v_now then
      perform public.mark_generation_failed_and_refund(
        v_existing.generation_id,
        'preflight_claim_expired',
        null
      );
      update public.generation_preflight_reservations
         set state = 'expired',
             terminal_reason = 'claim_expired',
             analysis_lease_token = null,
             analysis_leased_until = null,
             finalized_at = v_now,
             updated_at = v_now
       where id = p_request_id;
      update public.ai_generations
         set cost_preflight_pending = false
       where id = v_existing.generation_id
         and cost_preflight_pending;
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'expired', 'reason', 'claim_expired'
      );
    end if;
    if v_existing.state = 'claimed' then
      if v_existing.analysis_lease_token = p_worker_id
         or v_existing.analysis_leased_until is null
         or v_existing.analysis_leased_until <= v_now then
        update public.generation_preflight_reservations
           set analysis_lease_token = p_worker_id,
               analysis_leased_until = v_now + interval '2 minutes',
               updated_at = v_now
         where id = p_request_id;
        return pg_catalog.jsonb_build_object(
          'ok', true, 'outcome', 'claimed'
        );
      end if;
      return pg_catalog.jsonb_build_object(
        'ok', true, 'outcome', 'processing'
      );
    elsif v_existing.state = 'accepted' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'accepted',
        'analysis', v_existing.analysis_result,
        'generation_config', v_existing.generation_config,
        'config_source', v_existing.config_source,
        'config_version', v_existing.config_version,
        'config_invalid', v_existing.config_invalid
      );
    elsif v_existing.state = 'committed' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'committed',
        'generation_id', v_existing.generation_id
      );
    elsif v_existing.state = 'rejected' then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'outcome', 'rejected',
        'reason', v_existing.terminal_reason
      );
    else
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'outcome', v_existing.state,
        'reason', v_existing.terminal_reason
      );
    end if;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight-day:' || v_today::text,
      0
    )
  );
  v_generation_id := pg_catalog.gen_random_uuid();
  perform public.bp_mutation_object_lock(
    'generation', v_generation_id::text
  );
  perform public.bp_user_mutation_lock(p_user_id);

  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  if p_requires_credit then
    select m.gen_credits
      into v_credits
      from public.member_accounts m
     where m.user_id = p_user_id
     for update;
    if not found or coalesce(v_credits, 0) < 1 then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'no_credits'
      );
    end if;
  end if;

  select pg_catalog.count(*)::integer
    into v_user_day
    from public.generation_preflight_reservations r
   where r.owner_id = p_user_id
     and r.created_at >= v_today_start
     and r.created_at < v_tomorrow;
  select pg_catalog.count(*)::integer
    into v_global_day
    from public.generation_preflight_reservations r
   where r.created_at >= v_today_start
     and r.created_at < v_tomorrow;
  select pg_catalog.count(*)::integer
    into v_user_inflight
    from public.generation_preflight_reservations r
   where r.owner_id = p_user_id
     and r.state in ('claimed', 'accepted')
     and r.expires_at > v_now;
  select pg_catalog.count(*)::integer
    into v_global_inflight
    from public.generation_preflight_reservations r
   where r.state in ('claimed', 'accepted')
     and r.expires_at > v_now;

  if v_user_day >= c_user_day_limit then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'user_day_quota'
    );
  end if;
  if v_global_day >= c_global_day_limit then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'global_day_quota'
    );
  end if;
  if v_user_inflight >= c_user_inflight_limit then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'user_inflight_quota'
    );
  end if;
  if v_global_inflight >= c_global_inflight_limit then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'global_inflight_quota'
    );
  end if;

  -- Create the financial generation receipt and consume its credit before
  -- returning a claim that authorizes any tmp upload or paid face call. The
  -- transaction rolls all of this back together on every error. Invalid-face,
  -- release, and expiry paths call the canonical terminal refund RPC.
  insert into public.ai_generations(
    id, owner_id, status, role, cost_preflight_pending
  )
  values (v_generation_id, p_user_id, 'queued', p_role, true);
  if p_requires_credit then
    v_credits := public.consume_gen_credit_v2(
      p_user_id, v_generation_id
    );
    if v_credits is null then
      raise exception 'insufficient_credits' using errcode = 'P0001';
    end if;
  else
    v_credits := null;
  end if;

  insert into public.generation_preflight_reservations(
    id,
    owner_id,
    role,
    image_digest,
    requires_credit,
    state,
    generation_id,
    expires_at,
    analysis_lease_token,
    analysis_leased_until
  )
  values (
    p_request_id,
    p_user_id,
    p_role,
    p_image_digest,
    p_requires_credit,
    'claimed',
    v_generation_id,
    v_now + interval '2 hours 15 minutes',
    p_worker_id,
    v_now + interval '2 minutes'
  );

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'claimed');
end;
$function$;

notify pgrst, 'reload schema';
