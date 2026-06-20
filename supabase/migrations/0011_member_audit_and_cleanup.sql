-- 0011: member_accounts 감사 컬럼 + 미사용 daily_gen_limit 제거
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN)
-- daily_gen_limit drop 안전성: /api/fal 이 이미 credit 기반(requireMember+consume_gen_credit, PR#2),
-- 코드 참조 0건 확인 후 drop.

-- 1. member_accounts 에 감사 컬럼 (다른 테이블처럼 — 0007 set_updated_at_and_version 재사용)
--    consume/refund_gen_credit 의 UPDATE 마다 version 자동 증가 = 크레딧 변경 감사.
alter table public.member_accounts add column if not exists updated_at timestamptz not null default now();
alter table public.member_accounts add column if not exists version int not null default 1;
update public.member_accounts set updated_at = created_at where updated_at <> created_at;
drop trigger if exists trg_member_accounts_audit on public.member_accounts;
create trigger trg_member_accounts_audit
  before update on public.member_accounts
  for each row execute function public.set_updated_at_and_version();

-- 2. 미사용 컬럼 제거 (일일 한도 → 생성권 크레딧 모델로 전환 완료)
alter table public.profiles drop column if exists daily_gen_limit;
