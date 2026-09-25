-- 0133: 점수 저장 봉투 초당 4,000 → 5,500 (v1.59, 어뷰징 규칙 v13 — S3 3,400 → 4,500 과 함께).
--
-- 배경(2026-09-25): 제한 시간(v1.53, 최대 120초) 판에서 멀티터치 · 맵 6곳 · 무기 9종으로 455,526점/121.5초 = 초당 3,748
-- (사람 실측 최대 2,947 → 3,748)이 나와 S3(3,400) · S11(425,000)에 걸렸다(사용자 확인: 정상 플레이). 봉투 계층 불변식
-- 저장 상한 ≥ S3 ≥ 사람 실측 을 유지하려면 저장 상한도 올려야 한다 — 그대로 두면 초당 4,000 을 넘는 정상 판은 점수가 깎인다.
-- 사용자 결정: S3 4,500(실측 3,748 의 약 1.2배, 궁극기를 더 쓴 상위 판 추정 약 4,400 을 덮음) · 저장 상한 5,500.
--
-- 두 함수는 프로드 pg_get_functiondef 실측 본문(2026-09-25, 레포 최신 정의 0127 · 0131 과 동일 — 차이는 DEFAULT NULL 표기뿐)에서
-- 봉투 리터럴만 바꿨다: 제출 코어의 ceil(p_duration_ms / 1000.0 * 4000) · 적재 코어의 c_max_avg_per_sec 4000.
-- 적재 코어의 의심(suspicious) 판정은 이 리터럴을 쓰므로 함께 5,500. c_max_duration(1,804,000) · 하드캡(800만)은 그대로.
-- 롤아웃: Phase A(프로드 선적용) → 배포. 새 함수는 구 번들(클라 클램프 4,000)과도 호환 — 클라가 더 낮게 자를 뿐.

CREATE OR REPLACE FUNCTION public.bp_submit_score_with_review_core(p_owner_id uuid, p_doll_id uuid, p_score integer, p_weapon text, p_duration_ms integer, p_max_combo integer, p_end_reason text, p_telemetry_session_id uuid, p_review_status text, p_signals jsonb, p_evidence jsonb, p_abuse_score integer, p_rules_version text, p_base_doll text DEFAULT NULL::text)
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
       -- v1.59(0133): 제한 시간 판 실측(초당 3,748) → 초당 상한 4000→5500 (S3 4500 위, lib/score-limits.ts 와 동일)
       pg_catalog.ceil(p_duration_ms / 1000.0 * 5500)::int,
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

CREATE OR REPLACE FUNCTION public.bp_ingest_telemetry_delta_core(p_session_id uuid, p_owner_id uuid, p_is_member boolean, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  c_daily_cap int := 5000;
  c_max_timeline int := 2000;
  c_max_write int := 400;
  c_max_duration int := 1804000;
  c_max_score bigint := 8000000;
  c_max_avg_per_sec int := 5500;
  c_weapon_count int := 19;
  c_map_count int := 6;

  v_budget public.telemetry_budget;
  v_today date := (pg_catalog.now() at time zone 'Asia/Seoul')::date;
  v_mode text;
  v_sess public.telemetry_sessions;
  v_exists boolean;
  v_actual_member boolean := false;
  v_is_anon boolean;
  v_owner uuid;
  v_binding text;
  v_profile_deleted_at timestamptz;
  v_device text;
  v_summary jsonb := coalesce(p_payload->'summary', '{}'::jsonb);
  v_events jsonb := coalesce(p_payload->'events', '[]'::jsonb);
  v_seq_high int :=
    coalesce(nullif(v_summary->>'seqHigh', '')::int, 0);
  v_end_reason text := nullif(v_summary->>'endReason', '');
  v_allow_timeline boolean;
  v_filtered jsonb;
  v_max_new_seq int;
  v_cnt_new int;
  v_min_new_seq int;
  v_new_timeline jsonb;
  v_timeline_dropped boolean;
  v_has_gap boolean;
  v_last_seq int;
  v_dur int;
  v_score bigint;
  v_hit int;
  v_wsum numeric;
  v_suspicious boolean;
begin
  if p_session_id is null then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'mode', 'off', 'reason', 'no_session'
    );
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) <> 'object' then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'mode', 'off', 'reason', 'invalid_payload'
    );
  end if;

  -- Authenticated subjects, including anonymous/pre-consent subjects, lock the
  -- lifecycle row. The raw subject is used only as a hash input below.
  if p_owner_id is not null then
    -- Keep the canonical user advisory ahead of every profile/member/session
    -- read. A delete-first transaction therefore commits before this SELECT
    -- takes its snapshot, so a stale active account can never create or mutate
    -- telemetry after deletion.
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtext('member:' || p_owner_id::text)::bigint
    );
    select p.deleted_at
      into v_profile_deleted_at
      from public.profiles p
     where p.id = p_owner_id
     for key share;
    if not found then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', 'off', 'reason', 'account_not_found'
      );
    end if;
    if v_profile_deleted_at is not null then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', 'off', 'reason', 'account_deleted'
      );
    end if;
    if exists (
      select 1
        from public.anon_data_reassignments r
       where r.source_user_id = p_owner_id
    ) then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', 'off', 'reason', 'account_migrated'
      );
    end if;
    select exists(
      select 1
        from public.member_accounts m
       where m.user_id = p_owner_id
    ) into v_actual_member;
    v_binding :=
      public.bp_telemetry_submitter_binding(p_session_id, p_owner_id);
  end if;

  if coalesce(p_is_member, false) is distinct from v_actual_member then
    return pg_catalog.jsonb_build_object(
      'ok', false, 'mode', 'off', 'reason', 'member_mismatch'
    );
  end if;
  v_is_anon := not v_actual_member;
  v_owner := case when v_actual_member then p_owner_id else null end;

  -- 1) budget lock + day rollover + mode.
  select *
    into v_budget
    from public.telemetry_budget
   where id = true
   for update;
  if not found then
    insert into public.telemetry_budget(id)
    values (true)
    on conflict (id) do nothing;
    select *
      into v_budget
      from public.telemetry_budget
     where id = true
     for update;
  end if;
  if v_budget.day_kst is distinct from v_today then
    update public.telemetry_budget
       set day_kst = v_today,
           new_sessions_today = 0,
           updated_at = pg_catalog.now()
     where id = true;
    v_budget.day_kst := v_today;
    v_budget.new_sessions_today := 0;
  end if;
  v_mode := case
    when v_budget.degrade_mode = 'off' then 'off'
    when v_budget.over_budget then 'summary'
    when v_budget.new_sessions_today >= c_daily_cap then 'summary'
    else 'full'
  end;

  v_device := coalesce(p_payload->>'deviceClass', 'other');
  if v_device not in (
    'mobile-touch', 'mobile-pointer', 'desktop-touch',
    'desktop-pointer', 'other'
  ) then
    v_device := 'other';
  end if;

  -- 2) session lock/create. owner shape and binding are immutable.
  select *
    into v_sess
    from public.telemetry_sessions
   where id = p_session_id
   for update;
  v_exists := found;

  if not v_exists then
    if v_mode = 'off' then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', 'off', 'reason', 'budget'
      );
    end if;
    insert into public.telemetry_sessions(
      id,
      owner_id,
      is_anon,
      submitter_binding,
      device_class,
      started_at
    )
    values (
      p_session_id,
      v_owner,
      v_is_anon,
      v_binding,
      v_device,
      coalesce(
        nullif(p_payload->>'startedAt', '')::timestamptz,
        pg_catalog.now()
      )
    );
    update public.telemetry_budget
       set new_sessions_today = new_sessions_today + 1,
           updated_at = pg_catalog.now()
     where id = true;
    select *
      into v_sess
      from public.telemetry_sessions
     where id = p_session_id
     for update;
  else
    if v_sess.owner_id is distinct from v_owner
       or v_sess.is_anon is distinct from v_is_anon
       or v_sess.submitter_binding is distinct from v_binding
    then
      return pg_catalog.jsonb_build_object(
        'ok', false, 'mode', v_mode, 'reason', 'owner_mismatch'
      );
    end if;
  end if;

  -- off + existing session permits only one final session_end.
  if v_mode = 'off' and v_exists then
    if v_sess.ended_at is not null then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'mode', 'off',
        'reason', 'already_finalized',
        'lastSeq', v_sess.last_seq
      );
    end if;
    if v_end_reason is null then
      return pg_catalog.jsonb_build_object(
        'ok', true,
        'mode', 'off',
        'reason', 'pending',
        'lastSeq', v_sess.last_seq
      );
    end if;
  end if;

  -- 3) Anonymous/pre-consent sessions are summary-only.
  v_allow_timeline :=
    v_mode = 'full'
    and not v_is_anon
    and not v_sess.timeline_dropped
    and v_sess.write_count < c_max_write;

  -- 4) summary clamp + latest-wins.
  if v_seq_high >= v_sess.last_seq then
    v_dur := least(
      greatest(
        coalesce(
          nullif(v_summary->>'durationMs', '')::int,
          0
        ),
        0
      ),
      c_max_duration
    );
    v_score := least(
      greatest(
        coalesce(
          nullif(v_summary#>>'{totals,score}', '')::bigint,
          0
        ),
        0
      ),
      c_max_score
    );
    v_hit := greatest(
      coalesce(
        nullif(v_summary#>>'{totals,hitCount}', '')::int,
        0
      ),
      0
    );
    select coalesce(
             pg_catalog.sum(
               greatest(
                 coalesce(
                   nullif(e.value->>'hits', '')::numeric,
                   0
                 ),
                 0
               )
             ),
             0
           )
      into v_wsum
      from pg_catalog.jsonb_each(
        coalesce(v_summary->'weaponSummary', '{}'::jsonb)
      ) e;
    v_suspicious :=
      v_score > (
        greatest(1, pg_catalog.ceil(v_dur / 1000.0))
        * c_max_avg_per_sec
      )
      or pg_catalog.abs(v_wsum - v_hit) >
         greatest(10, v_hit * 0.2);

    update public.telemetry_sessions
       set ended_at = coalesce(
             nullif(v_summary->>'endedAt', '')::timestamptz,
             ended_at
           ),
           end_reason = case
             when v_end_reason in (
               'normal', 'time_limit', 'score_limit',
               'abandon', 'reload', 'hidden_timeout'
             )
             then v_end_reason
             else end_reason
           end,
           duration_ms = v_dur,
           score = v_score,
           hit_count = v_hit,
           max_combo = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,maxCombo}', ''
                 )::int,
                 0
               ),
               0
             ),
             999999
           ),
           ult_fire_count = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,ultFireCount}', ''
                 )::int,
                 0
               ),
               0
             ),
             100000
           ),
           distinct_weapons = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,distinctWeapons}', ''
                 )::int,
                 0
               ),
               0
             ),
             c_weapon_count
           ),
           distinct_maps = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,distinctMaps}', ''
                 )::int,
                 0
               ),
               0
             ),
             c_map_count
           ),
           apm = least(
             greatest(
               coalesce(
                 nullif(v_summary#>>'{totals,apm}', '')::int,
                 0
               ),
               0
             ),
             100000
           ),
           tap_share = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,tapShare}', ''
                 )::numeric,
                 0
               ),
               0
             ),
             1
           ),
           max_touch = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,maxTouch}', ''
                 )::int,
                 0
               ),
               0
             ),
             20
           ),
           key_actions = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,keyActions}', ''
                 )::int,
                 0
               ),
               0
             ),
             1000000
           ),
           dpr = least(
             greatest(
               coalesce(
                 nullif(v_summary#>>'{totals,dpr}', '')::numeric,
                 0
               ),
               0
             ),
             8
           ),
           refresh_hz = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,refreshHz}', ''
                 )::int,
                 0
               ),
               0
             ),
             360
           ),
           avg_frame_ms = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,avgFrameMs}', ''
                 )::numeric,
                 0
               ),
               0
             ),
             10000
           ),
           p95_frame_ms = least(
             greatest(
               coalesce(
                 nullif(
                   v_summary#>>'{totals,p95FrameMs}', ''
                 )::numeric,
                 0
               ),
               0
             ),
             10000
           ),
           start_map = coalesce(
             pg_catalog.left(
               nullif(v_summary->>'startMap', ''),
               40
             ),
             start_map
           ),
           start_weapon = coalesce(
             pg_catalog.left(
               nullif(v_summary->>'startWeapon', ''),
               40
             ),
             start_weapon
           ),
           weapon_summary =
             coalesce(v_summary->'weaponSummary', weapon_summary),
           map_summary =
             coalesce(v_summary->'mapSummary', map_summary),
           first_hit_ms = coalesce(
             nullif(
               v_summary#>>'{milestones,firstHitMs}', ''
             )::int,
             first_hit_ms
           ),
           first_switch_ms = coalesce(
             nullif(
               v_summary#>>'{milestones,firstSwitchMs}', ''
             )::int,
             first_switch_ms
           ),
           first_ult_ms = coalesce(
             nullif(
               v_summary#>>'{milestones,firstUltMs}', ''
             )::int,
             first_ult_ms
           ),
           abandon_at_ms = coalesce(
             nullif(
               v_summary#>>'{milestones,abandonAtMs}', ''
             )::int,
             abandon_at_ms
           ),
           suspicious = suspicious or v_suspicious,
           updated_at = pg_catalog.now()
     where id = p_session_id;
  end if;

  -- 5) Full-mode member timeline append with seq dedup/gap tracking.
  v_last_seq := v_sess.last_seq;
  v_has_gap := v_sess.has_gap;
  v_timeline_dropped := v_sess.timeline_dropped;
  if v_allow_timeline and pg_catalog.jsonb_array_length(v_events) > 0 then
    select pg_catalog.jsonb_agg(e order by (e->>'seq')::int),
           pg_catalog.max((e->>'seq')::int),
           pg_catalog.min((e->>'seq')::int),
           pg_catalog.count(*)
      into v_filtered, v_max_new_seq, v_min_new_seq, v_cnt_new
      from pg_catalog.jsonb_array_elements(v_events) e
     where coalesce(
       nullif(e->>'seq', '')::int,
       -1
     ) > v_sess.last_seq;
    if coalesce(v_cnt_new, 0) > 0 then
      if v_min_new_seq > v_sess.last_seq + 1 then
        v_has_gap := true;
      end if;
      if v_max_new_seq - v_sess.last_seq <> v_cnt_new then
        v_has_gap := true;
      end if;
      v_new_timeline :=
        coalesce(v_sess.timeline, '[]'::jsonb) || v_filtered;
      if pg_catalog.jsonb_array_length(v_new_timeline) > c_max_timeline then
        v_timeline_dropped := true;
      else
        update public.telemetry_sessions
           set timeline = v_new_timeline
         where id = p_session_id;
      end if;
      v_last_seq := greatest(v_last_seq, v_max_new_seq);
    end if;
  end if;

  -- 6) Unified sequence/write state.
  v_last_seq := greatest(v_last_seq, v_seq_high);
  update public.telemetry_sessions
     set last_seq = v_last_seq,
         has_gap = v_has_gap,
         timeline_dropped = v_timeline_dropped,
         write_count = write_count + 1,
         updated_at = pg_catalog.now()
   where id = p_session_id;

  return pg_catalog.jsonb_build_object(
    'ok', true,
    'mode', v_mode,
    'lastSeq', v_last_seq
  );
end;
$function$;

notify pgrst, 'reload schema';
