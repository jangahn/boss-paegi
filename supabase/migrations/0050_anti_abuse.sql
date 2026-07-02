-- 0050: 점수 어뷰징 방지 토대 (ADDITIVE)
--
-- 적용: management API query 엔드포인트로 직접 실행
--   POST https://api.supabase.com/v1/projects/<ref>/database/query  (Bearer SUPABASE_ACCESS_TOKEN)
--
-- 배경: 리더보드 1·2위가 오토클리커/직접제출 조작 점수였음(전수조사 2026-07-02).
-- 이 마이그는 (a) 가시성 상태 컬럼 (b) 리뷰 큐/감사 테이블 (c) 공개면 RPC 필터 를 추가한다.
-- 판정·제출 로직(원자 RPC submit_score_with_review)은 PR2 에서 별도.

-- ── 1) scores.review_status — 공개 가시성 SoT ─────────────────────────────
-- registered: 자동 clean · pending: 검토대기(숨김) · cleared: 운영자 확인(노출) · voided: 무효/banned(숨김)
alter table public.scores add column if not exists review_status text not null default 'registered'
  check (review_status in ('registered','pending','cleared','voided'));
-- 리더보드 필터+정렬 인덱스
create index if not exists scores_review_status_score_idx on public.scores (review_status, score desc);

-- ── 2) telemetry_sessions.interval_cv — 타격간격 CV(PR6 에서 채움, 봇=거의 0) ──
alter table public.telemetry_sessions add column if not exists interval_cv numeric;

-- ── 3) member_accounts.abuse_status ───────────────────────────────────────
alter table public.member_accounts add column if not exists abuse_status text not null default 'clean'
  check (abuse_status in ('clean','flagged','banned'));

-- ── 4) score_flags — 리뷰 큐 + 감사 (server-only) ─────────────────────────
create table if not exists public.score_flags (
  score_id uuid primary key references public.scores(id) on delete cascade,
  signals jsonb not null default '[]'::jsonb,      -- [{id,value,threshold,source:'submit'|'cron'|'admin'}]
  evidence jsonb not null default '{}'::jsonb,     -- 제출당시 스냅샷(allowlist, PII/raw payload 금지)
  abuse_score int not null default 0,
  rules_version text not null default '2026-07-anti-abuse-v1',
  status text not null default 'pending' check (status in ('pending','cleared','voided')),
  action text,
  reviewed_by uuid references public.profiles(id),
  reviewed_at timestamptz,
  reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
alter table public.score_flags enable row level security;
revoke all on public.score_flags from anon, authenticated;   -- service_role(admin client) 만
-- updated_at/version BEFORE UPDATE 트리거(0007 set_updated_at_and_version 재사용)
drop trigger if exists trg_score_flags_audit on public.score_flags;
create trigger trg_score_flags_audit before update on public.score_flags
  for each row execute function public.set_updated_at_and_version();

-- ── 5) integrity_actions_ledger — 전용 감사 테이블(legal_documents_audit 선례) ──
create table if not exists public.integrity_actions_ledger (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid references public.profiles(id),   -- cron_flag 는 null
  action_type text not null check (action_type in
    ('score_clear','score_void','manual_void','member_ban','member_unban','cron_flag')),
  target_type text not null check (target_type in ('score','member')),
  target_id uuid not null,
  reason text,
  meta jsonb,   -- allowlist: score_id·signal ids·previous_status·next_status·rules_version. PII/raw payload/IP/UA/full telemetry 금지
  created_at timestamptz not null default now()
);
alter table public.integrity_actions_ledger enable row level security;
revoke all on public.integrity_actions_ledger from anon, authenticated;

-- ── 6) get_leaderboard 재정의 — visible(registered|cleared)만 ──────────────
-- 0032 정의에 windowed CTE where 에 review_status 필터 한 줄만 추가. 시그니처/속성 동일.
create or replace function public.get_leaderboard(period text default 'daily', max_limit int default 10)
returns table (
  id uuid, owner_id uuid, score int, weapon text, duration_ms int,
  created_at timestamptz, display_name text, avatar_url text
)
language sql stable security invoker set search_path = public
as $$
  with windowed as (
    select s.*
    from public.scores s
    where s.review_status in ('registered','cleared')   -- 어뷰징 pending/voided 제외(0050)
      and s.created_at >= case
        when period = 'weekly'
          then (date_trunc('week', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
        when period = 'monthly'
          then (date_trunc('month', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
        else (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul')
      end
  ),
  best as (
    select distinct on (owner_id) *
    from windowed
    order by owner_id, score desc, created_at desc
  )
  select b.id, b.owner_id, b.score, b.weapon, b.duration_ms, b.created_at,
         p.display_name, p.avatar_url
  from best b
  left join public.profiles p on p.id = b.owner_id
  order by b.score desc, b.created_at desc
  limit max_limit;
$$;
grant execute on function public.get_leaderboard(text, int) to anon, authenticated;

-- ── 7) get_score_percentile 재정의 — visible 모수만 ───────────────────────
-- 조작 점수를 모수에서 제외해 정상 유저 백분위 왜곡 방지.
create or replace function public.get_score_percentile(p_score int)
returns int
language sql stable security invoker set search_path = public
as $$
  select case
    when count(*) = 0 then null
    else least(ceil(100.0 * (count(*) filter (where score > p_score) + 1) / count(*))::int, 100)
  end
  from public.scores
  where review_status in ('registered','cleared');   -- 어뷰징 pending/voided 제외(0050)
$$;
grant execute on function public.get_score_percentile(int)
  to anon, authenticated, service_role;
