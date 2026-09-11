-- 0130_telemetry_ingest_envelope_x4.sql — 텔레메트리 적재 의심 임계를 저장 봉투와 동기화(v1.47, anti-abuse v11).
--
-- 드리프트: 0126 이 제출 RPC 의 봉투 리터럴을 2000→4000점/초·500만→800만으로 올렸지만(v1.36 저글링 합산 ×4),
-- 텔레메트리 적재 RPC bp_ingest_telemetry_delta_core(0074 정의, 008900 리네임)의 c_max_avg_per_sec 2000·c_max_score
-- 5000000 은 그대로 남았다. 결과: raw 2,000점/초를 넘는 정상 플레이가 전부 suspicious(sticky) → 제출 신호 S8(치명 가중 3) 오탐.
-- 실사례 2026-09-11: 5손가락·투척 9종·맵 6·44초 정상 플레이 130,130점(2,947/초) → S3+S8, 위험도 4, 랭킹 숨김(어드민 정상 확인).
-- 수정: 두 리터럴을 lib/score-limits.ts 의 MAX_AVG_SCORE_PER_SEC(4000)·MAX_SCORE_HARD(8,000,000)과 같게(c_max_duration
-- 1,804,000 = MAX_DURATION_MS + FORCE_END_GRACE_MS 는 이미 일치). 본문은 프로드 pg_get_functiondef 실측에서 이 두 줄만 바꿨다.
-- 단일 소스 계약: __tests__/score/telemetry-ingest-envelope.test.ts(리터럴 = TS 상수)·supabase/tests/telemetry_ingest_envelope.pgtap.sql
-- (라이브 함수 본문 + 3,900/초 비의심·4,100/초 의심 동작).
-- 데이터 정정: v1.36 배포일(2026-09-11 KST) 이후 세션 중 옛 임계(2000)로만 sticky 된 suspicious 를 새 규칙으로 재평가해 해제
-- (비율 ≤ 4000/초 AND 무기 타격 합계 보존 조건 통과인 행만; 프로드 실측 1행 = 위 사례). 그 이전 세션은 당시 봉투(2000)가
-- 유효했으므로 손대지 않는다. 함수 ACL 은 create or replace 로 보존(service role 전용, 0076/008900).

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
  c_max_avg_per_sec int := 4000;
  c_weapon_count int := 9;
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
$function$
;

update public.telemetry_sessions t
   set suspicious = false
 where t.suspicious
   and t.started_at >= '2026-09-11 00:00:00+09'
   and t.score <= greatest(1, pg_catalog.ceil(t.duration_ms / 1000.0)) * 4000
   and pg_catalog.abs(
         coalesce((
           select pg_catalog.sum(greatest(coalesce(nullif(e.value->>'hits', '')::numeric, 0), 0))
             from pg_catalog.jsonb_each(
               case when pg_catalog.jsonb_typeof(t.weapon_summary) = 'object' then t.weapon_summary else '{}'::jsonb end
             ) e
         ), 0) - t.hit_count
       ) <= greatest(10, t.hit_count * 0.2);
