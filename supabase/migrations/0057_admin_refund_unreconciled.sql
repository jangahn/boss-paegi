-- 0057: 대시보드 '페이앱 취소됨 · 크레딧 미회수' 경고 완전성 교정.
-- 기존(lib/admin-data.ts)은 후보(canceled+paid_at·refund_state null)를 canceled_at ASC
-- limit 20 으로 자른 **뒤에** cancel_refund ledger 기회수 건을 앱에서 걸렀다 — 후보가 20건을
-- 넘고 오래된 20건이 전부 기회수면 실제 미회수 건이 경고에서 통째로 누락(false negative).
-- 돈 경고 표면은 fail-safe(누락보다 과보고)여야 하므로 회수 여부를 SQL anti-join 으로 내려
-- "정확히 미회수인 것만" 오래된 순으로 반환한다.
create or replace function public.admin_unreconciled_canceled_orders(p_limit int default 20)
returns setof public.payapp_orders
language sql stable security definer set search_path = public as $$
  select o.*
  from public.payapp_orders o
  where o.status = 'canceled'
    and o.paid_at is not null
    and o.refund_state is null
    and not exists (
      select 1 from public.admin_actions_ledger l
      where l.order_uuid = o.order_uuid and l.action_type = 'cancel_refund'
    )
  -- 오래 방치된 것 우선. 웹훅 선도착 취소는 canceled_at 을 안 채우므로(feedback route 는
  -- status 만 update) updated_at(=취소 웹훅 수신 시각)으로 폴백 — canceled_at 단독이면 전부
  -- NULL 이라 정렬이 uuid tiebreak 로 붕괴한다.
  order by coalesce(o.canceled_at, o.updated_at) asc, o.order_uuid
  limit greatest(1, least(coalesce(p_limit, 20), 100));
$$;
revoke all on function public.admin_unreconciled_canceled_orders(int) from public, anon, authenticated;
grant execute on function public.admin_unreconciled_canceled_orders(int) to service_role;

notify pgrst, 'reload schema';
