-- 0004: 랭킹 닉네임 공개 + AI 생성 일일 한도 + 플레이타임 1시간
-- 적용: Supabase Dashboard → SQL Editor 에 붙여넣기.

-- 1. 랭킹에서 타인 닉네임이 "익명" 으로 나오던 문제
--    원인: get_leaderboard 가 security invoker 라 RLS 적용 → profiles 는
--    "본인만 읽기" 정책뿐이어서 타인 display_name 이 전부 null.
--    해결: 닉네임은 랭킹/공유에 쓰이는 공개 정보 (id/display_name/created_at
--    뿐, 민감정보 없음) — public read 정책 추가.
create policy "profiles: public read"
  on public.profiles for select using (true);

-- 2. AI 생성 일일 한도 — 계정별 관리 가능
--    기본 2회/일 (KST 자정 리셋). null = 무제한 (운영/테스트 계정용).
--    예) 무제한 계정 만들기:
--      update public.profiles set daily_gen_limit = null where id = '<uuid>';
alter table public.profiles
  add column if not exists daily_gen_limit int default 2
  check (daily_gen_limit is null or daily_gen_limit >= 0);

-- 3. 플레이타임 제한 10분 → 1시간
--    (점수 상한 = 시간 × 2000점/sec 이므로 완전 무제한 대신 1시간으로 상향)
alter table public.scores drop constraint if exists scores_duration_ms_check;
alter table public.scores
  add constraint scores_duration_ms_check
  check (duration_ms > 0 and duration_ms <= 3600000);
