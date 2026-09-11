-- 0126: 점수 저장 상한 상향 — 초당 2000→4000, 하드캡 500만→800만 (2026-09-11, v1.36)
-- 맵변경 배율(2곳 ×1.5·3곳 ×2.0)이 무기변경 배율(×2)과 곱으로 붙어 저글링 합산 최대가 ×2→×4 가 됐다.
-- 앱(lib/score-limits.ts MAX_AVG_SCORE_PER_SEC·MAX_SCORE_HARD)과 DB 제출 함수의 리터럴을 같은 값으로 맞춘다.
-- 30분 × 4000 = 720만 ≤ 800만이라 시간 캡보다 점수 캡이 먼저 물리지 않는다(DB 테이블 check 1,000만 유지).
-- 본문은 프로드 pg_get_functiondef 실물(0125 적용 후, 2026-09-11)에 위 리터럴만 앵커 치환.
-- 무중단 순서: 이 마이그레이션을 프로드에 먼저 적용(Phase A) → 앱 배포. 구 앱은 2000/초·500만으로 자체 클램프하므로 선적용이 안전하다.

CREATE OR REPLACE FUNCTION public.bp_submit_score_with_review_core(p_owner_id uuid, p_doll_id uuid, p_score integer, p_weapon text, p_duration_ms integer, p_max_combo integer, p_end_reason text, p_telemetry_session_id uuid, p_review_status text, p_signals jsonb, p_evidence jsonb, p_abuse_score integer, p_rules_version text)
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
