-- 0115: 점수 제출 코어의 대표 무기 allowlist 에 'pinch' 추가 (v1.12 핫픽스)
--
-- v1.12 가 종이→꼬집기(pinch) 교체를 앱 레이어(WEAPONS/anti-abuse v8)에서만 반영했고,
-- bp_submit_score_with_review_core 의 `p_weapon not in (...)` 프로토콜 검사는 하드코딩
-- 목록이라 대표 무기가 pinch 인 제출이 invalid_score_protocol → invalid_submission 으로
-- 거절됐다(2026-09-02 14:08 KST 회원 세션 실측). 'paper' 는 은퇴 무기지만 구 번들 클라의
-- 제출 관용을 위해 유지한다.
--
-- 본문은 프로덕션 pg_get_functiondef 실측본(0074 이후 진화 반영)에서 allowlist 한 줄만 변경.
-- 규약: 무기 추가/제거 시 이 함수의 allowlist 갱신이 동반 필수(README v1.12·KB).

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
       pg_catalog.ceil(p_duration_ms / 1000.0 * 2000)::int,
       5000000
     )
     or p_duration_ms is null
     or p_duration_ms <= 0
     or p_duration_ms > 1800000
     or v_max_combo >= 100000
     or p_weapon is null
     or p_weapon not in (
       'fist', 'hammer', 'slap', 'book', 'keyboard',
       'paper', 'gun', 'grab', 'pinch', 'pen'
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

-- ── telemetry_rollup_rows_for_day: 메인무기 동률 tie-break 순서 배열(c_weapon_order)에도 'pinch' 추가.
-- (0110 주석 "무기 추가 시 함께 갱신" — 미갱신 시 pinch 는 동률에서만 항상 후순위. 프로덕션 실측본 기준 한 줄 변경.)

CREATE OR REPLACE FUNCTION public.telemetry_rollup_rows_for_day(p_day date)
 RETURNS TABLE(dim_type text, dim_key text, sessions integer, hits bigint, score bigint, attempts integer, switches integer, measure_a numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- lib/weapon-keys.ts WEAPON_KEYS 정의 순서(메인무기 동률 3순위 tie-break) — 무기 추가 시 함께 갱신.
  c_weapon_order constant text[] :=
    array['fist','hammer','slap','book','keyboard','paper','gun','grab','pinch','pen'];
  -- lib/admin-analytics 의 기존 세션단위 집계 상수와 동일(의미 이관 — 단일 소스는 이제 여기).
  c_min_valid_duration_ms constant int := 3000;   -- throughput 유효 최소 플레이 시간
  c_sps_bucket_cap constant int := 3000;          -- 점수/초 히스토그램 cap(폭 1)
  c_perf_bucket_cap constant int := 200;          -- 프레임타임 히스토그램 cap(폭 1ms)
  c_perf_lag_p95_ms constant numeric := 33;       -- p95 렉 경계(≈30fps 미달)
  v_lo timestamptz;
  v_hi timestamptz;
begin
  if p_day is null then
    raise exception 'telemetry_rollup_rows_for_day_invalid_day' using errcode = '22023';
  end if;
  v_lo := (p_day::timestamp at time zone 'Asia/Seoul');
  v_hi := ((p_day + 1)::timestamp at time zone 'Asia/Seoul');

  return query
  with sess as (
    select
      ts.id,
      ts.device_class,
      ts.end_reason,
      ts.duration_ms,
      ts.score as raw_score,
      ts.distinct_weapons,
      ts.distinct_maps,
      ts.start_map,
      ts.avg_frame_ms,
      ts.p95_frame_ms,
      ts.first_hit_ms,
      ts.first_switch_ms,
      ts.first_ult_ms,
      ts.weapon_summary,
      ts.map_summary,
      w.dw_summary,
      w.hits_total,
      w.hits_sumsq,
      mw.main_weapon,
      msw.map_switches,
      -- distinct 무기수: summary(hits>0 key) 우선, 없으면 컬럼 fallback(기존 JS distinctWeaponsOf 이관)
      case when w.dw_summary > 0 then w.dw_summary
           else greatest(coalesce(ts.distinct_weapons, 0), 0) end as dw_eff
    from public.telemetry_sessions ts
    left join lateral (
      select
        count(*) filter (where coalesce((e.value->>'hits')::numeric, 0) > 0) as dw_summary,
        coalesce(sum(coalesce((e.value->>'hits')::numeric, 0))
          filter (where coalesce((e.value->>'hits')::numeric, 0) > 0), 0) as hits_total,
        coalesce(sum(power(coalesce((e.value->>'hits')::numeric, 0), 2))
          filter (where coalesce((e.value->>'hits')::numeric, 0) > 0), 0) as hits_sumsq
      from jsonb_each(ts.weapon_summary) e
    ) w on true
    left join lateral (
      -- 메인무기: hits desc → score desc → 고정 무기순서 → key(기존 JS mainWeaponOf 이관)
      select e.key as main_weapon
      from jsonb_each(ts.weapon_summary) e
      where coalesce((e.value->>'hits')::numeric, 0) > 0
      order by
        (e.value->>'hits')::numeric desc,
        coalesce((e.value->>'score')::numeric, 0) desc,
        coalesce(array_position(c_weapon_order, e.key), 2147483647),
        e.key
      limit 1
    ) mw on true
    left join lateral (
      select coalesce(sum(coalesce((e.value->>'switches')::numeric, 0)), 0) as map_switches
      from jsonb_each(ts.map_summary) e
    ) msw on true
    where ts.started_at >= v_lo and ts.started_at < v_hi
  ),
  eligible as (
    -- throughput 표본: 완료 + 유효 duration + 메인무기 존재(기존 JS 게이트 이관)
    select
      s.main_weapon,
      s.dw_eff,
      (coalesce(s.raw_score, 0)::numeric / (s.duration_ms / 1000.0)) as sps
    from sess s
    where s.end_reason in ('normal', 'time_limit', 'score_limit')
      and coalesce(s.duration_ms, 0) > c_min_valid_duration_ms
      and s.main_weapon is not null
  )
  -- 무기 차원(0095 의미 보존 — summary 의 key 별, hits=0 key 포함)
  select 'weapon'::text, e.key, count(distinct s.id)::int,
    coalesce(sum((e.value->>'hits')::numeric), 0)::bigint,
    coalesce(sum((e.value->>'score')::numeric), 0)::bigint,
    coalesce(sum((e.value->>'attempts')::numeric), 0)::int,
    coalesce(sum((e.value->>'switches')::numeric), 0)::int,
    0::numeric
  from sess s, lateral jsonb_each(s.weapon_summary) e
  group by e.key
  union all
  -- 맵 차원(0095 의미 보존)
  select 'map'::text, e.key, count(distinct s.id)::int,
    coalesce(sum((e.value->>'hits')::numeric), 0)::bigint,
    coalesce(sum((e.value->>'score')::numeric), 0)::bigint,
    coalesce(sum((e.value->>'attempts')::numeric), 0)::int,
    coalesce(sum((e.value->>'switches')::numeric), 0)::int,
    0::numeric
  from sess s, lateral jsonb_each(s.map_summary) e
  group by e.key
  union all
  -- 펀널 단계(0095 의미 보존 — 항상 8행/일)
  select 'funnel_step'::text, f.step, f.cnt::int, 0::bigint, 0::bigint, 0::int, 0::int, 0::numeric
  from (
    select 'entered' as step, count(*) as cnt from sess
    union all select 'first_hit', count(*) from sess where first_hit_ms is not null
    union all select 'first_switch', count(*) from sess where first_switch_ms is not null
    union all select 'first_ult', count(*) from sess where first_ult_ms is not null
    union all select 'completed', count(*) from sess where end_reason = 'normal'
    union all select 'forced', count(*) from sess where end_reason in ('time_limit', 'score_limit')
    union all select 'abandoned', count(*) from sess where end_reason in ('abandon', 'reload', 'hidden_timeout')
    union all select 'multi_map', count(*) from sess where distinct_maps >= 2
  ) f
  union all
  -- 세션단위 스칼라 합계(measure_a=값) — 항상 12행/일(빈 날 0)
  select 'sess_stat'::text, t.k, 0::int, 0::bigint, 0::bigint, 0::int, 0::int, t.v
  from (
    select 'sessions_total' as k, count(*)::numeric as v from sess
    union all select 'weapon_sessions', count(*) from sess where dw_eff >= 1
    union all select 'single_weapon_sessions', count(*) from sess where dw_eff = 1
    union all select 'distinct_weapons_sum', coalesce(sum(dw_eff) filter (where dw_eff >= 1), 0) from sess
    union all select 'hhi_sum',
      coalesce(sum(hits_sumsq / (hits_total * hits_total)) filter (where hits_total > 0), 0) from sess
    union all select 'hhi_sessions', count(*) from sess where hits_total > 0
    union all select 'map_sessions', count(*) from sess where start_map is not null
    union all select 'single_map_sessions', count(*) from sess
      where start_map is not null and greatest(coalesce(distinct_maps, 0), 0) = 1
    union all select 'distinct_maps_sum',
      coalesce(sum(greatest(coalesce(distinct_maps, 0), 0)) filter (where start_map is not null), 0) from sess
    union all select 'map_switch_sum',
      coalesce(sum(map_switches) filter (where start_map is not null), 0) from sess
    union all select 'throughput_eligible', count(*) from eligible
    union all select 'perf_sessions', count(*) from sess where coalesce(avg_frame_ms, 0) > 0
  ) t
  union all
  -- 메인무기 분포(raw key — unknown 접기는 getter 가 담당)
  select 'sess_main_weapon'::text, s.main_weapon, 0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from sess s where s.main_weapon is not null
  group by s.main_weapon
  union all
  -- 시작맵 분포(raw key)
  select 'sess_start_map'::text, s.start_map, 0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from sess s where s.start_map is not null
  group by s.start_map
  union all
  -- 점수/초 히스토그램(메인무기 기준 전체 표본)
  select 'sess_sps_all'::text,
    e.main_weapon || '|' || least(floor(e.sps), c_sps_bucket_cap)::int,
    0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from eligible e
  group by e.main_weapon, least(floor(e.sps), c_sps_bucket_cap)::int
  union all
  -- 점수/초 히스토그램(단일무기 pure 표본)
  select 'sess_sps_pure'::text,
    e.main_weapon || '|' || least(floor(e.sps), c_sps_bucket_cap)::int,
    0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from eligible e
  where e.dw_eff = 1
  group by e.main_weapon, least(floor(e.sps), c_sps_bucket_cap)::int
  union all
  -- 프레임타임 히스토그램(avg) — perf 실표본(avg>0)만
  select 'sess_perf_avg'::text,
    s.device_class || '|' || least(floor(s.avg_frame_ms), c_perf_bucket_cap)::int,
    0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from sess s where coalesce(s.avg_frame_ms, 0) > 0
  group by s.device_class, least(floor(s.avg_frame_ms), c_perf_bucket_cap)::int
  union all
  -- 프레임타임 히스토그램(p95)
  select 'sess_perf_p95'::text,
    s.device_class || '|' || least(floor(s.p95_frame_ms), c_perf_bucket_cap)::int,
    0::int, 0::bigint, 0::bigint, 0::int, 0::int, count(*)::numeric
  from sess s where coalesce(s.avg_frame_ms, 0) > 0
  group by s.device_class, least(floor(s.p95_frame_ms), c_perf_bucket_cap)::int
  union all
  -- device_class 별 정확 카운트: sessions=perf 세션수, measure_a=렉 세션수(p95>33ms 정확 판정)
  select 'sess_perf_dev'::text, s.device_class,
    count(*)::int, 0::bigint, 0::bigint, 0::int, 0::int,
    count(*) filter (where s.p95_frame_ms > c_perf_lag_p95_ms)::numeric
  from sess s where coalesce(s.avg_frame_ms, 0) > 0
  group by s.device_class;
end;
$function$;

