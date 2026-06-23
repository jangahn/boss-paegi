-- 0023: 머니 패스 — admin_cancel_order 회수부족 정책 변경(clamp-0 → 조건부 block) + 5-arg(p_payapp_done).
-- refund_state 컬럼은 0022 에 이미 존재(읽기용). 여기서 쓰기/전환 로직 도입.
--
-- 적용: management API query 엔드포인트. additive — 5-arg 신규 + 4-arg 는 wrapper 로 유지(drop 없음 → 무중단).
--
-- 정책:
--  - 정상 환불(route)은 페이앱 paycancel 성공 후 5-arg 를 p_payapp_done=true 로 호출 → 회수는 가진 만큼만(clamp)
--    + 부족분(shortfall) metadata 기록(이미 외부 환불됐으니 로컬 일관성 우선).
--  - 로컬 전용 경로(p_payapp_done=false; 4-arg wrapper)는 회수부족 시 'insufficient_credits' 로 엄격 차단.
--  - 화해(reconcile): 페이앱 취소 웹훅이 먼저 도착해 status='canceled' 인데 cancel_refund ledger 가 없고
--    p_payapp_done=true 면 → clawback + ledger 를 마저 기록(부분유니크가 중복 회수 차단).

-- ── 5-arg: 회수부족 조건부 block + clamp+shortfall + 화해 + refund_state='done' ──
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

  -- 화해: 이미 canceled + cancel_refund ledger 없음 + payapp_done → 회수 마저(웹훅 선도착).
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

  if (o.status = 'paid' or v_recon) and p_clawback then
    if not p_payapp_done and v_before < o.credits then
      raise exception 'insufficient_credits';      -- 로컬 전용 경로: 엄격 차단(페이앱 호출 전 route 가 1차 차단).
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
      where order_uuid = p_order_uuid and status = o.status;  -- 락 후 상태 재확인(방어).
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

-- ── 4-arg wrapper 유지(drop 금지 → 무중단): 기존 호출부(/cancel pending)는 p_payapp_done=false 로 위임. ──
create or replace function public.admin_cancel_order(
  p_admin uuid, p_order_uuid uuid, p_clawback boolean, p_reason text
)
returns jsonb language sql security definer set search_path = public as $$
  select public.admin_cancel_order(p_admin, p_order_uuid, p_clawback, p_reason, false);
$$;

-- ── EXECUTE 권한: service_role 만(0020 패턴). ──
revoke all on function public.admin_cancel_order(uuid, uuid, boolean, text, boolean) from public, anon, authenticated;
revoke all on function public.admin_cancel_order(uuid, uuid, boolean, text) from public, anon, authenticated;
grant execute on function public.admin_cancel_order(uuid, uuid, boolean, text, boolean) to service_role;
grant execute on function public.admin_cancel_order(uuid, uuid, boolean, text) to service_role;
