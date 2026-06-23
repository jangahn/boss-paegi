-- 0020: 관리자 모니터링 — is_admin 권한 + 퍼널 RPC + 운영액션(감사) RPC + 인덱스
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN)
-- 돈을 다루는 운영액션 RPC 는 모두 security definer + row lock(FOR UPDATE) + 감사 ledger 한 트랜잭션.

-- ── 1. is_admin 권한 (member_accounts, service_role 만 쓰기 → 자가부여 불가) ──
alter table public.member_accounts add column if not exists is_admin boolean not null default false;
-- 단독 관리자 seed (email 은 OAuth 콜백서 동기화됨; 1행 매칭 확인됨).
update public.member_accounts set is_admin = true where email = 'emfoa23@gmail.com';

-- ── 2. payapp_orders 운영 컬럼 (취소/회수 추적) ──
alter table public.payapp_orders add column if not exists canceled_at timestamptz;
alter table public.payapp_orders add column if not exists clawback_credits int not null default 0;

-- ── 3. 인덱스 (대시보드/대사 쿼리) ──
create index if not exists idx_payapp_orders_status_created on public.payapp_orders(status, created_at desc);
create index if not exists idx_payapp_orders_user_created on public.payapp_orders(user_id, created_at desc);
create index if not exists idx_payapp_orders_paid_at on public.payapp_orders(paid_at desc) where paid_at is not null;

-- ── 4. 운영 액션 감사 원장 (service_role 전용) ──
create table if not exists public.admin_actions_ledger (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references public.profiles(id),
  action_type text not null check (action_type in ('settle_stuck', 'cancel_refund', 'cs_adjust')),
  target_user_id uuid not null references public.profiles(id),
  order_uuid uuid null references public.payapp_orders(order_uuid),
  credit_delta int not null,                 -- 크레딧 변화량(+지급 / -회수)
  order_amount int null,                      -- 결제금액(원) — 주문 관련 액션만
  before_credits int not null,
  after_credits int not null,
  reason text not null check (char_length(reason) between 5 and 500),
  metadata jsonb,
  created_at timestamptz not null default now()
);
alter table public.admin_actions_ledger enable row level security;
revoke all on public.admin_actions_ledger from anon, authenticated;
grant all on public.admin_actions_ledger to service_role;
create index if not exists idx_admin_ledger_created on public.admin_actions_ledger(created_at desc);
create index if not exists idx_admin_ledger_order on public.admin_actions_ledger(order_uuid);

-- ── 5. 퍼널 집계 RPC (auth.users 접근 위해 security definer) ──
create or replace function public.get_admin_funnel()
returns table (
  anon_users bigint,
  players bigint,
  members bigint,
  first_gen bigint,
  first_purchase bigint
)
language sql
stable
security definer
set search_path = public
as $$
  select
    (select count(*) from auth.users where is_anonymous)::bigint,
    (select count(distinct owner_id) from public.scores)::bigint,
    (select count(*) from public.member_accounts)::bigint,
    (select count(distinct owner_id) from public.dolls)::bigint,
    (select count(distinct user_id) from public.payapp_orders where status = 'paid')::bigint;
$$;
revoke all on function public.get_admin_funnel() from public, anon, authenticated;
grant execute on function public.get_admin_funnel() to service_role;

-- 5.1 매출·주문 요약 (today = KST 자정 이후, 7d/30d = now 기준 rolling). get_leaderboard KST 패턴.
create or replace function public.get_admin_order_summary()
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with k as (
    select (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') as today_start
  )
  select jsonb_build_object(
    'revenue_today', coalesce((select sum(amount) from public.payapp_orders, k where status = 'paid' and paid_at >= k.today_start), 0),
    'revenue_7d',    coalesce((select sum(amount) from public.payapp_orders where status = 'paid' and paid_at >= now() - interval '7 days'), 0),
    'revenue_30d',   coalesce((select sum(amount) from public.payapp_orders where status = 'paid' and paid_at >= now() - interval '30 days'), 0),
    'orders_today',  (select count(*) from public.payapp_orders, k where created_at >= k.today_start),
    'orders_7d',     (select count(*) from public.payapp_orders where created_at >= now() - interval '7 days'),
    'orders_30d',    (select count(*) from public.payapp_orders where created_at >= now() - interval '30 days'),
    'by_status',     coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from public.payapp_orders group by status) s), '{}'::jsonb)
  );
$$;
revoke all on function public.get_admin_order_summary() from public, anon, authenticated;
grant execute on function public.get_admin_order_summary() to service_role;

-- ── 6. 운영 액션 RPC ── (모두 service_role 전용; p_admin 은 호출 라우트가 is_admin 검증 후 전달)

-- 6.1 stuck 주문 수동 지급 — pending + mul_no 있는 주문만(페이앱 관리자 결제완료 확인 후).
create or replace function public.admin_settle_stuck_order(
  p_admin uuid, p_order_uuid uuid, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.payapp_orders;
  v_before int;
  v_after int;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then
    raise exception 'reason_invalid';
  end if;
  select * into o from public.payapp_orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status <> 'pending' or o.mul_no is null then raise exception 'not_settleable'; end if;

  select gen_credits into v_before from public.member_accounts where user_id = o.user_id for update;
  if not found then raise exception 'member_not_found'; end if;

  update public.member_accounts set gen_credits = gen_credits + o.credits
    where user_id = o.user_id returning gen_credits into v_after;
  update public.payapp_orders set status = 'paid', paid_at = now(), pay_state = 4
    where order_uuid = p_order_uuid;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount, before_credits, after_credits, reason)
  values (p_admin, 'settle_stuck', o.user_id, p_order_uuid, o.credits, o.amount, v_before, v_after, p_reason);

  return jsonb_build_object('ok', true, 'before', v_before, 'after', v_after, 'credits', o.credits);
end;
$$;

-- 6.2 주문 환불/취소 표시 — 멱등(이미 canceled 면 error), 상태별 회수량, 회수는 0까지만.
create or replace function public.admin_cancel_order(
  p_admin uuid, p_order_uuid uuid, p_clawback boolean, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  o public.payapp_orders;
  v_before int;
  v_after int;
  v_claw int := 0;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then
    raise exception 'reason_invalid';
  end if;
  select * into o from public.payapp_orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status = 'canceled' then raise exception 'already_canceled'; end if;
  if o.status = 'failed' then raise exception 'not_cancelable'; end if;

  if o.status = 'paid' and p_clawback then
    select gen_credits into v_before from public.member_accounts where user_id = o.user_id for update;
    v_claw := least(o.credits, coalesce(v_before, 0)); -- 0 까지만 회수
    update public.member_accounts set gen_credits = gen_credits - v_claw
      where user_id = o.user_id returning gen_credits into v_after;
  else
    -- pending→canceled (지급분 없음) 또는 paid+clawback=false : 크레딧 변화 없음.
    select gen_credits into v_before from public.member_accounts where user_id = o.user_id;
    v_after := v_before;
  end if;

  update public.payapp_orders
    set status = 'canceled', canceled_at = now(), clawback_credits = v_claw
    where order_uuid = p_order_uuid;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount, before_credits, after_credits, reason)
  values (p_admin, 'cancel_refund', o.user_id, p_order_uuid, -v_claw, o.amount, coalesce(v_before, 0), coalesce(v_after, 0), p_reason);

  return jsonb_build_object('ok', true, 'clawback', v_claw, 'before', v_before, 'after', v_after);
end;
$$;

-- 6.3 CS 임의 크레딧 조정 — 기존 회원만(upsert 금지), 범위/≠0/사유, 음수는 0 클램프.
create or replace function public.admin_adjust_credits(
  p_admin uuid, p_target uuid, p_delta int, p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_before int;
  v_after int;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid'; end if;
  if p_delta < -100 or p_delta > 100 or p_delta = 0 then raise exception 'delta_invalid'; end if;

  select gen_credits into v_before from public.member_accounts where user_id = p_target for update;
  if not found then raise exception 'member_not_found'; end if; -- upsert 금지

  update public.member_accounts set gen_credits = greatest(0, gen_credits + p_delta)
    where user_id = p_target returning gen_credits into v_after;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount, before_credits, after_credits, reason)
  values (p_admin, 'cs_adjust', p_target, null, v_after - v_before, null, v_before, v_after, p_reason);

  return jsonb_build_object('ok', true, 'before', v_before, 'after', v_after, 'applied', v_after - v_before);
end;
$$;

revoke all on function public.admin_settle_stuck_order(uuid, uuid, text) from public, anon, authenticated;
revoke all on function public.admin_cancel_order(uuid, uuid, boolean, text) from public, anon, authenticated;
revoke all on function public.admin_adjust_credits(uuid, uuid, int, text) from public, anon, authenticated;
grant execute on function public.admin_settle_stuck_order(uuid, uuid, text) to service_role;
grant execute on function public.admin_cancel_order(uuid, uuid, boolean, text) to service_role;
grant execute on function public.admin_adjust_credits(uuid, uuid, int, text) to service_role;
