-- 0015: score_stats — 플레이 해석 리포트용 게임 상세 스탯 (1:1, ADDITIVE)
--
-- 적용: management API query 엔드포인트.
-- score_highlights 와 분리(별도 테이블) — highlight 의 attach-once(PK insert 23505) 불변식을
-- 건드리지 않기 위함. 점수 제출 시 항상 1행 생성(best-effort), 공유/OG 가 조인해 읽음.
-- persona_id 는 제출 시점 채움, badge_ids/percentile 은 후속 PR(뱃지/백분위)에서 채움.

create table if not exists public.score_stats (
  score_id uuid primary key references public.scores(id) on delete cascade,
  gameplay_stats jsonb not null,
  persona_id text,
  badge_ids text[],          -- 이번 판 리포트/공유 스냅샷 (후속 PR)
  percentile numeric,        -- 플레이 당시 상위 N% 스냅샷 (후속 PR)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1
);
alter table public.score_stats enable row level security;

-- public read (=scores/score_highlights 와 동일, 비민감 공개 스탯 — 공유페이지 비로그인 렌더).
drop policy if exists "score_stats: public read" on public.score_stats;
create policy "score_stats: public read"
  on public.score_stats for select using (true);

-- write 는 service-role(admin) 만 — 클라 직접 변조 차단(점수 조작 방지 정책).
revoke insert, update, delete on public.score_stats from anon, authenticated;
grant all on public.score_stats to service_role;

-- 감사 트리거 (0007 set_updated_at_and_version 재사용)
drop trigger if exists trg_score_stats_audit on public.score_stats;
create trigger trg_score_stats_audit
  before update on public.score_stats
  for each row execute function public.set_updated_at_and_version();
