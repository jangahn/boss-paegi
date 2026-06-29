-- 0047_credit_ledger.sql
-- 생성권(크레딧) 변동 원장. 지금은 운영자 조정만 admin_actions_ledger 에 남고, **생성 차감·생성 환불**은
-- 어디에도 기록 안 됨(member_accounts.gen_credits 만 +/-) → 회원 잔액 흐름 추적 불가. 이 표가 그 갭을 메움.
-- (충전=결제는 payapp_orders 에 보이지만, 통합 타임라인 위해 purchase 도 함께 기록.)
--
-- 기록 방식: **앱 레벨**(RPC 성공 후 best-effort insert) — money/hot-path RPC(consume/refund/grant) 무수정
-- 으로 리스크 최소화. balance/소스 오브 트루스는 member_accounts.gen_credits, 이 표는 **감사/분석 기록**.
-- additive·무중단. 코드 배포 전 적용 권장(미적용 시 로깅만 무음 스킵 — 본 작업엔 영향 없음).

create table if not exists public.credit_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  delta int not null,                       -- -1 생성차감 · +1 생성환불 · +N 충전
  event_type text not null check (event_type in ('gen_consume', 'gen_refund', 'purchase')),
  balance_after int,                        -- 변동 후 잔액(consume/refund 는 RPC 반환값, purchase 는 null 가능)
  ref_gen_id uuid,                          -- 생성건 연결(gen_consume/gen_refund)
  ref_order_uuid uuid,                      -- 주문 연결(purchase)
  note text,
  created_at timestamptz not null default now()
);

create index if not exists credit_ledger_user_created_idx
  on public.credit_ledger (user_id, created_at desc);

-- server-only — 클라(anon/authenticated) 직접 접근 금지, service_role(admin client) 만.
alter table public.credit_ledger enable row level security;
revoke all on public.credit_ledger from public, anon, authenticated;
grant all on public.credit_ledger to service_role;
