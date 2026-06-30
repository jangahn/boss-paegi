-- 0046: 공유·유입 분석 도메인 (analytics_events + analytics_rollups) — 텔레/계정/결제 도메인과 격리.
-- 무식별 집계: 식별자(user/member/session/score id)·원본 URL·query·IP·UA 무저장. props 자유필드 없음.
-- raw 90일 보관 + 일별 rollup(장기). cron(app/api/ops/telemetry-maintain)이 maintain → prune 순서로 호출.
-- 적용: Management API(_local/apply-0046.mjs), 코드 배포 전. 기존 telemetry_*/member_accounts/scores 무변경(읽기만).

-- ── 1) raw 이벤트 테이블 ──
create table if not exists public.analytics_events (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('visit','share','conversion')),
  created_at  timestamptz not null default now(),
  day_kst     date not null,  -- BEFORE INSERT 트리거가 created_at(KST)로 세팅(generated column은 at-time-zone STABLE이라 immutable 위반)
  member_state text not null check (member_state in ('anon','member')),  -- Supabase auth session 기준(법적 회원/동의완료와 동일하지 않을 수 있음)
  source_scope text check (source_scope is null or source_scope in ('current','first_touch')),
  source_kind  text check (source_kind is null or source_kind in ('direct','utm','referrer','viral')),
  source_value text,
  referrer_domain text,
  utm_source   text,
  utm_medium   text,
  utm_campaign text,
  viral_type   text check (viral_type is null or viral_type in ('score','doll')),
  surface      text check (surface is null or surface in ('game_over','history','highlight_viewer','doll','gallery')),
  target       text check (target is null or target in ('score','doll','highlight')),
  score_tier   smallint check (score_tier is null or (score_tier between 0 and 9)),  -- lib/report.ts scoreTier 인덱스
  conversion_step text check (conversion_step is null or conversion_step in ('play','signup')),
  result       text check (result is null or result = 'attempt'),  -- MVP는 공유 시도만(success/cancel 미집계)
  -- kind별 필수 + 오염 방지(API zod 외 DB 마지막 방어선)
  constraint analytics_events_kind_shape check (
    case kind
      when 'visit' then
        source_scope is not null and source_kind is not null and source_value is not null
        and surface is null and target is null and score_tier is null
        and conversion_step is null and result is null
      when 'share' then
        surface is not null and target is not null
        and (target = 'score' or score_tier is null)
        and conversion_step is null
        and source_scope is null and source_kind is null and source_value is null
        and referrer_domain is null and utm_source is null and utm_medium is null
        and utm_campaign is null and viral_type is null
      when 'conversion' then
        conversion_step is not null and source_scope = 'first_touch'
        and source_kind is not null and source_value is not null
        and surface is null and target is null and score_tier is null and result is null
      else false
    end
  ),
  -- source_kind ↔ 값 정합성(rollup source 차원 무결성)
  constraint analytics_events_source_shape check (
    source_kind is null
    or (source_kind = 'direct'   and source_value = 'direct')
    or (source_kind = 'utm'      and utm_source is not null and source_value = utm_source)
    or (source_kind = 'referrer' and referrer_domain is not null and source_value = referrer_domain)
    or (source_kind = 'viral'    and viral_type is not null and source_value in ('score','doll'))
  )
);

-- day_kst 트리거(created_at → KST 날짜). created_at default now() 가 트리거 시점 채워짐.
create or replace function public.analytics_events_set_day_kst()
returns trigger language plpgsql as $$
begin
  new.day_kst := (new.created_at at time zone 'Asia/Seoul')::date;
  return new;
end; $$;

drop trigger if exists trg_analytics_events_day_kst on public.analytics_events;
create trigger trg_analytics_events_day_kst
  before insert on public.analytics_events
  for each row execute function public.analytics_events_set_day_kst();

create index if not exists analytics_events_kind_day_idx  on public.analytics_events (kind, day_kst);
create index if not exists analytics_events_visit_src_idx on public.analytics_events (day_kst, source_scope, source_kind, source_value);
create index if not exists analytics_events_conv_idx      on public.analytics_events (day_kst, conversion_step);
create index if not exists analytics_events_share_idx     on public.analytics_events (day_kst, surface, target);

alter table public.analytics_events enable row level security;  -- 정책 없음 → service_role 만 접근(클라 직접 insert/select 차단)
revoke all on public.analytics_events from public, anon, authenticated;
grant all on public.analytics_events to service_role;

-- ── 2) 일별 사전집계 rollup ──
create table if not exists public.analytics_rollups (
  day_kst    date not null,
  metric     text not null check (metric in (
    'visit_by_source','share_by_surface','share_by_target','share_by_score_tier',
    'share_by_member_state','share_game_over','score_submit','play_session',
    'conversion_play_by_source','conversion_signup_by_source','viral_inbound_by_type'
  )),
  dim1       text not null default '',  -- nullable이면 unique가 NULL을 다 다르게 봐 중복 row → not null '' 정규화
  dim2       text not null default '',
  dim3       text not null default '',
  dim4       text not null default '',
  value      bigint not null default 0,
  updated_at timestamptz not null default now(),
  unique (day_kst, metric, dim1, dim2, dim3, dim4)
);
create index if not exists analytics_rollups_day_metric_idx on public.analytics_rollups (day_kst, metric);

alter table public.analytics_rollups enable row level security;
revoke all on public.analytics_rollups from public, anon, authenticated;
grant all on public.analytics_rollups to service_role;

-- ── 3) 롤업 maintain(idempotent: 대상일 delete 후 재계산, advisory lock 으로 동시 실행 방지, += 금지) ──
-- metric 별 dim 의미(getter 와 일치):
--   visit_by_source(d1=source_scope,d2=source_kind,d3=source_value) · share_by_surface(d1=surface)
--   share_by_target(d1=target) · share_by_score_tier(d1=score_tier) · share_by_member_state(d1=member_state)
--   share_game_over(무dim) · score_submit(무dim,scores) · play_session(무dim,scores distinct session)
--   conversion_play_by_source/conversion_signup_by_source(d1=source_kind,d2=source_value) · viral_inbound_by_type(d1=viral_type)
create or replace function public.maintain_analytics_rollups(p_days int default 7)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_d date; v_lo timestamptz; v_hi timestamptz; i int;
begin
  perform pg_advisory_xact_lock(hashtext('analytics_rollups'));  -- 동시/반복 실행 직렬화
  for i in 0 .. greatest(0, p_days - 1) loop
    v_d  := v_today - i;
    v_lo := (v_d::timestamp at time zone 'Asia/Seoul');
    v_hi := ((v_d + 1)::timestamp at time zone 'Asia/Seoul');

    delete from public.analytics_rollups where day_kst = v_d;

    -- visit_by_source
    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'visit_by_source', coalesce(source_scope,''), coalesce(source_kind,''), coalesce(source_value,''), '', count(*), now()
    from public.analytics_events where kind = 'visit' and day_kst = v_d
    group by source_scope, source_kind, source_value;

    -- viral_inbound_by_type (first_touch + viral visit)
    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'viral_inbound_by_type', coalesce(viral_type,''), '', '', '', count(*), now()
    from public.analytics_events
    where kind = 'visit' and source_scope = 'first_touch' and source_kind = 'viral' and day_kst = v_d
    group by viral_type;

    -- share 분포
    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'share_by_surface', coalesce(surface,''), '', '', '', count(*), now()
    from public.analytics_events where kind = 'share' and day_kst = v_d group by surface;

    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'share_by_target', coalesce(target,''), '', '', '', count(*), now()
    from public.analytics_events where kind = 'share' and day_kst = v_d group by target;

    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'share_by_score_tier', coalesce(score_tier::text,''), '', '', '', count(*), now()
    from public.analytics_events where kind = 'share' and target = 'score' and day_kst = v_d group by score_tier;

    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'share_by_member_state', member_state, '', '', '', count(*), now()
    from public.analytics_events where kind = 'share' and day_kst = v_d group by member_state;

    -- 게임오버 공유(전환 분자): surface=game_over AND target=score
    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'share_game_over', '', '', '', '', count(*), now()
    from public.analytics_events where kind = 'share' and surface = 'game_over' and target = 'score' and day_kst = v_d;

    -- 전환(source별)
    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'conversion_play_by_source', coalesce(source_kind,''), coalesce(source_value,''), '', '', count(*), now()
    from public.analytics_events where kind = 'conversion' and conversion_step = 'play' and day_kst = v_d
    group by source_kind, source_value;

    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'conversion_signup_by_source', coalesce(source_kind,''), coalesce(source_value,''), '', '', count(*), now()
    from public.analytics_events where kind = 'conversion' and conversion_step = 'signup' and day_kst = v_d
    group by source_kind, source_value;

    -- score_submit(전환 분모) + play_session(볼륨): scores 테이블 KST day 읽기집계(컬럼 추가 없음)
    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'score_submit', '', '', '', '', count(*), now()
    from public.scores where created_at >= v_lo and created_at < v_hi;

    insert into public.analytics_rollups(day_kst, metric, dim1, dim2, dim3, dim4, value, updated_at)
    select v_d, 'play_session', '', '', '', '', count(distinct telemetry_session_id), now()
    from public.scores where created_at >= v_lo and created_at < v_hi and telemetry_session_id is not null;
  end loop;
  return jsonb_build_object('ok', true, 'days', p_days);
end; $$;

revoke all on function public.maintain_analytics_rollups(int) from public, anon, authenticated;
grant execute on function public.maintain_analytics_rollups(int) to service_role;

-- ── 4) prune(rollup 성공 후 호출 전제 · 당일 제외 · raw 90일 보관) ──
create or replace function public.prune_analytics_events(p_retention_days int default 90)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_cutoff date := v_today - p_retention_days;
  v_deleted int := 0;
begin
  delete from public.analytics_events where day_kst < v_cutoff;  -- 당일(=v_today)은 항상 보존
  get diagnostics v_deleted = row_count;
  return jsonb_build_object('ok', true, 'deleted', v_deleted, 'cutoff', v_cutoff);
end; $$;

revoke all on function public.prune_analytics_events(int) from public, anon, authenticated;
grant execute on function public.prune_analytics_events(int) to service_role;

notify pgrst, 'reload schema';
