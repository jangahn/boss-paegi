-- 0127_base_dolls.sql — 기본 캐릭터 5종(v1.42): 점수에 기본 캐릭터 키 기록.
--
-- 기본 부장님(boss-m) + 회원 추가 4종(ceo-m·boss-f·teamlead-f·junior-m)은 DB 행이 없는 정적 스프라이트다(lib/base-dolls.ts).
-- doll_id 가 null 인 플레이가 어떤 기본 캐릭터였는지 공유 카드·히스토리·OG 가 알 수 있도록 scores.base_doll 을 추가하고,
-- 제출 RPC(submit_score_with_review → bp_submit_score_with_review_core)에 p_base_doll(기본 null)을 끝에 더한다.
-- null = 구 기록 = 기본 부장님(읽기 쪽 폴백). doll_id 가 있으면 base_doll 은 항상 null(코어에서 강제).
--
-- 시그니처가 바뀌므로 새 오버로드를 만든 뒤 종전 시그니처를 drop 한다(PostgREST named-arg 모호성 방지 — 구 클라가
-- p_base_doll 없이 호출해도 DEFAULT NULL 로 새 함수에 매핑). 권한은 008900 과 동일: core 는 전부 revoke(외부 호출 없음),
-- outer 는 service_role 만 execute. 본문은 프로드 pg_get_functiondef 실측(0126 이후) + 위 변경만.

alter table public.scores add column if not exists base_doll text;
alter table public.scores drop constraint if exists scores_base_doll_check;
alter table public.scores add constraint scores_base_doll_check
  check (base_doll is null or base_doll in ('boss-m', 'ceo-m', 'boss-f', 'teamlead-f', 'junior-m'));
comment on column public.scores.base_doll is
  '기본 캐릭터 키(v1.42, lib/base-dolls.ts 어휘). doll_id null 플레이 전용. null = 구 기록(기본 부장님).';

-- ── core: p_base_doll 추가 ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.bp_submit_score_with_review_core(p_owner_id uuid, p_doll_id uuid, p_score integer, p_weapon text, p_duration_ms integer, p_max_combo integer, p_end_reason text, p_telemetry_session_id uuid, p_review_status text, p_signals jsonb, p_evidence jsonb, p_abuse_score integer, p_rules_version text, p_base_doll text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_profile_deleted_at timestamptz;
  v_member public.member_accounts%rowtype;
  v_is_member boolean := false;
  v_banned boolean := false;
  v_doll_owner uuid;
  v_doll_deleted_at timestamptz;
  v_tel_owner uuid;
  v_tel_is_anon boolean;
  v_tel_binding text;
  v_expected_binding text;
  v_submission_text text;
  v_submission_id uuid;
  v_submission_fingerprint text;
  v_legacy_rollout boolean := false;
  v_migrated_source_text text;
  v_migrated_source uuid;
  v_submission_origin_owner uuid;
  v_id uuid;
  v_existing public.scores%rowtype;
  v_review_status text := p_review_status;
  v_signals jsonb := coalesce(p_signals, '[]'::jsonb);
  v_evidence jsonb := coalesce(p_evidence, '{}'::jsonb);
  v_abuse_score int := coalesce(p_abuse_score, 0);
  v_has_banned_signal boolean := false;
  v_flagged boolean;
  v_end_reason text :=
    case when p_end_reason in ('time_limit', 'score_limit')
      then p_end_reason else 'normal' end;
  v_max_combo int := greatest(coalesce(p_max_combo, 0), 0);
begin
  if p_owner_id is null then
    raise exception 'invalid_owner' using errcode = 'P0001';
  end if;

  -- Lock order is shared with account deletion: profile first. delete-first
  -- waits then fails closed; submit-first completes before deletion snapshots.
  select p.deleted_at
    into v_profile_deleted_at
    from public.profiles p
   where p.id = p_owner_id
   for key share;
  if not found then
    raise exception 'account_not_found' using errcode = 'P0001';
  end if;
  if v_profile_deleted_at is not null then
    raise exception 'account_deleted' using errcode = 'P0001';
  end if;

  -- Same advisory key/order as admin_ban_member. No registered score can commit
  -- from a stale pre-ban route read.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext('member:' || p_owner_id::text)::bigint
  );
  if exists (
    select 1
      from public.anon_data_reassignments r
     where r.source_user_id = p_owner_id
  ) then
    raise exception 'account_migrated' using errcode = 'P0001';
  end if;
  select *
    into v_member
    from public.member_accounts m
   where m.user_id = p_owner_id
   for key share;
  v_is_member := found;
  v_banned := v_is_member and v_member.abuse_status = 'banned';

  if p_score is null
     or p_score < 0
     or p_score > least(
       -- v1.36(0126): 저글링 합산 최대 ×4 → 초당 상한 2000→4000, 하드캡 500만→800만 (lib/score-limits.ts 와 동일)
       pg_catalog.ceil(p_duration_ms / 1000.0 * 4000)::int,
       8000000
     )
     or p_duration_ms is null
     or p_duration_ms <= 0
     or p_duration_ms > 1800000
     or v_max_combo >= 100000
     or p_weapon is null
     or p_weapon not in (
       -- v1.35(0125): 맵별 투척 무기 12종 — lib/weapon-keys.ts WEAPON_KEY_VALUES 와 동일 집합
       'fist', 'hammer', 'slap', 'book', 'keyboard',
       'paper', 'gun', 'grab', 'pinch', 'pen',
       'mug', 'ramen', 'printer', 'note', 'laptop',
       'phone', 'umbrella', 'beer', 'chicken'
     )
  then
    raise exception 'invalid_score_protocol' using errcode = 'P0001';
  end if;

  if pg_catalog.jsonb_typeof(v_signals) <> 'array'
     or pg_catalog.jsonb_array_length(v_signals) > 32
     or pg_catalog.jsonb_typeof(v_evidence) <> 'object'
     or pg_catalog.pg_column_size(v_evidence) > 32768
     or v_abuse_score < 0
     or v_abuse_score > 1000
     or p_rules_version is null
     or pg_catalog.length(p_rules_version) > 100
  then
    raise exception 'invalid_review_payload' using errcode = 'P0001';
  end if;

  if p_review_status not in ('registered', 'pending', 'voided') then
    raise exception 'invalid_review_status' using errcode = 'P0001';
  end if;

  -- New clients embed the per-game key in the already-versioned evidence
  -- payload, preserving the RPC signature. During the bounded DB-first rolling
  -- window only, synthesize a deterministic identity for the exact old-server
  -- shape (both fields absent). One-field/malformed shapes still fail closed.
  v_submission_text := v_evidence->>'submissionId';
  v_submission_fingerprint := v_evidence->>'submissionFingerprint';
  if v_submission_text is null
     and v_submission_fingerprint is null
     and public.bp_rollout_compatibility_enabled(
       'legacy_score_submission'
     )
  then
    v_legacy_rollout := true;
    -- With no stable client nonce, a response-loss retry and a second
    -- identical game are information-theoretically indistinguishable. Refuse
    -- that unsafe old shape rather than minting a duplicate-prone random UUID.
    if p_telemetry_session_id is null then
      raise exception 'client_upgrade_required' using errcode = 'P0001';
    end if;
    v_submission_id := pg_catalog.md5(
      'legacy-score:' || p_owner_id::text || ':' ||
      p_telemetry_session_id::text
    )::uuid;
    v_submission_fingerprint := pg_catalog.encode(
      extensions.digest(
        pg_catalog.convert_to(
          pg_catalog.jsonb_build_object(
            'ownerId', p_owner_id,
            'dollId', p_doll_id,
            'score', p_score,
            'weapon', p_weapon,
            'durationMs', p_duration_ms,
            'maxCombo', v_max_combo,
            'endReason', v_end_reason,
            'telemetrySessionId', p_telemetry_session_id
          )::text,
          'UTF8'
        ),
        'sha256'
      ),
      'hex'
    );
    v_evidence := v_evidence || pg_catalog.jsonb_build_object(
      'legacyRollingSubmission', true
    );
  else
    if v_submission_text is null
       or v_submission_text !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
    then
      raise exception 'invalid_submission_id' using errcode = 'P0001';
    end if;
    v_submission_id := v_submission_text::uuid;
    if v_submission_fingerprint is null
       or v_submission_fingerprint !~ '^[0-9a-f]{64}$'
    then
      raise exception 'invalid_submission_fingerprint' using errcode = 'P0001';
    end if;
  end if;
  v_migrated_source_text :=
    case
      when v_evidence->>'migratedSourceOwnerId' = '' then null
      else v_evidence->>'migratedSourceOwnerId'
    end;
  if v_migrated_source_text is not null then
    if v_migrated_source_text !~
         '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    then
      raise exception 'invalid_migrated_replay_source'
        using errcode = 'P0001';
    end if;
    v_migrated_source := v_migrated_source_text::uuid;
    if v_migrated_source = p_owner_id
       or not exists (
         select 1
           from public.anon_data_reassignments r
          where r.source_user_id = v_migrated_source
            and r.target_user_id = p_owner_id
            and r.result->>'ok' = 'true'
       )
    then
      raise exception 'migrated_replay_not_authorized'
        using errcode = 'P0001';
    end if;
    v_submission_origin_owner := v_migrated_source;
    select *
      into v_existing
      from public.scores s
     where s.owner_id = p_owner_id
       and s.submission_origin_owner_id = v_submission_origin_owner
       and s.submission_id = v_submission_id
       and s.submission_fingerprint = v_submission_fingerprint
     for update;
    if not found then
      raise exception 'migrated_score_replay_mismatch'
        using errcode = 'P0001';
    end if;
  else
    v_submission_origin_owner := p_owner_id;
  end if;

  if p_doll_id is not null then
    select d.owner_id, d.deleted_at
      into v_doll_owner, v_doll_deleted_at
      from public.dolls d
     where d.id = p_doll_id
     for key share;
    if not found
       or v_doll_owner is distinct from p_owner_id
       or v_doll_deleted_at is not null
    then
      raise exception 'doll_ownership_mismatch' using errcode = 'P0001';
    end if;
  end if;

  if p_telemetry_session_id is not null then
    select t.owner_id, t.is_anon, t.submitter_binding
      into v_tel_owner, v_tel_is_anon, v_tel_binding
      from public.telemetry_sessions t
     where t.id = p_telemetry_session_id
     for key share;
    if not found then
      raise exception 'telemetry_session_owner_mismatch' using errcode = 'P0001';
    end if;

    v_expected_binding :=
      public.bp_telemetry_submitter_binding(
        p_telemetry_session_id,
        p_owner_id
      );
    -- The old telemetry route intentionally stored anonymous owner_id=NULL and
    -- had no submitter binding input. The same authenticated old score request
    -- may claim that exact unbound row once during the rolling window.
    if v_legacy_rollout
       and not v_is_member
       and v_tel_is_anon is true
       and v_tel_owner is null
       and v_tel_binding is null
    then
      update public.telemetry_sessions
         set submitter_binding = v_expected_binding
       where id = p_telemetry_session_id
         and owner_id is null
         and is_anon = true
         and submitter_binding is null
      returning submitter_binding into v_tel_binding;
    end if;
    if v_tel_binding is distinct from v_expected_binding
       or (
         v_is_member
         and (v_tel_is_anon is distinct from false
              or v_tel_owner is distinct from p_owner_id)
       )
       or (
         not v_is_member
         and (v_tel_is_anon is distinct from true
              or v_tel_owner is not null)
       )
    then
      raise exception 'telemetry_session_owner_mismatch' using errcode = 'P0001';
    end if;
  end if;

  -- DB-observed ban is authoritative. Append the signal/evidence even if a
  -- stale route computed registered before it waited on the member lock.
  if v_banned then
    select exists(
      select 1
        from pg_catalog.jsonb_array_elements(v_signals) e
       where e->>'id' = 'BANNED_MEMBER'
    ) into v_has_banned_signal;
    if not v_has_banned_signal then
      v_signals := v_signals || pg_catalog.jsonb_build_array(
        pg_catalog.jsonb_build_object(
          'id', 'BANNED_MEMBER',
          'value', null,
          'threshold', null,
          'source', 'submit'
        )
      );
      v_abuse_score := least(v_abuse_score + 3, 1000);
    end if;
    v_evidence := v_evidence ||
      pg_catalog.jsonb_build_object('dbBannedAtSubmit', true);
    v_review_status := 'voided';
  end if;

  v_flagged := v_review_status in ('pending', 'voided');
  if (v_review_status = 'registered'
      and (pg_catalog.jsonb_array_length(v_signals) <> 0 or v_abuse_score <> 0))
     or (v_flagged
         and (pg_catalog.jsonb_array_length(v_signals) = 0
              or v_abuse_score <= 0))
  then
    raise exception 'review_payload_mismatch' using errcode = 'P0001';
  end if;

  begin
    insert into public.scores (
      owner_id,
      doll_id,
      base_doll,
      score,
      weapon,
      duration_ms,
      max_combo,
      end_reason,
      telemetry_session_id,
      submission_id,
      submission_fingerprint,
      submission_origin_owner_id,
      review_status
    )
    values (
      p_owner_id,
      p_doll_id,
      case when p_doll_id is null then p_base_doll else null end,
      p_score,
      p_weapon,
      p_duration_ms,
      v_max_combo,
      v_end_reason,
      p_telemetry_session_id,
      v_submission_id,
      v_submission_fingerprint,
      v_submission_origin_owner,
      v_review_status
    )
    returning id into v_id;
  exception
    when unique_violation then
      select *
       into v_existing
        from public.scores s
       where s.submission_origin_owner_id =
             v_submission_origin_owner
         and s.submission_id = v_submission_id
       for update;
      if not found then
        if p_telemetry_session_id is null then
          raise;
        end if;
        select *
          into v_existing
          from public.scores s
         where s.telemetry_session_id = p_telemetry_session_id
         for update;
        if not found then
          raise;
        end if;
      end if;
      -- The fingerprint binds the normalized requested doll/telemetry UUIDs.
      -- The accepted links themselves are DB-observation dependent: an ingest
      -- or owner row may become visible between response-loss retries. Keep
      -- the first committed links and converge when the immutable request
      -- fingerprint/core are identical.
      if v_existing.owner_id is distinct from p_owner_id
         or v_existing.submission_origin_owner_id is distinct from
            v_submission_origin_owner
         or v_existing.submission_id is distinct from v_submission_id
         or v_existing.submission_fingerprint is distinct from
            v_submission_fingerprint
         or v_existing.score is distinct from p_score
         or v_existing.weapon is distinct from p_weapon
         or v_existing.duration_ms is distinct from p_duration_ms
         or v_existing.max_combo is distinct from v_max_combo
         or v_existing.end_reason is distinct from v_end_reason
      then
        if v_existing.owner_id = p_owner_id
           and v_existing.submission_id = v_submission_id
        then
          raise exception 'submission_id_conflict' using errcode = 'P0001';
        end if;
        raise exception 'telemetry_session_conflict'
          using errcode = 'P0001';
      end if;
      return pg_catalog.jsonb_build_object(
        'scoreId', v_existing.id,
        'reviewStatus', v_existing.review_status,
        'duplicate', true
      );
  end;

  if v_flagged then
    insert into public.score_flags (
      score_id,
      signals,
      evidence,
      abuse_score,
      rules_version,
      status
    )
    values (
      v_id,
      v_signals,
      v_evidence,
      v_abuse_score,
      p_rules_version,
      v_review_status
    );
  end if;

  return pg_catalog.jsonb_build_object(
    'scoreId', v_id,
    'reviewStatus', v_review_status,
    'duplicate', false
  );
end;
$function$;

drop function if exists public.bp_submit_score_with_review_core(
  uuid, uuid, integer, text, integer, integer, text, uuid, text, jsonb, jsonb, integer, text
);
revoke all on function public.bp_submit_score_with_review_core(
  uuid, uuid, integer, text, integer, integer, text, uuid, text, jsonb, jsonb, integer, text, text
) from public, anon, authenticated, service_role;

-- ── outer(quota 래퍼): p_base_doll 추가 ────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.submit_score_with_review(p_owner_id uuid, p_doll_id uuid, p_score integer, p_weapon text, p_duration_ms integer, p_max_combo integer, p_end_reason text, p_telemetry_session_id uuid, p_review_status text, p_signals jsonb, p_evidence jsonb, p_abuse_score integer, p_rules_version text, p_network_actor_key text, p_base_doll text DEFAULT NULL)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
 SET lock_timeout TO '250ms'
AS $function$
declare
  v_reservation jsonb;
  v_identity jsonb;
  v_operation_key text;
  v_request_fingerprint text;
  v_attempt public.public_write_attempts%rowtype;
  v_result jsonb;
  v_error_code text;
  v_error_message text;
begin
  v_reservation := public.reserve_score_write_attempt(
    p_owner_id,
    p_doll_id,
    p_score,
    p_weapon,
    p_duration_ms,
    p_max_combo,
    p_end_reason,
    p_telemetry_session_id,
    p_evidence,
    p_network_actor_key
  );
  if v_reservation->>'outcome' = 'replay' then
    return v_reservation->'result';
  elsif v_reservation->>'outcome' = 'quota' then
    raise exception '%', v_reservation->>'error_code'
      using errcode = 'P0001';
  elsif v_reservation->>'outcome' = 'busy' then
    raise exception 'score_write_quota_busy' using errcode = 'P0001';
  elsif v_reservation->>'outcome' = 'failed' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', v_reservation->>'error_code'
    );
  elsif v_reservation->>'outcome' <> 'reserved' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', 'internal_error'
    );
  end if;

  v_identity := public.bp_score_write_attempt_identity(
    p_owner_id, p_doll_id, p_score, p_weapon, p_duration_ms,
    p_max_combo, p_end_reason, p_telemetry_session_id, p_evidence
  );
  if v_identity is null then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', 'invalid_submission_id'
    );
  end if;
  v_operation_key := v_identity->>'operationKey';
  v_request_fingerprint := v_identity->>'requestFingerprint';
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'score-write-attempt:' || v_operation_key,
      0::bigint
    )
  );

  select *
    into strict v_attempt
    from public.public_write_attempts a
   where a.endpoint = 'score'
     and a.operation_key = v_operation_key
   for update;
  if v_attempt.request_fingerprint <> v_request_fingerprint then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', 'submission_id_conflict'
    );
  end if;
  if v_attempt.state = 'failed' then
    return pg_catalog.jsonb_build_object(
      'ok', false,
      'writeAttemptError', v_attempt.error_code
    );
  end if;

  begin
    v_result := public.bp_submit_score_with_review_core(
      p_owner_id,
      p_doll_id,
      p_score,
      p_weapon,
      p_duration_ms,
      p_max_combo,
      p_end_reason,
      p_telemetry_session_id,
      p_review_status,
      p_signals,
      p_evidence,
      p_abuse_score,
      p_rules_version,
      p_base_doll
    );
  exception
    -- Lock pressure is retryable. Keep the already quota-counted reservation
    -- open so the exact same operation can try the core again later.
    when lock_not_available
      or query_canceled
      or serialization_failure
      or deadlock_detected then
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'writeAttemptError', 'score_write_quota_busy'
      );
    when others then
      get stacked diagnostics v_error_message = message_text;
      v_error_code := case
        when v_error_message in (
          'telemetry_session_conflict',
          'submission_id_conflict',
          'telemetry_session_owner_mismatch',
          'doll_ownership_mismatch',
          'migrated_replay_not_authorized',
          'migrated_score_replay_mismatch',
          'account_deleted',
          'account_migrated',
          'account_not_found',
          'client_upgrade_required',
          'invalid_migrated_replay_source',
          'invalid_owner',
          'invalid_review_status',
          'invalid_score_protocol',
          'invalid_submission_id',
          'invalid_submission_fingerprint',
          'invalid_review_payload',
          'review_payload_mismatch'
        ) then v_error_message
        else 'internal_error'
      end;
      update public.public_write_attempts a
         set state = 'failed',
             error_code = v_error_code,
             updated_at = pg_catalog.clock_timestamp()
       where a.endpoint = 'score'
         and a.operation_key = v_operation_key;
      return pg_catalog.jsonb_build_object(
        'ok', false,
        'writeAttemptError', v_error_code
      );
  end;

  update public.public_write_attempts a
     set state = 'succeeded',
         error_code = null,
         updated_at = pg_catalog.clock_timestamp()
   where a.endpoint = 'score'
     and a.operation_key = v_operation_key;
  return v_result;
exception
  when lock_not_available
    or query_canceled
    or serialization_failure
    or deadlock_detected then
    raise exception 'score_write_quota_busy' using errcode = 'P0001';
end;
$function$;

drop function if exists public.submit_score_with_review(
  uuid, uuid, integer, text, integer, integer, text, uuid, text, jsonb, jsonb, integer, text, text
);
revoke all on function public.submit_score_with_review(
  uuid, uuid, integer, text, integer, integer, text, uuid, text, jsonb, jsonb, integer, text, text, text
) from public, anon, authenticated;
grant execute on function public.submit_score_with_review(
  uuid, uuid, integer, text, integer, integer, text, uuid, text, jsonb, jsonb, integer, text, text, text
) to service_role;
