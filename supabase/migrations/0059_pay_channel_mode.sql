-- 0059: 주문 결제경로 식별 정상화 — 테스트/실 채널 구분(is_test) + 결제수단 채널(pay_channel).
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN)
-- 배경: 포트원 전환(0058) 후 테스트/실연동 채널이 **동시 운영**되는데(심사·테스트 계정=테스트 채널,
--   일반 유저=실채널 — lib/pay-channels.ts PayMode) 주문에 어느 채널·모드로 결제됐는지 기록이 없어
--   (a) 어드민에서 테스트 결제와 실매출이 구분 불가, (b) 테스트 채널 결제가 실주문에 지급되는
--   경로를 대사할 수 없었다. 체크아웃(서버 판정)이 기록하고, 지급 3경로(웹훅/폴링/reconcile)가
--   포트원 단건조회 channel.type 과 대사한다(코드: paymentModeMismatch).
--
-- 변경 요약:
--   1) orders.is_test(boolean not null default false) + orders.pay_channel(text, check) 추가.
--   2) 백필 — 기존 provider='portone' 행(≈5건)은 전부 is_test=true:
--      계약(KPN·토스페이·카카오페이) 완료 전이라 실연동 채널이 존재하지 않던 시기의 결제 시도이며
--      (7/21 관리자 결제 성공 3건 = 테스트 채널에서만 가능), 심사 대응으로 전역 오픈한 기간의
--      유저 시도(pending/failed)도 같은 테스트 채널키로 호출됐다. pay_channel 은 소급 불명 → null 유지.
--      레거시 payapp 행은 실결제(실돈 이동)였으므로 is_test=false 유지.
--   3) get_admin_order_summary / get_admin_funnel — 매출·주문 KPI 에서 is_test 제외.
--   4) search_orders — 반환 컬럼에 is_test·pay_channel 추가(반환형 변경이라 drop 후 재생성,
--      호출부 lib/admin-orders.ts 동시 배포).
--   * admin_unreconciled_canceled_orders 는 setof public.orders 라 컬럼 추가가 자동 반영(재정의 불요).
--     테스트 주문도 크레딧 정합(회수)은 지켜야 하므로 환불 경고에서는 제외하지 않는다.

begin;

-- ── 1. 컬럼 추가 ──────────────────────────────────────────────────────
alter table public.orders add column if not exists is_test boolean not null default false;
alter table public.orders add column if not exists pay_channel text;
alter table public.orders add constraint orders_pay_channel_check
  check (pay_channel is null or pay_channel in ('card', 'tosspay', 'kakaopay'));

-- ── 2. 백필 — 기존 포트원 행은 전부 테스트 채널 시기(계약 전) ─────────
update public.orders set is_test = true where provider = 'portone';

-- ── 3. KPI 집계에서 테스트 주문 제외 ──────────────────────────────────
create or replace function public.get_admin_order_summary()
returns jsonb language sql stable security definer set search_path = public as $$
  with k as (
    select (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') as today_start
  )
  select jsonb_build_object(
    'revenue_today', coalesce((select sum(amount) from public.orders, k where status='paid' and not is_test and paid_at >= k.today_start), 0),
    'revenue_7d',    coalesce((select sum(amount) from public.orders, k where status='paid' and not is_test and paid_at >= k.today_start - interval '6 days'), 0),
    'revenue_30d',   coalesce((select sum(amount) from public.orders, k where status='paid' and not is_test and paid_at >= k.today_start - interval '29 days'), 0),
    'orders_today',  (select count(*) from public.orders, k where not is_test and created_at >= k.today_start),
    'orders_7d',     (select count(*) from public.orders, k where not is_test and created_at >= k.today_start - interval '6 days'),
    'orders_30d',    (select count(*) from public.orders, k where not is_test and created_at >= k.today_start - interval '29 days'),
    'by_status',     coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from public.orders where not is_test group by status) s), '{}'::jsonb)
  );
$$;
revoke all on function public.get_admin_order_summary() from public, anon, authenticated;
grant execute on function public.get_admin_order_summary() to service_role;

create or replace function public.get_admin_funnel()
returns table (
  anon_users bigint, players bigint, members bigint, first_gen bigint, first_purchase bigint
) language sql stable security definer set search_path = public as $$
  select
    (select count(*) from auth.users where is_anonymous)::bigint,
    (select count(distinct owner_id) from public.scores)::bigint,
    (select count(*) from public.member_accounts)::bigint,
    (select count(distinct owner_id) from public.dolls)::bigint,
    (select count(distinct user_id) from public.orders where status = 'paid' and not is_test)::bigint;
$$;
revoke all on function public.get_admin_funnel() from public, anon, authenticated;
grant execute on function public.get_admin_funnel() to service_role;

-- ── 4. search_orders — is_test·pay_channel 반환(표시용. 반환형 변경 = drop 후 재생성) ──
drop function if exists public.search_orders(text, text, int, int);
create function public.search_orders(
  p_q text default null, p_status text default null,
  p_limit int default 10, p_offset int default 0
) returns table (
  order_uuid uuid, status text, amount int, credits int, product_id text,
  pg_tx_id text, payment_id text, provider text, is_test boolean, pay_channel text,
  created_at timestamptz, paid_at timestamptz,
  user_id uuid, display_name text, refund_state text, total_count bigint
) language sql stable security invoker set search_path = public as $$
  with filtered as (
    select o.order_uuid, o.status, o.amount, o.credits, o.product_id,
           o.pg_tx_id, o.payment_id, o.provider, o.is_test, o.pay_channel,
           o.created_at, o.paid_at, o.user_id,
           p.display_name, o.refund_state
    from public.orders o
    left join public.profiles p on p.id = o.user_id
    where (p_status is null or p_status = '' or o.status = p_status)
      and (
        p_q is null or p_q = ''
        or o.order_uuid::text ilike public.like_escape(p_q) || '%'
        or o.pg_tx_id ilike public.like_escape(p_q) || '%'
        or o.payment_id ilike public.like_escape(p_q) || '%'
      )
  )
  select f.order_uuid, f.status, f.amount, f.credits, f.product_id,
         f.pg_tx_id, f.payment_id, f.provider, f.is_test, f.pay_channel,
         f.created_at, f.paid_at, f.user_id,
         f.display_name, f.refund_state,
         count(*) over() as total_count
  from filtered f
  order by f.created_at desc
  limit greatest(1, least(coalesce(p_limit, 10), 100))
  offset greatest(0, coalesce(p_offset, 0));
$$;
revoke all on function public.search_orders(text, text, int, int) from public, anon, authenticated;
grant execute on function public.search_orders(text, text, int, int) to service_role;

commit;

notify pgrst, 'reload schema';
