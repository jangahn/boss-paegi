-- 0033: 텔레메트리 perf 필드(렉 진단) — telemetry_sessions additive 컬럼 + ingest RPC latest-wins merge.
-- additive·무중단: 컬럼 default 0, 구 클라(필드 미전송)는 0 으로 저장. RPC 는 prod 정의(pg_get_functiondef)에
-- max_touch 다음 dpr/refresh_hz/avg_frame_ms/p95_frame_ms merge 4줄만 추가해 충실 재생성.

alter table public.telemetry_sessions
  add column if not exists dpr numeric default 0,
  add column if not exists refresh_hz int default 0,
  add column if not exists avg_frame_ms numeric default 0,
  add column if not exists p95_frame_ms numeric default 0;

CREATE OR REPLACE FUNCTION public.ingest_telemetry_delta(p_session_id uuid, p_owner_id uuid, p_is_member boolean, p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  c_daily_cap int := 5000;
  c_max_timeline int := 2000;
  c_max_write int := 400;
  c_max_duration int := 1804000;   -- MAX_DURATION_MS(1800000) + GRACE(4000)
  c_max_score bigint := 5000000;   -- MAX_SCORE_HARD
  c_max_avg_per_sec int := 2000;   -- MAX_AVG_SCORE_PER_SEC
  c_weapon_count int := 9;
  c_map_count int := 6;

  v_budget public.telemetry_budget;
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_mode text;
  v_sess public.telemetry_sessions;
  v_exists boolean;
  v_is_anon boolean := not coalesce(p_is_member, false);
  v_owner uuid := case when coalesce(p_is_member, false) then p_owner_id else null end;
  v_device text;
  v_summary jsonb := coalesce(p_payload->'summary', '{}'::jsonb);
  v_events jsonb := coalesce(p_payload->'events', '[]'::jsonb);
  v_seq_high int := coalesce(nullif(v_summary->>'seqHigh','')::int, 0);
  v_end_reason text := nullif(v_summary->>'endReason','');
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
    return jsonb_build_object('ok', false, 'mode', 'off', 'reason', 'no_session');
  end if;

  -- 1) budget lock + day rollover + mode
  select * into v_budget from public.telemetry_budget where id = true for update;
  if not found then
    insert into public.telemetry_budget(id) values (true) on conflict (id) do nothing;
    select * into v_budget from public.telemetry_budget where id = true for update;
  end if;
  if v_budget.day_kst is distinct from v_today then
    update public.telemetry_budget set day_kst = v_today, new_sessions_today = 0, updated_at = now() where id = true;
    v_budget.day_kst := v_today; v_budget.new_sessions_today := 0;
  end if;
  v_mode := case
    when v_budget.degrade_mode = 'off' then 'off'
    when v_budget.over_budget then 'summary'
    when v_budget.new_sessions_today >= c_daily_cap then 'summary'
    else 'full'
  end;

  -- device clamp
  v_device := coalesce(p_payload->>'deviceClass', 'other');
  if v_device not in ('mobile-touch','mobile-pointer','desktop-touch','desktop-pointer','other') then
    v_device := 'other';
  end if;

  -- 2) session lock / create
  select * into v_sess from public.telemetry_sessions where id = p_session_id for update;
  v_exists := found;

  if not v_exists then
    if v_mode = 'off' then
      return jsonb_build_object('ok', false, 'mode', 'off', 'reason', 'budget');
    end if;
    insert into public.telemetry_sessions(id, owner_id, is_anon, device_class, started_at)
      values (p_session_id, v_owner, v_is_anon, v_device,
              coalesce(nullif(p_payload->>'startedAt','')::timestamptz, now()));
    update public.telemetry_budget set new_sessions_today = new_sessions_today + 1, updated_at = now() where id = true;
    select * into v_sess from public.telemetry_sessions where id = p_session_id for update;
  else
    -- 소유권 검증(member↔anon 경계·승격/강등 금지)
    if (v_sess.owner_id is distinct from v_owner) or (v_sess.is_anon is distinct from v_is_anon) then
      return jsonb_build_object('ok', false, 'mode', v_mode, 'reason', 'owner_mismatch');
    end if;
  end if;

  -- off + 기존: 최종 마무리(session_end)만 1회 허용
  if v_mode = 'off' and v_exists then
    if v_sess.ended_at is not null then
      return jsonb_build_object('ok', true, 'mode', 'off', 'reason', 'already_finalized', 'lastSeq', v_sess.last_seq);
    end if;
    if v_end_reason is null then
      return jsonb_build_object('ok', true, 'mode', 'off', 'reason', 'pending', 'lastSeq', v_sess.last_seq);
    end if;
  end if;

  -- 3) timeline 허용 여부
  v_allow_timeline := (v_mode = 'full') and not v_is_anon
    and not v_sess.timeline_dropped and v_sess.write_count < c_max_write;

  -- 4) summary clamp + latest-wins(staleness guard: seqHigh >= last_seq)
  if v_seq_high >= v_sess.last_seq then
    v_dur := least(greatest(coalesce(nullif(v_summary->>'durationMs','')::int, 0), 0), c_max_duration);
    v_score := least(greatest(coalesce(nullif(v_summary#>>'{totals,score}','')::bigint, 0), 0), c_max_score);
    v_hit := greatest(coalesce(nullif(v_summary#>>'{totals,hitCount}','')::int, 0), 0);
    -- suspicious: score 가 duration 기준 천장 초과 or weapon hits 합이 hitCount 와 크게 불일치
    select coalesce(sum(greatest(coalesce(nullif(e.value->>'hits','')::numeric,0),0)),0)
      into v_wsum from jsonb_each(coalesce(v_summary->'weaponSummary','{}'::jsonb)) e;
    v_suspicious := (v_score > (greatest(1, ceil(v_dur/1000.0)) * c_max_avg_per_sec))
                 or (abs(v_wsum - v_hit) > greatest(10, v_hit * 0.2));

    update public.telemetry_sessions set
      ended_at = coalesce(nullif(v_summary->>'endedAt','')::timestamptz, ended_at),
      end_reason = case when v_end_reason in
        ('normal','time_limit','score_limit','abandon','reload','hidden_timeout') then v_end_reason else end_reason end,
      duration_ms = v_dur,
      score = v_score,
      hit_count = v_hit,
      max_combo = least(greatest(coalesce(nullif(v_summary#>>'{totals,maxCombo}','')::int,0),0), 999999),
      ult_fire_count = least(greatest(coalesce(nullif(v_summary#>>'{totals,ultFireCount}','')::int,0),0), 100000),
      distinct_weapons = least(greatest(coalesce(nullif(v_summary#>>'{totals,distinctWeapons}','')::int,0),0), c_weapon_count),
      distinct_maps = least(greatest(coalesce(nullif(v_summary#>>'{totals,distinctMaps}','')::int,0),0), c_map_count),
      apm = least(greatest(coalesce(nullif(v_summary#>>'{totals,apm}','')::int,0),0), 100000),
      tap_share = least(greatest(coalesce(nullif(v_summary#>>'{totals,tapShare}','')::numeric,0),0), 1),
      max_touch = least(greatest(coalesce(nullif(v_summary#>>'{totals,maxTouch}','')::int,0),0), 20),
      dpr = least(greatest(coalesce(nullif(v_summary #>> '{totals,dpr}', '')::numeric, 0), 0), 8),
      refresh_hz = least(greatest(coalesce(nullif(v_summary #>> '{totals,refreshHz}', '')::int, 0), 0), 360),
      avg_frame_ms = least(greatest(coalesce(nullif(v_summary #>> '{totals,avgFrameMs}', '')::numeric, 0), 0), 10000),
      p95_frame_ms = least(greatest(coalesce(nullif(v_summary #>> '{totals,p95FrameMs}', '')::numeric, 0), 0), 10000),
      start_map = coalesce(left(nullif(v_summary->>'startMap',''), 40), start_map),
      start_weapon = coalesce(left(nullif(v_summary->>'startWeapon',''), 40), start_weapon),
      weapon_summary = coalesce(v_summary->'weaponSummary', weapon_summary),
      map_summary = coalesce(v_summary->'mapSummary', map_summary),
      first_hit_ms = coalesce(nullif(v_summary#>>'{milestones,firstHitMs}','')::int, first_hit_ms),
      first_switch_ms = coalesce(nullif(v_summary#>>'{milestones,firstSwitchMs}','')::int, first_switch_ms),
      first_ult_ms = coalesce(nullif(v_summary#>>'{milestones,firstUltMs}','')::int, first_ult_ms),
      abandon_at_ms = coalesce(nullif(v_summary#>>'{milestones,abandonAtMs}','')::int, abandon_at_ms),
      suspicious = suspicious or v_suspicious,
      updated_at = now()
    where id = p_session_id;
  end if;

  -- 5) timeline append (full only, seq dedup + gap 기록, reject 금지)
  v_last_seq := v_sess.last_seq;
  v_has_gap := v_sess.has_gap;
  v_timeline_dropped := v_sess.timeline_dropped;
  if v_allow_timeline and jsonb_array_length(v_events) > 0 then
    select jsonb_agg(e order by (e->>'seq')::int),
           max((e->>'seq')::int), min((e->>'seq')::int), count(*)
      into v_filtered, v_max_new_seq, v_min_new_seq, v_cnt_new
      from jsonb_array_elements(v_events) e
      where coalesce(nullif(e->>'seq','')::int, -1) > v_sess.last_seq;
    if coalesce(v_cnt_new, 0) > 0 then
      if v_min_new_seq > v_sess.last_seq + 1 then v_has_gap := true; end if;
      if (v_max_new_seq - v_sess.last_seq) <> v_cnt_new then v_has_gap := true; end if;
      v_new_timeline := coalesce(v_sess.timeline, '[]'::jsonb) || v_filtered;
      if jsonb_array_length(v_new_timeline) > c_max_timeline then
        v_timeline_dropped := true;   -- cap 초과 → 요약만, 추가 append 중단
      else
        update public.telemetry_sessions set timeline = v_new_timeline where id = p_session_id;
      end if;
      v_last_seq := greatest(v_last_seq, v_max_new_seq);
    end if;
  end if;

  -- 6) last_seq(통합)·has_gap·write_count·timeline_dropped 반영
  v_last_seq := greatest(v_last_seq, v_seq_high);
  update public.telemetry_sessions set
    last_seq = v_last_seq, has_gap = v_has_gap,
    timeline_dropped = v_timeline_dropped, write_count = write_count + 1, updated_at = now()
  where id = p_session_id;

  return jsonb_build_object('ok', true, 'mode', v_mode, 'lastSeq', v_last_seq);
end; $function$;

revoke all on function public.ingest_telemetry_delta(uuid, uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_telemetry_delta(uuid, uuid, boolean, jsonb) to service_role;
