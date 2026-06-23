-- 0021: 어드민 운영 RPC 하드닝 (전수 코드리뷰 반영) — 모두 additive(create or replace + index if not exists)
--
-- 적용: management API query 엔드포인트 (POST .../database/query, Bearer SUPABASE_ACCESS_TOKEN)
-- 수정: cancel 비-clawback 경로 락/멤버검증 통일(H-1), settle/cancel UPDATE 상태가드(H-2/3),
--       매출 7d/30d KST 일 기준 통일(H-5), adjust 클램프 요청값 metadata 보존(H-6),
--       ledger 주문액션 부분 유니크(C-1 방어).

-- ── settle: 주문 UPDATE 상태가드(락 후 재확인) ──
create or replace function public.admin_settle_stuck_order(
  p_admin uuid, p_order_uuid uuid, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.payapp_orders; v_before int; v_after int;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid'; end if;
  select * into o from public.payapp_orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status <> 'pending' or o.mul_no is null then raise exception 'not_settleable'; end if;

  select gen_credits into v_before from public.member_accounts where user_id = o.user_id for update;
  if not found then raise exception 'member_not_found'; end if;

  update public.member_accounts set gen_credits = gen_credits + o.credits
    where user_id = o.user_id returning gen_credits into v_after;
  update public.payapp_orders set status = 'paid', paid_at = now(), pay_state = 4
    where order_uuid = p_order_uuid and status = 'pending';
  if not found then raise exception 'status_changed'; end if;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount, before_credits, after_credits, reason)
  values (p_admin, 'settle_stuck', o.user_id, p_order_uuid, o.credits, o.amount, v_before, v_after, p_reason);
  return jsonb_build_object('ok', true, 'before', v_before, 'after', v_after, 'credits', o.credits);
end; $$;

-- ── cancel: 양 경로 member 락+존재검증 통일(H-1), UPDATE 상태가드(H-2), coalesce 제거 ──
create or replace function public.admin_cancel_order(
  p_admin uuid, p_order_uuid uuid, p_clawback boolean, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare o public.payapp_orders; v_before int; v_after int; v_claw int := 0;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid'; end if;
  select * into o from public.payapp_orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status = 'canceled' then raise exception 'already_canceled'; end if;
  if o.status = 'failed' then raise exception 'not_cancelable'; end if;

  -- member 잠금 + 존재 검증 (settle/adjust 와 일관 — 비-clawback 경로도 동일).
  select gen_credits into v_before from public.member_accounts where user_id = o.user_id for update;
  if not found then raise exception 'member_not_found'; end if;

  if o.status = 'paid' and p_clawback then
    v_claw := least(o.credits, v_before);            -- 0 까지만 회수
    update public.member_accounts set gen_credits = gen_credits - v_claw
      where user_id = o.user_id returning gen_credits into v_after;
  else
    v_after := v_before;                              -- pending→canceled 또는 paid 무회수: 크레딧 불변
  end if;

  update public.payapp_orders
    set status = 'canceled', canceled_at = now(), clawback_credits = v_claw
    where order_uuid = p_order_uuid and status = o.status;  -- 락 후 상태 재확인(방어)
  if not found then raise exception 'order_status_changed'; end if;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount, before_credits, after_credits, reason)
  values (p_admin, 'cancel_refund', o.user_id, p_order_uuid, -v_claw, o.amount, v_before, v_after, p_reason);
  return jsonb_build_object('ok', true, 'clawback', v_claw, 'before', v_before, 'after', v_after);
end; $$;

-- ── adjust: 클램프 시 요청값/클램프여부 metadata 보존(H-6) ──
create or replace function public.admin_adjust_credits(
  p_admin uuid, p_target uuid, p_delta int, p_reason text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_before int; v_after int;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid'; end if;
  if p_delta < -100 or p_delta > 100 or p_delta = 0 then raise exception 'delta_invalid'; end if;

  select gen_credits into v_before from public.member_accounts where user_id = p_target for update;
  if not found then raise exception 'member_not_found'; end if;

  update public.member_accounts set gen_credits = greatest(0, gen_credits + p_delta)
    where user_id = p_target returning gen_credits into v_after;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount, before_credits, after_credits, reason, metadata)
  values (p_admin, 'cs_adjust', p_target, null, v_after - v_before, null, v_before, v_after, p_reason,
          jsonb_build_object('requested_delta', p_delta, 'clamped', (v_after <> v_before + p_delta)));
  return jsonb_build_object('ok', true, 'before', v_before, 'after', v_after,
                            'applied', v_after - v_before, 'requested', p_delta);
end; $$;

-- ── 매출 요약: 7d/30d 도 KST 자정 기준으로 통일(today ⊆ 7d ⊆ 30d 보장, H-5) ──
create or replace function public.get_admin_order_summary()
returns jsonb language sql stable security definer set search_path = public as $$
  with k as (
    select (date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul') as today_start
  )
  select jsonb_build_object(
    'revenue_today', coalesce((select sum(amount) from public.payapp_orders, k where status='paid' and paid_at >= k.today_start), 0),
    'revenue_7d',    coalesce((select sum(amount) from public.payapp_orders, k where status='paid' and paid_at >= k.today_start - interval '6 days'), 0),
    'revenue_30d',   coalesce((select sum(amount) from public.payapp_orders, k where status='paid' and paid_at >= k.today_start - interval '29 days'), 0),
    'orders_today',  (select count(*) from public.payapp_orders, k where created_at >= k.today_start),
    'orders_7d',     (select count(*) from public.payapp_orders, k where created_at >= k.today_start - interval '6 days'),
    'orders_30d',    (select count(*) from public.payapp_orders, k where created_at >= k.today_start - interval '29 days'),
    'by_status',     coalesce((select jsonb_object_agg(status, c) from (select status, count(*) c from public.payapp_orders group by status) s), '{}'::jsonb)
  );
$$;

-- ── ledger 주문액션 부분 유니크(C-1 방어): 주문당 settle/cancel 각 1회만 ──
create unique index if not exists uq_admin_ledger_order_action
  on public.admin_actions_ledger(order_uuid, action_type)
  where order_uuid is not null and action_type in ('settle_stuck', 'cancel_refund');
