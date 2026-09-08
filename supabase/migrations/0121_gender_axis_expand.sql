-- 0121: 캐릭터 성별 축 — expand (v1.26, PR-C)
--
-- 얼굴검사 5번째 단일질문(gender)으로 남/여를 판정해 생성 프롬프트(롤×성별 subject/body)와 보이스(롤×성별
-- 시비 멘트·피격 반응)를 분기한다. 저장: ai_generations.gender(commit_generation_preflight 가 analysis_result 로
-- 유도) → dolls.gender(commit_generation_pick 이 복사). 레거시·판정 불가·기본 부장님은 전부 male(NOT NULL DEFAULT).
-- 어드민은 캐릭터 상세에서 후처리로 바꾼다(admin_update_doll_gender_idempotent, 0085 receipt + dolls.version CAS).
--
-- 무중단 순서: 이 파일(expand) → 코드 배포 → 마지막 4체크 예약이 만료된 뒤(≥2h15m) 0122(contract, 5체크 고정).
--  · 구 코드(4체크)·신 코드(5체크) 모두 통과: prepare 는 4|5 intent, finalize/webhook 준비 판정은 "이 예약의
--    intent 전부 succeeded"(개수 상수 4 → 예약별 총수). CHECK 어휘에 'gender' 추가.
--  · 함수 본문은 프로덕션 pg_get_functiondef 실측본(0096·0118 반영) + 표시된 줄만 교체.

-- ── 1) 컬럼 ─────────────────────────────────────────────────────────────────
alter table public.ai_generations
  add column if not exists gender text not null default 'male';
alter table public.ai_generations drop constraint if exists ai_generations_gender_check;
alter table public.ai_generations add constraint ai_generations_gender_check
  check (gender in ('male', 'female'));

alter table public.dolls
  add column if not exists gender text not null default 'male';
alter table public.dolls drop constraint if exists dolls_gender_check;
alter table public.dolls add constraint dolls_gender_check
  check (gender in ('male', 'female'));

-- ── 2) 얼굴검사 체크 어휘 ─────────────────────────────────────────────────────
alter table public.generation_face_check_intents
  drop constraint if exists generation_face_check_intents_check_key_check;
alter table public.generation_face_check_intents
  add constraint generation_face_check_intents_check_key_check
  check (check_key in ('face', 'count', 'covered', 'glasses', 'gender'));

alter table public.generation_face_check_cost_attempts
  drop constraint if exists generation_face_check_cost_attempts_check_key_check;
alter table public.generation_face_check_cost_attempts
  add constraint generation_face_check_cost_attempts_check_key_check
  check (check_key in ('face', 'count', 'covered', 'glasses', 'gender'));

-- ── 3) 어드민 mutation 어휘 ───────────────────────────────────────────────────
alter table public.admin_mutation_requests
  drop constraint if exists admin_mutation_requests_operation_check;
alter table public.admin_mutation_requests
  add constraint admin_mutation_requests_operation_check
  check (operation in (
    'config_update', 'event_save', 'event_publish', 'event_unpublish', 'event_delete',
    'moderation_takedown', 'moderation_dismiss', 'moderation_restore', 'moderation_permanent_delete',
    'integrity_clear', 'integrity_void', 'integrity_ban', 'integrity_unban',
    'account_reactivate', 'order_settle', 'doll_gender_update'
  ));

-- ── 4) prepare_generation_face_checks — 4|5 intent, gender 프롬프트 핀, 준비=전부 succeeded ──
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
  v_total integer;
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
     or pg_catalog.jsonb_array_length(p_intents) not in (4, 5)
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
  -- 4체크(구 코드) 또는 5체크(신 코드) — 필수 4종은 항상 있어야 하고 5번째는 gender 만.
  if v_count not in (4, 5) or v_distinct <> v_count or v_invalid <> 0
     or (
       select pg_catalog.count(*)
         from pg_catalog.jsonb_array_elements(p_intents) e
        where (e->>'check_key') in ('face', 'count', 'covered', 'glasses')
     ) <> 4 then
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

  -- 준비 완료 = 이 예약의 intent 전부 succeeded(4체크 예약은 4, 5체크 예약은 5).
  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (where i.state = 'succeeded')::integer,
    pg_catalog.jsonb_object_agg(i.check_key, i.raw_output)
      filter (where i.state = 'succeeded')
    into v_total, v_ready, v_raw
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id;
  if v_total >= 4 and v_ready = v_total then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'ready', 'raw_outputs', v_raw
    );
  end if;
  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'prepared'
  );
end;
$function$;

-- ── 5) claim_generation_face_check — allowlist ──────────────────────────────
CREATE OR REPLACE FUNCTION public.claim_generation_face_check(p_user_id uuid, p_request_id uuid, p_worker_id uuid, p_check_key text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_intent public.generation_face_check_intents%rowtype;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_check_key not in ('face', 'count', 'covered', 'glasses', 'gender') then
    raise exception 'invalid_generation_face_check'
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
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.generation_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'lease_lost'
    );
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
  );
  perform public.bp_user_mutation_lock(p_user_id);
  select *
    into v_reservation
    from public.generation_preflight_reservations r
   where r.id = p_request_id
   for update;
  if not found
     or v_reservation.owner_id <> p_user_id
     or v_reservation.state <> 'claimed'
     or v_reservation.analysis_lease_token <> p_worker_id then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'lease_lost'
    );
  end if;
  select *
    into v_intent
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id
     and i.check_key = p_check_key
   for update;
  if not found then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'outcome', 'not_prepared'
    );
  end if;
  if v_intent.state <> 'planned' then
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', v_intent.state
    );
  end if;

  insert into public.generation_face_check_cost_attempts(
    reservation_id, check_key, payload_hash, created_at
  )
  values (
    p_request_id, p_check_key, v_intent.payload_hash, v_now
  );
  update public.generation_face_check_intents
     set state = 'submitting',
         claimed_at = v_now,
         updated_at = v_now
   where reservation_id = p_request_id
     and check_key = p_check_key;
  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'claimed',
    'check_key', p_check_key,
    'input', v_intent.input_payload,
    'payload_hash', v_intent.payload_hash,
    'callback_token_hash', v_intent.callback_token_hash
  );
end;
$function$;

-- ── 6) finalize_generation_face_checks — checks 4|5(=예약 intent 총수), 5번째 gender 핀 ──
CREATE OR REPLACE FUNCTION public.finalize_generation_face_checks(p_request_id uuid, p_analysis jsonb, p_failure_reason text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_total integer;
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

  select
    pg_catalog.count(*)::integer,
    pg_catalog.count(*) filter (where i.state = 'succeeded')::integer
    into v_total, v_ready
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id;
  if p_failure_reason is not null then
    if p_failure_reason !~ '^[a-z0-9_]{1,100}$'
       or v_total < 4 or v_ready <> v_total then
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
     or v_total < 4
     or v_ready <> v_total
     or p_analysis->>'model' <> 'fal-ai/moondream3-preview/query'
     or p_analysis->>'status' <> 'ok'
     or pg_catalog.jsonb_typeof(p_analysis->'checks') <> 'array'
     or pg_catalog.jsonb_array_length(p_analysis->'checks') <> v_total
     or (
       v_total = 5
       and (p_analysis->>'gender') not in ('male', 'female', 'unknown')
     ) then
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
  ) <> v_total then
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

-- ── 7) record_generation_face_check_webhook — 준비=전부 succeeded ─────────────
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
  v_total integer;
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
    pg_catalog.count(*) filter (where i.state = 'succeeded')::integer,
    pg_catalog.jsonb_object_agg(i.check_key, i.raw_output)
      filter (where i.state = 'succeeded')
    into v_total, v_ready, v_raw
    from public.generation_face_check_intents i
   where i.reservation_id = p_request_id;
  if v_total >= 4 and v_ready = v_total then
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

-- ── 8) commit_generation_preflight — analysis_result.gender → ai_generations.gender ──
CREATE OR REPLACE FUNCTION public.commit_generation_preflight(p_user_id uuid, p_request_id uuid, p_role text, p_image_digest text, p_worker_id uuid, p_generation_plan jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_reservation public.generation_preflight_reservations%rowtype;
  v_generation_id uuid;
  v_deleted_at timestamptz;
  v_generation_status text;
  v_credit_lot_id uuid;
  v_consumed_at timestamptz;
  v_remaining integer;
  v_gender text;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_worker_id is null
     or p_generation_plan is null
     or pg_catalog.jsonb_typeof(p_generation_plan) <> 'object'
     or pg_catalog.octet_length(p_generation_plan::text) > 65536 then
    raise exception 'invalid_generation_preflight_commit'
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
     or v_reservation.role <> p_role
     or v_reservation.image_digest <> p_image_digest then
    raise exception 'preflight_idempotency_conflict'
      using errcode = 'P0001';
  end if;
  if v_reservation.generation_id is null then
    raise exception 'preflight_generation_receipt_missing'
      using errcode = 'P0001';
  end if;
  perform public.bp_mutation_object_lock(
    'generation', v_reservation.generation_id::text
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
  select g.status, g.credit_lot_id, g.consumed_at
    into v_generation_status, v_credit_lot_id, v_consumed_at
    from public.ai_generations g
   where g.id = v_reservation.generation_id
     and g.owner_id = p_user_id
   for update;
  if not found
     or (
       v_reservation.state <> 'committed'
       and (
         v_generation_status <> 'queued'
         or (
           v_reservation.requires_credit
           and (v_credit_lot_id is null or v_consumed_at is null)
         )
         or (
           not v_reservation.requires_credit
           and (v_credit_lot_id is not null or v_consumed_at is not null)
         )
       )
     ) then
    raise exception 'preflight_generation_receipt_invalid'
      using errcode = 'P0001';
  end if;
  if v_reservation.state = 'committed' then
    if v_reservation.generation_plan <> p_generation_plan then
      raise exception 'generation_plan_snapshot_conflict'
        using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true,
      'outcome', 'committed',
      'generation_id', v_reservation.generation_id,
      'remaining', null,
      'analysis', v_reservation.analysis_result,
      'generation_config', v_reservation.generation_config,
      'config_source', v_reservation.config_source,
      'config_version', v_reservation.config_version,
      'config_invalid', v_reservation.config_invalid,
      'generation_plan', v_reservation.generation_plan
    );
  end if;
  if v_reservation.state <> 'accepted' then
    raise exception 'preflight_not_accepted' using errcode = 'P0001';
  end if;
  if v_reservation.expires_at <= v_now then
    raise exception 'preflight_expired' using errcode = 'P0001';
  end if;

  v_generation_id := v_reservation.generation_id;
  select m.gen_credits
    into v_remaining
    from public.member_accounts m
   where m.user_id = p_user_id;

  -- 성별(v1.26): 얼굴검사 판정이 female 일 때만 female, 그 외(male·unknown·레거시 4체크 = 필드 없음)는 male.
  -- 앱(asGender)과 같은 수렴 규칙 — plan 스냅샷의 gender 와 일치한다.
  v_gender := case
    when v_reservation.analysis_result->>'gender' = 'female' then 'female'
    else 'male'
  end;

  update public.generation_preflight_reservations
     set state = 'committed',
         generation_id = v_generation_id,
         generation_plan = p_generation_plan,
         continuation_state = 'running',
         continuation_lease_token = p_worker_id,
         continuation_leased_until = v_now + interval '2 minutes',
         finalized_at = v_now,
         updated_at = v_now
   where id = p_request_id;
  update public.ai_generations
     set cost_preflight_pending = false,
         gender = v_gender
   where id = v_generation_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'outcome', 'committed',
    'generation_id', v_generation_id,
      'remaining', v_remaining,
    'analysis', v_reservation.analysis_result,
    'generation_config', v_reservation.generation_config,
    'config_source', v_reservation.config_source,
    'config_version', v_reservation.config_version,
    'config_invalid', v_reservation.config_invalid,
    'generation_plan', p_generation_plan
  );
end;
$function$;

-- ── 9) commit_generation_pick — dolls.gender 복사 + 정합 검사 ─────────────────
CREATE OR REPLACE FUNCTION public.commit_generation_pick(p_user_id uuid, p_generation_id uuid, p_candidate_index integer, p_attempt_id uuid, p_worker_id uuid, p_path text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_generation public.ai_generations%rowtype;
  v_intent public.generation_pick_intents%rowtype;
  v_upload public.storage_upload_intents%rowtype;
  v_doll public.dolls%rowtype;
  v_deleted_at timestamptz;
  v_style jsonb;
  v_now timestamptz := pg_catalog.clock_timestamp();
begin
  if p_worker_id is null then
    raise exception 'pick_commit_forbidden' using errcode = '22023';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'generation-pick:' || p_generation_id::text,
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
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;
  select *
    into v_generation
    from public.ai_generations g
   where g.id = p_generation_id
   for update;
  select *
    into v_intent
    from public.generation_pick_intents i
   where i.generation_id = p_generation_id
   for update;
  if not found
     or v_intent.owner_id <> p_user_id
     or v_intent.candidate_index <> p_candidate_index
     or v_intent.attempt_id <> p_attempt_id
     or v_intent.state not in ('provider_done', 'committed')
     or (
       v_intent.state = 'provider_done'
       and v_intent.materialization_lease_token <> p_worker_id
     )
     or p_path <> (
       p_user_id::text || '/' || p_attempt_id::text || '.png'
     ) then
    raise exception 'pick_commit_forbidden' using errcode = 'P0001';
  end if;
  if v_generation.owner_id <> p_user_id then
    raise exception 'pick_commit_forbidden' using errcode = 'P0001';
  end if;
  if v_generation.status = 'picked'
     and v_generation.picked_doll_id = p_attempt_id
     and v_intent.state = 'committed' then
    select *
      into v_doll
      from public.dolls d
     where d.id = p_attempt_id;
    if not found then
      raise exception 'pick_commit_doll_missing' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object(
      'ok', true, 'outcome', 'already_committed',
      'doll', pg_catalog.to_jsonb(v_doll)
    );
  end if;
  if v_generation.status <> 'done' then
    raise exception 'pick_commit_state_conflict' using errcode = 'P0001';
  end if;

  select *
    into v_upload
    from public.storage_upload_intents u
   where u.bucket = 'dolls'
     and u.path = p_path
   for update;
  if not found
     or v_upload.owner_user_id <> p_user_id
     or v_upload.subject_id <> p_attempt_id
     or v_upload.purpose <> 'doll_upload'
     or v_upload.status <> 'confirmed' then
    raise exception 'pick_commit_upload_unconfirmed'
      using errcode = 'P0001';
  end if;

  v_style := pg_catalog.jsonb_build_object(
    'schemaVersion', 1,
    'sourceGenerationId', p_generation_id,
    'candidateIndex', p_candidate_index
  );
  insert into public.dolls(
    id, owner_id, image_url, style_meta, role, gender
  )
  values (
    p_attempt_id,
    p_user_id,
    p_path,
    v_style,
    v_generation.role,
    v_generation.gender
  )
  on conflict (id) do nothing;
  select *
    into v_doll
    from public.dolls d
   where d.id = p_attempt_id
   for update;
  if not found
     or v_doll.owner_id <> p_user_id
     or v_doll.image_url <> p_path
     or v_doll.role <> v_generation.role
     or v_doll.gender <> v_generation.gender
     or v_doll.style_meta <> v_style then
    raise exception 'pick_commit_doll_conflict' using errcode = 'P0001';
  end if;

  update public.ai_generations
     set status = 'picked',
         picked_doll_id = p_attempt_id,
         picked_index = p_candidate_index
   where id = p_generation_id;
  update public.generation_pick_intents
     set state = 'committed',
         materialization_lease_token = null,
         materialization_leased_until = null,
         committed_at = v_now,
         updated_at = v_now
   where generation_id = p_generation_id;

  return pg_catalog.jsonb_build_object(
    'ok', true, 'outcome', 'committed',
    'doll', pg_catalog.to_jsonb(v_doll)
  );
end;
$function$;

-- ── 10) admin_update_doll_gender_idempotent — 0085 receipt + dolls.version CAS ──
CREATE OR REPLACE FUNCTION public.admin_update_doll_gender_idempotent(p_admin_id uuid, p_doll_id uuid, p_gender text, p_expected_version integer, p_request_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_payload jsonb;
  v_replay jsonb;
  v_result jsonb;
  v_doll public.dolls%rowtype;
  v_next_version integer;
begin
  perform public.bp_assert_active_admin(p_admin_id);
  if p_doll_id is null then
    raise exception 'target_invalid' using errcode = 'P0001';
  end if;
  if p_gender not in ('male', 'female') then
    raise exception 'gender_invalid' using errcode = 'P0001';
  end if;
  if p_expected_version is null or p_expected_version < 0 then
    raise exception 'version_invalid' using errcode = 'P0001';
  end if;

  v_payload := pg_catalog.jsonb_build_object(
    'doll_id', p_doll_id,
    'gender', p_gender,
    'expected_version', p_expected_version
  );
  v_replay := public.bp_admin_mutation_replay(
    p_admin_id,
    p_request_id,
    'doll_gender_update',
    p_doll_id::text,
    v_payload
  );
  if v_replay is not null then
    return v_replay;
  end if;

  select *
    into v_doll
    from public.dolls d
   where d.id = p_doll_id
   for update;
  if not found then
    raise exception 'doll_not_found' using errcode = 'P0001';
  end if;
  if v_doll.artifacts_purged_at is not null then
    raise exception 'already_purged' using errcode = 'P0001';
  end if;
  -- dolls.version 은 모든 update 에서 트리거(set_updated_at_and_version)가 +1 — 후처리 CAS 기준.
  if v_doll.version <> p_expected_version then
    raise exception 'state_conflict' using errcode = 'P0001';
  end if;

  if v_doll.gender = p_gender then
    v_result := pg_catalog.jsonb_build_object(
      'ok', true,
      'previousGender', v_doll.gender,
      'nextGender', p_gender,
      'version', v_doll.version,
      'noOp', true,
      'idempotent', false
    );
  else
    update public.dolls
       set gender = p_gender
     where id = p_doll_id;
    select d.version
      into v_next_version
      from public.dolls d
     where d.id = p_doll_id;
    v_result := pg_catalog.jsonb_build_object(
      'ok', true,
      'previousGender', v_doll.gender,
      'nextGender', p_gender,
      'version', v_next_version,
      'noOp', false,
      'idempotent', false
    );
  end if;

  perform public.bp_admin_mutation_store_completed(
    p_request_id,
    p_admin_id,
    'doll_gender_update',
    p_doll_id::text,
    v_payload,
    v_result
  );
  return v_result;
end;
$function$;

revoke all on function public.admin_update_doll_gender_idempotent(uuid, uuid, text, integer, uuid)
  from public, anon, authenticated;
grant execute on function public.admin_update_doll_gender_idempotent(uuid, uuid, text, integer, uuid)
  to service_role;

notify pgrst, 'reload schema';
