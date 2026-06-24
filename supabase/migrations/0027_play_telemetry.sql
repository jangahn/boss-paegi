-- 0027: 게임플레이 텔레메트리 — 세션당 1행 jsonb 타임라인 + 운영 budget + 롤업(빈 테이블) + 원자 ingest RPC.
--
-- 설계(플랜 v5):
--  · telemetry_sessions = 세션당 1행. immutable(id·owner_id·is_anon·device_class·started_at)은 최초 insert만,
--    mutable(요약·timeline·last_seq…)은 flush 마다 RPC 가 원자 merge. 회원=풀 timeline, 익명=timeline null+요약만.
--  · 저장소 server-only(anon/authenticated revoke + service_role grant). 쓰기는 ingest RPC(security definer)로만.
--  · 30MB=운영 target budget(Supabase 500MB 한계 아님). env kill-switch·자동 샘플링 없음 → budget DB row 기준
--    full/summary/off 자동 degrade. day rollover·신규세션 cap 은 ingest RPC 가 처리(cron 실패해도 동작).
--  · 유지보수 RPC(rollup_days/prune/budget_refresh)는 0028(PR2)에서. 여기선 ingest 만.
-- additive·무중단(소비자 코드는 0027 미적용 시에도 무영향, /api/score 는 telemetry_session_id fallback).

-- ── 세션 ──────────────────────────────────────────────────────────────────
create table if not exists public.telemetry_sessions (
  -- immutable (최초 insert만)
  id uuid primary key,                                        -- 클라 crypto.randomUUID (세션 한정 ephemeral)
  owner_id uuid references public.profiles(id) on delete set null,  -- 회원만, 익명=null
  is_anon boolean not null,                                   -- 서버 판정(member_accounts 기준)
  device_class text not null,                                 -- 서버 allowlist clamp(coarse·무PII)
  started_at timestamptz not null default now(),
  -- mutable (flush 갱신)
  ended_at timestamptz,
  end_reason text,                                            -- normal|time_limit|score_limit|abandon|reload|hidden_timeout
  duration_ms int,
  score bigint default 0,
  hit_count int default 0,
  max_combo int default 0,
  ult_fire_count int default 0,
  distinct_weapons int default 0,
  distinct_maps int default 0,
  apm int default 0,
  tap_share numeric default 0,                                -- tap 카테고리 타격 비중 0~1
  max_touch int default 0,                                    -- 최대 동시 터치 수
  start_map text,
  start_weapon text,
  weapon_summary jsonb not null default '{}'::jsonb,          -- {weapon:{hits,score,attempts,switches}} (익명도 저장)
  map_summary jsonb not null default '{}'::jsonb,             -- {map:{hits,score,attempts,switches}} (익명도 저장)
  first_hit_ms int,
  first_switch_ms int,
  first_ult_ms int,
  abandon_at_ms int,
  timeline jsonb,                                             -- 회원 풀 캡처만(익명 항상 null). 30일 후 prune.
  last_seq int not null default 0,                            -- 통합 accepted seq(멱등)
  has_gap boolean not null default false,
  write_count int not null default 0,
  timeline_dropped boolean not null default false,
  suspicious boolean not null default false,                  -- 이상값 clamp 시 플래그(reject 아님)
  updated_at timestamptz not null default now()
);
alter table public.telemetry_sessions enable row level security;
revoke all on public.telemetry_sessions from anon, authenticated;  -- 정책 없음 → 비-service_role 접근 0
grant all on public.telemetry_sessions to service_role;
create index if not exists idx_telemetry_sessions_started on public.telemetry_sessions(started_at);
create index if not exists idx_telemetry_sessions_owner on public.telemetry_sessions(owner_id) where owner_id is not null;
create index if not exists idx_telemetry_sessions_anon on public.telemetry_sessions(is_anon, started_at);

-- ── 운영 budget(단일 행 강제) ────────────────────────────────────────────────
create table if not exists public.telemetry_budget (
  id boolean primary key default true check (id),            -- 단일 행만(id=true)
  over_budget boolean not null default false,                -- cron(pg_total_relation_size) 판정
  degrade_mode text not null default 'full' check (degrade_mode in ('full','summary','off')),
  day_kst date,
  new_sessions_today int not null default 0,
  updated_at timestamptz not null default now()
);
alter table public.telemetry_budget enable row level security;
revoke all on public.telemetry_budget from anon, authenticated;
grant all on public.telemetry_budget to service_role;
insert into public.telemetry_budget(id, over_budget, degrade_mode, new_sessions_today)
  values (true, false, 'full', 0) on conflict (id) do nothing;

-- ── 롤업(빈 테이블 — PR2 rollup RPC 가 채움) ─────────────────────────────────
create table if not exists public.telemetry_rollups (
  day_kst date not null,
  dim_type text not null,                                    -- weapon|map|funnel_step
  dim_key text not null,
  sessions int not null default 0,
  hits bigint not null default 0,
  score bigint not null default 0,
  attempts int not null default 0,
  switches int not null default 0,
  measure_a numeric not null default 0,                       -- 차원별 추가 measure(펀널 카운트 등)
  updated_at timestamptz not null default now(),
  primary key (day_kst, dim_type, dim_key)
);
alter table public.telemetry_rollups enable row level security;
revoke all on public.telemetry_rollups from anon, authenticated;
grant all on public.telemetry_rollups to service_role;

-- ── scores ↔ 세션 링크(additive, 부분 unique = 이중 링크/중복 제출 방지) ──────────
alter table public.scores add column if not exists telemetry_session_id uuid;
create unique index if not exists uq_scores_telemetry_session
  on public.scores(telemetry_session_id) where telemetry_session_id is not null;

-- ── 원자 ingest(단일 RPC — race 방지) ───────────────────────────────────────
-- API(공개 라우트)가 parse·member 판별·deep validation 후 service_role 로만 호출.
create or replace function public.ingest_telemetry_delta(
  p_session_id uuid,
  p_owner_id uuid,
  p_is_member boolean,
  p_payload jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
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
end; $$;

revoke all on function public.ingest_telemetry_delta(uuid, uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.ingest_telemetry_delta(uuid, uuid, boolean, jsonb) to service_role;
