-- 0019: payapp_orders — 페이앱(무사업자) 결제 주문 원장 + 멱등 크레딧 지급 RPC
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN)
-- 무사업자 페이앱으로 "캐릭터 생성권" 충전. order_uuid 가 우리 주문 id(=var2, PK),
-- mul_no 는 payrequest 응답 후 update(nullable unique). 웹훅이 insert 보다 먼저 와도 order_uuid 로 조회.
-- 지급은 항상 DB order.user_id 기준(웹훅 var1 은 검증용). 지급은 RPC 가 원자·멱등.

-- ── 0. 감사 트리거 함수 보장(0007 정의 — 순서 무관하게 self-contained) ──
create or replace function public.set_updated_at_and_version()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  new.version := coalesce(old.version, 0) + 1;
  return new;
end;
$$;

-- ── 1. 주문 원장 ─────────────────────────────────────────────────────
create table if not exists public.payapp_orders (
  order_uuid uuid primary key,                 -- 우리 주문 id (= 페이앱 var2)
  mul_no text unique,                          -- 페이앱 결제요청번호 (payrequest 응답 후 채움)
  payurl text,                                 -- 최근 pending 재사용용
  user_id uuid not null references public.profiles(id) on delete cascade,
  product_id text not null,                    -- credit-products allowlist id
  amount int not null check (amount > 0),      -- 결제금액(원) snapshot
  credits int not null check (credits > 0),    -- 지급 생성권 snapshot
  status text not null default 'pending'
    check (status in ('pending', 'paid', 'canceled', 'failed')),
  pay_state int,                               -- 마지막 페이앱 pay_state
  raw jsonb,                                   -- 마지막 웹훅 payload (감사)
  error_message text,                          -- payrequest 실패 사유
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  version int not null default 1,
  paid_at timestamptz
);
alter table public.payapp_orders enable row level security;

-- 클라 직접 접근 전면 금지 — service_role / SECURITY DEFINER RPC 만(UI 는 서버 라우트 경유).
revoke all on public.payapp_orders from anon, authenticated;
grant all on public.payapp_orders to service_role;

-- 감사 컬럼 자동 갱신(0007 set_updated_at_and_version 재사용) — UPDATE 마다 updated_at/version.
drop trigger if exists trg_payapp_orders_audit on public.payapp_orders;
create trigger trg_payapp_orders_audit
  before update on public.payapp_orders
  for each row execute function public.set_updated_at_and_version();

-- 최근 pending 재사용(같은 user+product) + 운영 대사용 인덱스.
create index if not exists idx_payapp_orders_user_product_status
  on public.payapp_orders (user_id, product_id, status, created_at desc);

-- ── 2. 결제완료 통보 처리 RPC — 원자·멱등 ────────────────────────────
-- order_uuid 로 조회 → 금액검증 → 최초 1회만 paid 전환 + 크레딧 지급(order.user_id).
-- 중복/동시 통보에도 1회만 지급(FOR UPDATE 잠금 + status 가드).
create or replace function public.mark_paid_and_grant(
  p_order_uuid uuid,
  p_mul_no text,
  p_price int,
  p_raw jsonb
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.payapp_orders;
begin
  select * into o from public.payapp_orders
   where order_uuid = p_order_uuid
   for update;

  if not found then return false; end if;             -- 알 수 없는 주문
  if o.amount <> p_price then return false; end if;   -- 금액 불일치(위변조 의심)
  -- pending 만 paid 전환 — 이미 paid/canceled/failed 는 차단(멱등 + 취소·실패건 무단 지급 방지).
  if o.status <> 'pending' then return false; end if;

  update public.payapp_orders
     set status = 'paid',
         pay_state = 4,
         paid_at = now(),
         raw = p_raw,
         mul_no = coalesce(mul_no, p_mul_no)
   where order_uuid = p_order_uuid;

  -- 크레딧 지급 — member_accounts row 부재 시 생성(상실 방지, auth callback upsert 패턴).
  -- (UPDATE 0행 silent 성공 = 결제완료인데 크레딧 미지급 사고를 원천 차단.)
  insert into public.member_accounts (user_id, gen_credits)
  values (o.user_id, o.credits)
  on conflict (user_id) do update
    set gen_credits = member_accounts.gen_credits + excluded.gen_credits;

  return true;
end;
$$;

-- 클라 직접 호출 금지 — service_role(admin client) 만.
revoke all on function public.mark_paid_and_grant(uuid, text, int, jsonb) from public, anon, authenticated;
grant execute on function public.mark_paid_and_grant(uuid, text, int, jsonb) to service_role;
