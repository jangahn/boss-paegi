-- 0096_generation_quota_relax.sql
--
-- 2026-07-31 제품 오너 결정: QA(008901)가 도입한 생성 일일/인플라이트 쿼터는
-- 제품 정책이 아니므로 상한을 사실상 무제한(int4 max)으로 되돌린다. 크레딧
-- 차감·환불·exactly-once 제출 saga·예약 상태기계는 그대로 유지되며, 비용
-- 통제는 QA 이전과 동일하게 크레딧과 fal 잔액 캡이 담당한다. 두 함수는
-- 008901 본문의 byte-copy에 네 상수만 바꾼 것이다.

begin;
set local lock_timeout = '5s';
set local statement_timeout = '2min';

create or replace function public.claim_generation_preflight(
  p_user_id uuid,
  p_request_id uuid,
  p_role text,
  p_image_digest text,
  p_requires_credit boolean,
  p_worker_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '2s'
as $$
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
     or p_role not in ('boss', 'exec', 'teamlead', 'client', 'coworker')
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
$$;

create or replace function public.prepare_generation_pick_submit(
  p_user_id uuid,
  p_generation_id uuid,
  p_attempt_id uuid,
  p_input_payload jsonb,
  p_payload_hash text,
  p_callback_token_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_user_day_limit integer := 2147483647;
  c_global_day_limit integer := 2147483647;
  v_intent public.generation_pick_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_today date := (v_now at time zone 'Asia/Seoul')::date;
  v_deleted_at timestamptz;
  v_user_day integer;
  v_global_day integer;
begin
  if p_input_payload is null
     or pg_catalog.jsonb_typeof(p_input_payload) <> 'object'
     or p_input_payload <> pg_catalog.jsonb_build_object(
       'image_url', p_input_payload->>'image_url',
       'output_format', 'png'
     )
     or pg_catalog.octet_length(p_input_payload->>'image_url')
          not between 1 and 4096
     or p_input_payload->>'image_url' !~ '^https://'
     or p_payload_hash !~ '^[0-9a-f]{64}$'
     or p_callback_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_generation_pick_submit' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick:' || p_generation_id::text,
      0
    )
  );
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick-cost-day:' || v_today::text,
      0
    )
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select p.deleted_at
    into v_deleted_at
    from public.profiles p
   where p.id = p_user_id
   for key share;
  if not found or v_deleted_at is not null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'account_deleted'
    );
  end if;
  select *
    into v_intent
    from public.generation_pick_intents i
   where i.generation_id = p_generation_id
   for update;
  if not found
     or v_intent.owner_id <> p_user_id
     or v_intent.attempt_id <> p_attempt_id then
    raise exception 'pick_submit_forbidden' using errcode = 'P0001';
  end if;
  if v_intent.state = 'claimed' then
    select pg_catalog.count(*)::integer
      into v_user_day
      from public.generation_pick_cost_attempts a
     where a.owner_id = p_user_id
       and a.day_kst = v_today;
    select pg_catalog.count(*)::integer
      into v_global_day
      from public.generation_pick_cost_attempts a
     where a.day_kst = v_today;
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
    insert into public.generation_pick_cost_attempts(
      attempt_id, generation_id, owner_id, day_kst, created_at
    )
    values (
      p_attempt_id, p_generation_id, p_user_id, v_today, v_now
    );
    update public.generation_pick_intents
       set state = 'submitting',
           input_payload = p_input_payload,
           payload_hash = p_payload_hash,
           callback_token_hash = p_callback_token_hash,
           external_started_at = v_now,
           expires_at = v_now + interval '2 hours 5 minutes',
           updated_at = v_now
     where generation_id = p_generation_id;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'prepared'
    );
  end if;
  if v_intent.input_payload = p_input_payload
     and v_intent.payload_hash = p_payload_hash
     and v_intent.callback_token_hash = p_callback_token_hash then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', v_intent.state
    );
  end if;
  raise exception 'pick_submit_binding_conflict' using errcode = 'P0001';
end;
$$;

notify pgrst, 'reload schema';
commit;
