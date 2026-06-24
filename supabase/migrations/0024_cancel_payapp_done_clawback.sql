-- 0024: admin_cancel_order 회수 조건 보강 — TOCTOU 머니 손실 차단(PR D 리뷰 HIGH 반영).
--
-- 문제: /api/admin/cancel(pending 취소)는 load 시점에 pending 확인 후 paycancel(실환불) → RPC 호출(p_clawback=false).
--   그 사이 웹훅이 pending→paid(크레딧 지급)로 바꾸면, RPC 는 FOR UPDATE 로 paid 를 읽지만 p_clawback=false 라
--   회수를 건너뛰어 "페이앱 환불됨 + 크레딧 유지" 불일치 발생.
-- 해결: 회수 조건을 (p_clawback OR p_payapp_done) 로 — **페이앱 환불이 실제로 일어났으면(payapp_done) paid/화해 건은
--   무조건 회수(clamp+shortfall)**. payapp_done 은 외부 환불 확정 신호이므로 크레딧 회수는 필수.
--   pending(status<>paid, v_recon=false)은 조건 false → 그대로 무회수. p_payapp_done=false 로컬 경로는 종전대로(엄격 차단).
--
-- 적용: management API query 엔드포인트. additive(create or replace). 4-arg wrapper·grant 변경 없음.

create or replace function public.admin_cancel_order(
  p_admin uuid, p_order_uuid uuid, p_clawback boolean, p_reason text, p_payapp_done boolean
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  o public.payapp_orders;
  v_before int; v_after int;
  v_claw int := 0; v_shortfall int := 0; v_recon boolean := false;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid'; end if;

  select * into o from public.payapp_orders where order_uuid = p_order_uuid for update;
  if not found then raise exception 'order_not_found'; end if;
  if o.status = 'failed' then raise exception 'not_cancelable'; end if;

  if o.status = 'canceled' then
    if p_payapp_done and not exists (
      select 1 from public.admin_actions_ledger
      where order_uuid = p_order_uuid and action_type = 'cancel_refund'
    ) then
      v_recon := true;
    else
      raise exception 'already_canceled';
    end if;
  end if;

  select gen_credits into v_before from public.member_accounts where user_id = o.user_id for update;
  if not found then raise exception 'member_not_found'; end if;

  -- 회수: 외부 환불 확정(p_payapp_done) 또는 명시 회수(p_clawback). payapp_done 이면 회수 필수(돈 이미 환불됨).
  if (o.status = 'paid' or v_recon) and (p_clawback or p_payapp_done) then
    if not p_payapp_done and v_before < o.credits then
      raise exception 'insufficient_credits';      -- 로컬 전용 경로: 엄격 차단.
    end if;
    v_claw := least(o.credits, v_before);           -- payapp_done: 가진 만큼만(이미 외부 환불).
    v_shortfall := greatest(0, o.credits - v_before);
    update public.member_accounts set gen_credits = gen_credits - v_claw
      where user_id = o.user_id returning gen_credits into v_after;
  else
    v_after := v_before;                             -- pending→cancel 또는 무회수: 크레딧 불변.
  end if;

  if v_recon then
    update public.payapp_orders
      set clawback_credits = v_claw, refund_state = 'done', updated_at = now()
      where order_uuid = p_order_uuid;
  else
    update public.payapp_orders
      set status = 'canceled', canceled_at = now(), clawback_credits = v_claw,
          refund_state = case when p_payapp_done then 'done' else refund_state end,
          updated_at = now()
      where order_uuid = p_order_uuid and status = o.status;
    if not found then raise exception 'order_status_changed'; end if;
  end if;

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata)
  values (p_admin, 'cancel_refund', o.user_id, p_order_uuid, -v_claw, o.amount,
          v_before, v_after, p_reason,
          jsonb_build_object('payapp_done', p_payapp_done, 'shortfall', v_shortfall, 'reconciled', v_recon));

  return jsonb_build_object('ok', true, 'clawback', v_claw, 'shortfall', v_shortfall,
                            'before', v_before, 'after', v_after);
end; $$;

revoke all on function public.admin_cancel_order(uuid, uuid, boolean, text, boolean) from public, anon, authenticated;
grant execute on function public.admin_cancel_order(uuid, uuid, boolean, text, boolean) to service_role;
