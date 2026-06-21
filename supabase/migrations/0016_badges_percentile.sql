-- 0016: 뱃지 수집(user_badges) + 백분위 RPC (ADDITIVE)
--
-- 적용: management API query 엔드포인트.
-- user_badges = owner_id 별 누적 수집(승격 시 user.id 유지로 보존). score_stats.badge_ids 는
-- "이번 판" 스냅샷(공유/리포트용)으로 역할 분리.

create table if not exists public.user_badges (
  owner_id uuid not null references public.profiles(id) on delete cascade,
  badge_id text not null,
  first_earned_at timestamptz not null default now(),
  first_score_id uuid references public.scores(id) on delete set null,
  primary key (owner_id, badge_id)
);
alter table public.user_badges enable row level security;

-- 본인 수집만 조회(종료화면 수집 카운트). 타인 뱃지 비노출 → self read.
drop policy if exists "user_badges: self read" on public.user_badges;
create policy "user_badges: self read"
  on public.user_badges for select using (auth.uid() = owner_id);

-- write 는 service-role(admin) 만 — 클라 직접 부여 차단(조작 방지).
revoke insert, update, delete on public.user_badges from anon, authenticated;
grant all on public.user_badges to service_role;

-- 백분위 — 전체 플레이(전 scores 행) 기준 "상위 N%". 최고점도 0% 안 되게 +1, ceil.
-- 일/주간 윈도우/유저최고점 아님(리포트·바이럴 직관성). get_leaderboard 랭킹과는 별개 지표.
create or replace function public.get_score_percentile(p_score int)
returns int
language sql
stable
security invoker
set search_path = public
as $$
  select case
    when count(*) = 0 then null
    -- +1 로 최고점도 0% 안 됨. 점수가 전체보다 낮은 경우 100 초과 방지(least).
    else least(ceil(100.0 * (count(*) filter (where score > p_score) + 1) / count(*))::int, 100)
  end
  from public.scores;
$$;
grant execute on function public.get_score_percentile(int)
  to anon, authenticated, service_role;
