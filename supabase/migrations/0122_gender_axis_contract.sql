-- 0122: 캐릭터 성별 축 — contract (v1.26, PR-C)
--
-- 0121(expand) 뒤 코드가 배포되고 **마지막 4체크 예약이 만료된 뒤(claim expires_at = 2h15m)** 적용한다.
-- 얼굴검사 체크를 5개(face·count·covered·glasses·gender)로 고정: prepare 는 정확히 5 intent, finalize 는
-- checks 5개 + gender 필드, 준비 판정은 5/5. 4체크 호환 분기(0121)만 제거하며 다른 로직은 그대로다.
-- 적용 전 확인: select count(*) from generation_preflight_reservations where state='claimed' and
--   expires_at > now() and (select count(*) from generation_face_check_intents i where i.reservation_id=id) = 4  → 0.

-- ── prepare_generation_face_checks — 정확히 5 intent ────────────────────────
CREATE OR REPLACE FUNCTION public.prepare_generation_face_checks(p_user_id uuid, p_request_id uuid, p_worker_id uuid, p_generation_config jsonb, p_config_source text, p_config_version integer, p_config_invalid boolean, p_intents jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_terminal jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_count integer;
  v_distinct integer;
  v_invalid integer;
  v_ready integer;
  v_raw jsonb;
begin
  if p_user_id is null
     or p_request_id is null
     or p_worker_id is null
     or p_generation_config is null
     or pg_catalog.jsonb_typeof(p_generation_config) <> 'object'
     or pg_catalog.octet_length(p_generation_config::text) > 65536
     or p_config_source not in ('db', 'default')
     or (
       p_config_source = 'db'
       and (p_config_version is null or p_config_version < 1)
     )
     or (
       p_config_source = 'default'
       and p_config_version is not null
     )
     or p_config_invalid is null
     or p_intents is null
     or pg_catalog.jsonb_typeof(p_intents) <> 'array'
     or pg_catalog.jsonb_array_length(p_intents) <> 5
     or pg_catalog.octet_length(p_intents::text) > 65536 then
    raise exception 'invalid_generation_face_checks'
      using errcode = '22023';
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(distinct e->>'check_key')::integer,
    pg_catalog.count(*) filter (
      where
        pg_catalog.jsonb_typeof(e) <> 'object'
        or (e->>'check_key') not in (
          'face', 'count', 'covered', 'glasses', 'gender'
        )
        or (e->>'payload_hash') !~ '^[0-9a-f]{64}$'
        or (e->>'callback_token_hash') !~ '^[0-9a-f]{64}$'
        or pg_catalog.jsonb_typeof(e->'input') <> 'object'
        or (
          select pg_catalog.count(*)
            from pg_catalog.jsonb_object_keys(e->'input')
        ) <> 2
        or not ((e->'input') ? 'image_url')
        or not ((e->'input') ? 'prompt')
        or pg_catalog.octet_length(e->'input'->>'image_url')
             not between 1 and 4096
        or (e->'input'->>'image_url') !~ '^https?://'
        or e->'input'->>'prompt' <> case e->>'check_key'
          when 'face' then
            'Is there a clearly visible human face in this photo? Answer only yes or no.'
          when 'count' then
            'How many people are in this photo? Answer with a single number only.'
          when 'covered' then
            'Is any part of the person''s face covered or blocked by a hand, fingers, or an object? Answer only yes or no.'
          when 'glasses' then
            'Is the person wearing eyeglasses or sunglasses? Answer only yes or no.'
          when 'gender' then
            'Is the person in this photo a man or a woman? Answer only man or woman.'
          else null
        end
    )::integer
    into v_count, v_distinct, v_invalid
    from pg_catalog.jsonb_array_elements(p_intents) e;
  if v_count <> 5 or v_distinct <> 5 or v_invalid <> 0 then
    raise exception 'invalid_generation_face_checks'
      using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.state <> 'claimed' then
    raise exception 'generation_face_checks_forbidden'
      using errcode = 'P0001';
  end if;
  if v_reservation.analysis_lease_token <> p_worker_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'lease_lost'
    );
  end if;

  if v_reservation.generation_config is null then
    update public.generation_preflight_reservations
       set generation_config = p_generation_config,
           config_source = p_config_source,
           config_version = p_config_version,
           config_invalid = p_config_invalid,
           updated_at = v_now
     where id = p_request_id;
  else
    -- The first durable snapshot wins. A retry after config publication or a
    -- deployment change must resume it rather than conflict or drift output.
    null;
  end if;

  insert into public.generation_face_check_intents(
    reservation_id,
    check_key,
    input_payload,
    payload_hash,
    callback_token_hash
  )
  select
    p_request_id,
    e->>'check_key',
    e->'input',
    e->>'payload_hash',
    e->>'callback_token_hash'
  from pg_catalog.jsonb_array_elements(p_intents) e
  on conflict (reservation_id, check_key) do nothing;

  -- A crash after atomic prepare but before a child claim may leave a signed
  -- input URL aging. Only never-attempted rows can be rebound to the fresh
  -- URL/token/hash. submitting/uncertain/acknowledged rows retain their exact
  -- original binding forever and can only converge through webhook/recovery.
  update public.generation_face_check_intents i
     set input_payload = e.value->'input',
         payload_hash = e.value->>'payload_hash',
         callback_token_hash = e.value->>'callback_token_hash',
         updated_at = v_now
    from pg_catalog.jsonb_array_elements(p_intents) e(value)
   where i.reservation_id = p_request_id
     and i.check_key = e.value->>'check_key'
     and i.state = 'planned'
     and not exists (
       select 1
         from public.generation_face_check_cost_attempts a
        where a.reservation_id = i.reservation_id
          and a.check_key = i.check_key
     );

  select
    pg_catalog.count(*)::integer,
    pg_catalog.jsonb_object_agg(i.check_key, i.raw_output)
    into v_ready, v_raw
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.state = 'succeeded';
  if v_ready = 5 then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'ready', 'raw_outputs', v_raw
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'prepared'
  );
end;
$function$;

-- ── finalize_generation_face_checks — checks 정확히 5 + gender 필수 ────────────
CREATE OR REPLACE FUNCTION public.finalize_generation_face_checks(p_request_id uuid, p_analysis jsonb, p_failure_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_ready integer;
  v_invalid integer;
  v_terminal jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_found'
    );
  end if;
  if v_reservation.state = 'accepted' then
    if v_reservation.analysis_result <> p_analysis then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'result_conflict'
      );
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'accepted'
    );
  end if;
  if v_reservation.state <> 'claimed' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', v_reservation.state
    );
  end if;

  select pg_catalog.count(*)::integer
    into v_ready
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.state = 'succeeded';
  if p_failure_reason is not null then
    if p_failure_reason !~ '^[a-z0-9_]{1,100}$'
       or v_ready <> 5 then
      raise exception 'invalid_generation_face_check_result'
        using errcode = '22023';
    end if;
    v_terminal := public.mark_generation_failed_and_refund(
      v_reservation.generation_id,
      'preflight_' || p_failure_reason,
      null
    );
    if v_terminal is null
       or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
       or v_terminal->'ok' is distinct from 'true'::jsonb then
      raise exception 'preflight_refund_unconfirmed'
        using errcode = 'P0001';
    end if;
    update public.generation_preflight_reservations
       set state = case
             when p_failure_reason in (
               'no_face', 'multiple_people', 'face_obstructed'
             ) then 'rejected'
             else 'failed'
           end,
           analysis_result = p_analysis,
           terminal_reason = p_failure_reason,
           analysis_lease_token = null,
           analysis_leased_until = null,
           finalized_at = v_now,
           updated_at = v_now
     where id = p_request_id;
    update public.ai_generations
       set cost_preflight_pending = false
     where id = v_reservation.generation_id
       and cost_preflight_pending;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', case
        when p_failure_reason in (
          'no_face', 'multiple_people', 'face_obstructed'
        ) then 'rejected'
        else 'failed'
      end
    );
  end if;
  if p_analysis is null
     or pg_catalog.jsonb_typeof(p_analysis) <> 'object'
     or pg_catalog.octet_length(p_analysis::text) > 16384
     or v_ready <> 5
     or p_analysis->>'model' <> 'fal-ai/moondream3-preview/query'
     or p_analysis->>'status' <> 'ok'
     or (p_analysis->>'gender') not in ('male', 'female', 'unknown')
     or pg_catalog.jsonb_typeof(p_analysis->'checks') <> 'array'
     or pg_catalog.jsonb_array_length(p_analysis->'checks') <> 5 then
    raise exception 'invalid_generation_face_check_result'
      using errcode = '22023';
  end if;
  select pg_catalog.count(*)::integer
    into v_invalid
    from pg_catalog.jsonb_array_elements(
      p_analysis->'checks'
    ) with ordinality c(value, position)
    left join public.generation_face_check_intents i
      on i.reservation_id = p_request_id
     and i.check_key = c.value->>'key'
   where i.reservation_id is null
      or i.state <> 'succeeded'
      or c.value->>'rawOutput' is distinct from i.raw_output
      or c.value->>'prompt' <> case c.position
        when 1 then
          'Is there a clearly visible human face in this photo? Answer only yes or no.'
        when 2 then
          'How many people are in this photo? Answer with a single number only.'
        when 3 then
          'Is any part of the person''s face covered or blocked by a hand, fingers, or an object? Answer only yes or no.'
        when 4 then
          'Is the person wearing eyeglasses or sunglasses? Answer only yes or no.'
        when 5 then
          'Is the person in this photo a man or a woman? Answer only man or woman.'
        else null
      end
      or c.value->>'key' <> case c.position
        when 1 then 'face'
        when 2 then 'count'
        when 3 then 'covered'
        when 4 then 'glasses'
        when 5 then 'gender'
        else null
      end;
  if v_invalid <> 0 then
    raise exception 'invalid_generation_face_check_result'
      using errcode = '22023';
  end if;
  if (
    select pg_catalog.count(distinct c.value->>'key')
      from pg_catalog.jsonb_array_elements(p_analysis->'checks') c(value)
  ) <> 5 then
    raise exception 'invalid_generation_face_check_result'
      using errcode = '22023';
  end if;
  update public.generation_preflight_reservations
     set state = 'accepted',
         analysis_result = p_analysis,
         analysis_lease_token = null,
         analysis_leased_until = null,
         updated_at = v_now
   where id = p_request_id;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'accepted'
  );
end;
$function$;

-- ── record_generation_face_check_webhook — 준비 = 5/5 ─────────────────────────
CREATE OR REPLACE FUNCTION public.record_generation_face_check_webhook(p_request_id uuid, p_check_key text, p_payload_hash text, p_callback_token_hash text, p_external_request_id text, p_status text, p_raw_output text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_intent public.generation_face_check_intents%rowtype;
  v_terminal jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
  v_ready integer;
  v_raw jsonb;
begin
  if p_status not in ('OK', 'ERROR')
     or p_external_request_id is null
     or pg_catalog.octet_length(p_external_request_id)
          not between 1 and 256
     or (
       p_status = 'OK'
       and (
         p_raw_output is null
         or pg_catalog.octet_length(p_raw_output) > 200
       )
     )
     or (p_status = 'ERROR' and p_raw_output is not null) then
    raise exception 'invalid_generation_face_check_webhook'
      using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-preflight:' || p_request_id::text,
      0
    )
  );
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id;
  if not found or v_reservation.generation_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'binding_conflict'
    );
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
  );
  perform public.bp_user_mutation_lock(v_reservation.owner_id);
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  select *
    into v_intent
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.check_key = p_check_key
   for update;
  if not found
     or v_intent.payload_hash <> p_payload_hash
     or v_intent.callback_token_hash <> p_callback_token_hash then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'binding_conflict'
    );
  end if;
  if v_intent.external_request_id is not null
     and v_intent.external_request_id <> p_external_request_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'request_id_conflict'
    );
  end if;
  if v_intent.state = 'succeeded' then
    if v_intent.raw_output <> p_raw_output then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'outcome', 'result_conflict'
      );
    end if;
  elsif v_intent.state = 'rejected' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'rejected',
      'owner_id', v_reservation.owner_id
    );
  elsif v_intent.state in (
    'submitting', 'uncertain', 'acknowledged'
  ) then
    if p_status = 'ERROR' then
      update public.generation_face_check_intents
         set state = 'rejected',
             external_request_id = p_external_request_id,
             completed_at = v_now,
             updated_at = v_now
       where reservation_id = p_request_id
         and check_key = p_check_key;
      v_terminal := public.mark_generation_failed_and_refund(
        v_reservation.generation_id,
        'preflight_face_check_provider_error',
        null
      );
      if v_terminal is null
         or pg_catalog.jsonb_typeof(v_terminal) <> 'object'
         or v_terminal->'ok' is distinct from 'true'::jsonb then
        raise exception 'preflight_refund_unconfirmed'
          using errcode = 'P0001';
      end if;
      update public.generation_preflight_reservations
         set state = 'failed',
             terminal_reason = 'face_check_provider_error',
             analysis_lease_token = null,
             analysis_leased_until = null,
             finalized_at = v_now,
             updated_at = v_now
       where id = p_request_id
         and state = 'claimed';
      update public.ai_generations
         set cost_preflight_pending = false
       where id = v_reservation.generation_id
         and cost_preflight_pending;
      return pg_catalog.jsonb_build_object(
        'ok', true, 'outcome', 'rejected',
        'owner_id', v_reservation.owner_id
      );
    end if;
    update public.generation_face_check_intents
       set state = 'succeeded',
           external_request_id = p_external_request_id,
           raw_output = p_raw_output,
           completed_at = v_now,
           updated_at = v_now
     where reservation_id = p_request_id
       and check_key = p_check_key;
  else
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'state_conflict'
    );
  end if;

  select
    pg_catalog.count(*)::integer,
    pg_catalog.jsonb_object_agg(i.check_key, i.raw_output)
    into v_ready, v_raw
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.state = 'succeeded';
  if v_ready = 5 then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'ready',
      'owner_id', v_reservation.owner_id,
      'raw_outputs', v_raw
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'recorded'
  );
end;
$function$;

notify pgrst, 'reload schema';
