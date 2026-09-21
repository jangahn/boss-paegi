-- 0131_telemetry_key_actions.sql — PC 키보드 조작(v1.50) 사용 기록: 세션 스칼라 key_actions + 게임 분석 「키보드 사용」 차원.
--
-- 배경: v1.50 이 스페이스·방향키 공격(가상 포인터 제스처)을 추가했다. 키보드 판은 pointer 이벤트가 없어 max_touch 0 으로
-- 기록되므로, 입력 출처를 따로 남기지 않으면 어드민 어뷰징 상세에서 "터치 0 인데 타격 N" 세션의 맥락을 알 수 없고 기능 사용률도
-- 볼 수 없다. 사용자 결정(2026-09-21): 텔레메트리를 확장하고 게임 분석 대시보드에 키보드 사용 비율까지 낸다.
--
-- ① telemetry_sessions.key_actions — 스페이스·방향키로 수행된 공격 동작 수(쿨다운 통과분, 궁극기 발동 포함). max_touch 와 같은
--    세션 스칼라(클라 totals.keyActions → lib/telemetry/validate.ts 0~1e6 클램프 → 여기 0~1,000,000 클램프). additive·nullable default 0.
-- ② bp_ingest_telemetry_delta_core — 프로드 pg_get_functiondef 실측 본문(= 0130 본문, md5 13bddce7…)에 key_actions 대입 한 블록을
--    더하고(max_touch 블록 바로 뒤) **c_weapon_count 9 → 19** 로 고쳤다. 봉투 리터럴(4000/초·800만·1,804,000ms)·의심 판정·
--    ACL(create or replace 로 보존)은 불변.
--    c_weapon_count 드리프트: 0027(무기 9종 시절) 값이 v1.35(0125, 무기 19종)에서 안 올라가 distinct_weapons 컬럼이 9 로
--    잘리고 있었다(클라 검증기는 WEAPON_KEYS.length 로 클램프). 0130 의 봉투 리터럴과 같은 종류의 드리프트라 같은 방식으로
--    TS 상수와의 계약 테스트로 고정한다. 롤업은 무기별 summary 를 우선 쓰므로 과거 집계 영향은 없고, 과거 행은 고치지 않는다
--    (원본 값이 남아 있지 않다).
--    구 클라(필드 없음)는 coalesce 로 0 — 새 RPC 는 구 번들과 호환, 구 RPC 는 새 필드를 무시 → Phase A(이 파일 선적용) → 앱 배포.
-- ③ telemetry_rollup_rows_for_day — 프로드 실측 본문(= 0125 본문, md5 eec54cfb…)에 sess CTE 의 key_actions 와 차원
--    'sess_keyboard'(device_class 별: sessions=타격이 있었던 세션수, measure_a=키보드 사용 세션수, hits=키보드 동작 수 합)만 더했다.
--    롤업 유지 함수·하이브리드 라이브 읽기는 이 함수의 소비자라 자동 승계(0110). 도입 전 날짜는 기능이 없었으므로 백필하지 않는다.
-- 단일 소스 계약: __tests__/telemetry/key-actions-contract.test.ts · supabase/tests/telemetry_key_actions.pgtap.sql.

alter table public.telemetry_sessions add column if not exists key_actions integer default 0;
comment on column public.telemetry_sessions.key_actions is
  'PC 키보드(스페이스·방향키)로 수행된 공격 동작 수(v1.50) — 쿨다운 통과분, 궁극기 발동 포함. 0 = 포인터 전용 세션.';

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
$function$
;

CREATE OR REPLACE FUNCTION public.telemetry_rollup_rows_for_day(p_day date)
 RETURNS TABLE(dim_type text, dim_key text, sessions integer, hits bigint, score bigint, attempts integer, switches integer, measure_a numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  -- lib/weapon-keys.ts WEAPON_KEYS 정의 순서(메인무기 동률 3순위 tie-break) — 무기 추가 시 함께 갱신.
  c_weapon_order constant text[] :=
    array['fist','hammer','slap','book','keyboard','paper','gun','grab','pinch','pen',
                  'mug','ramen','printer','note','laptop','phone','umbrella','beer','chicken'];
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
      ts.key_actions,
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
  group by s.device_class
  union all
  -- 키보드 사용(v1.50) — device_class 별, 타격이 있었던 세션만: sessions=플레이 세션수, measure_a=그중 키보드 공격 동작이
  -- 있었던 세션수, hits=키보드 공격 동작 수 합. 어드민 「키보드 사용」 비율의 단일 소스(도입 전 날짜는 행이 없다).
  select 'sess_keyboard'::text, s.device_class,
    count(*)::int, coalesce(sum(greatest(coalesce(s.key_actions, 0), 0)), 0)::bigint, 0::bigint, 0::int, 0::int,
    count(*) filter (where coalesce(s.key_actions, 0) > 0)::numeric
  from sess s where s.first_hit_ms is not null
  group by s.device_class
  union all
  -- 패기 유형 분포(v1.14) — 제출 시점 판정 유형(score_stats.persona_id). stats 는 공개(visible) 제출에서만
  -- 커밋되므로 = 공개 제출 게임. sessions=게임 수, score=점수 합(평균 산출용). 일자 = 제출 시각 KST.
  select 'persona_games'::text, st.persona_id,
    count(*)::int, 0::bigint, coalesce(sum(s.score), 0)::bigint, 0::int, 0::int, 0::numeric
  from public.score_stats st
  join public.scores s on s.id = st.score_id
  where st.persona_id is not null
    and s.created_at >= v_lo and s.created_at < v_hi
  group by st.persona_id
  union all
  -- 점수 구간 분포(v1.24) — 공개 제출 게임(registered·cleared)을 1,000점 버킷으로. 경계(score_config.thresholds)와
  -- 무관한 히스토그램이라 어드민이 현재 경계로 합산한다(경계 변경 시 과거 판 재분류 정확 — 경계는 1,000 단위 제약).
  -- sessions=게임 수, score=점수 합, measure_a=duration_ms 합(평균 소요시간용). 일자 = 제출 시각 KST.
  select 'game_score_1k'::text, (s.score / 1000)::text,
    count(*)::int, 0::bigint, coalesce(sum(s.score), 0)::bigint, 0::int, 0::int, coalesce(sum(s.duration_ms), 0)::numeric
  from public.scores s
  where s.review_status in ('registered', 'cleared')
    and s.created_at >= v_lo and s.created_at < v_hi
  group by (s.score / 1000);
end;
$function$
;

notify pgrst, 'reload schema';
