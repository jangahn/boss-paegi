-- ─────────────────────────────────────────────────────────────────────────────
-- 0068: 어드민 '크레딧 조정/환불 이력'의 partial_refund 증감/잔액 정합
--
-- 문제: 부분환불 시 크레딧 −N 회수는 admin_refund_begin(예약) 시점에 발생(live 로트면
--   gen_credits −= qty, credit_ledger 'refund_reserve' 기록). 그러나 admin_actions_ledger 의
--   partial_refund 는 bp_apply_attempt_commit(커밋) 시점에 기록되고, 커밋은 lot rr→refunded
--   이동만(캐시 무변)이라 credit_delta = v_after − v_before = 0 → 어드민 이력 테이블이 부분환불
--   증감 0·잔액 X→X 로 표시(구 admin_cancel_order 의 환불/취소 −N 과 불일치).
--
-- 수정: begin 이 '캐시에서 예약된 양'(live 면 qty, expired 면 0)을 attempt.cache_reserved_qty 에
--   기록하고, commit 의 admin_actions_ledger insert 가 before_credits = v_before + cache_reserved_qty,
--   credit_delta = v_after − (v_before + cache_reserved_qty) 로 실제 회수 −N 을 반영한다.
--   (auto=admin_refund_commit·manual=admin_refund_commit_manual 둘 다 bp_apply_attempt_commit 위임 → 일괄.)
--
-- 불변: 실제 gen_credits·로트·G-1·orders 회계는 전혀 변경 없음(감사 원장의 표시값만 정합화).
--   guard(admin_ledger_insert_guard)는 credit_delta = after_credits − before_credits 내부정합만
--   검사하므로 재구성한 before(=v_before+cache_reserved_qty)는 통과. 케이스별 정합:
--     · 일반 부분환불(live,qty): cache_reserved_qty=qty, v_after=v_before → delta=−qty, X→X−qty
--     · 만료 로트 환불: cache_reserved_qty=0 → delta=0(만료분은 잔액 밖, 정상)
--     · policy-close 전액현금: delta=−(qty + v_cache_effect)
--     · saga 중 로트 만료(begin live→commit expired): cache_reserved_qty=qty(begin 결정 보존) → delta=−qty
--   기존(0068 이전) 커밋된 attempt 는 cache_reserved_qty=0(default)·이미 기록된 이력행은 append-only 로
--   불변 → 소급 보정 없음(신규 환불부터 정합). 데이터 무변경(컬럼 additive + 함수 본문).
-- ─────────────────────────────────────────────────────────────────────────────

alter table public.order_refund_attempts
  add column if not exists cache_reserved_qty int not null default 0;

-- ── begin: cache_reserved_qty 기록(live 면 qty, expired 면 0) ──────────────────
CREATE OR REPLACE FUNCTION public.admin_refund_begin(p_request_id uuid, p_admin uuid, p_user uuid, p_order_uuid uuid, p_qty integer, p_reason text, p_customer_requested_at timestamp with time zone, p_rail text DEFAULT 'portone_cancel'::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  o public.orders;
  lot public.credit_lots;
  v_avail int;
  v_rate int;
  v_amount bigint;
  v_remaining_cash bigint;
  v_attempt uuid := gen_random_uuid();
  v_payload_hash text;
  v_plan_hash text;
  v_approved_hash text;
  r_existing public.refund_requests;
  v_live boolean;
begin
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  if p_qty <= 0 then raise exception 'qty_invalid' using errcode = 'P0001'; end if;
  if p_rail not in ('portone_cancel', 'manual_transfer') then raise exception 'rail_invalid' using errcode = 'P0001'; end if;
  if p_customer_requested_at > clock_timestamp() + interval '5 minutes' then raise exception 'cra_future' using errcode = 'P0001'; end if;

  v_payload_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'op', 'admin_refund_begin', 'order_uuid', p_order_uuid::text, 'user_id', p_user::text,
    'qty', p_qty, 'reason', p_reason, 'customer_requested_at', p_customer_requested_at,
    'rail', p_rail), 1);

  -- 멱등(§9): 동일 request_id 재호출 → payload 동일이면 no_op, 상이면 request_conflict.
  select * into r_existing from public.refund_requests where id = p_request_id;
  if r_existing.id is not null then
    if r_existing.payload_hash <> v_payload_hash then
      raise exception 'request_conflict' using errcode = 'P0001';
    end if;
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true,
      'request_id', p_request_id);
  end if;

  select * into o from public.orders where order_uuid = p_order_uuid and user_id = p_user for update;
  if not found then raise exception 'order_not_found' using errcode = 'P0001'; end if;
  if o.paid_at is null then raise exception 'order_not_paid' using errcode = 'P0001'; end if;

  perform 1 from public.member_accounts where user_id = p_user for update;
  select * into lot from public.credit_lots
   where order_uuid = p_order_uuid and source = 'purchase' for update;
  if not found then raise exception 'purchase_lot_not_found' using errcode = 'P0001'; end if;

  v_live := (lot.expired_at is null);
  v_avail := lot.qty - lot.consumed - lot.refunded - lot.refund_reserved;
  if p_qty > v_avail then raise exception 'qty_exceeds_available' using errcode = 'P0001'; end if;
  if p_qty > (o.credits - o.refunded_credits) then raise exception 'qty_exceeds_order_remaining' using errcode = 'P0001'; end if;

  v_remaining_cash := o.amount - o.refunded_amount;
  if v_remaining_cash <= 0 then raise exception 'nothing_to_refund' using errcode = 'P0001'; end if;
  v_rate := public.bp_refund_rate_bps(p_customer_requested_at, o.paid_at);
  v_amount := public.bp_refund_amount(o.amount, o.credits, p_qty, v_rate, v_remaining_cash);
  if v_amount <= 0 then raise exception 'amount_nonpositive' using errcode = 'P0001'; end if;

  v_plan_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'order_uuid', p_order_uuid::text, 'lot_id', lot.id::text, 'qty', p_qty, 'amount', v_amount,
    'rate_bps', v_rate, 'paid_at_snapshot', o.paid_at,
    'order_amount_snapshot', o.amount, 'order_credits_snapshot', o.credits,
    'expected_refunded_credits_before', o.refunded_credits,
    'expected_refunded_amount_before', o.refunded_amount), 1);
  v_approved_hash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'requested_qty', p_qty, 'approved_amount', v_amount, 'plan_hash', v_plan_hash), 1);

  -- request(building)
  insert into public.refund_requests
    (id, user_id, admin_user_id, origin, scope_order_uuid, requested_qty,
     customer_requested_at, reason, payload_hash, payload_hash_version, state)
  values (p_request_id, p_user, p_admin, 'admin_manual', null, p_qty,
          p_customer_requested_at, p_reason, v_payload_hash, 1, 'building');

  -- attempt(prepared) — cache_reserved_qty: 캐시(gen_credits)에서 예약될 양(live 면 qty, expired 면 0).
  --   commit 의 admin 감사 원장이 실제 회수 −N 표시에 사용(§0068).
  begin
    insert into public.order_refund_attempts
      (id, request_id, sequence, order_uuid, user_id, credit_lot_id, admin_user_id, reason, qty, amount,
       rail, state, rate_bps, policy_as_of, refund_deadline, paid_at_snapshot,
       order_amount_snapshot, order_credits_snapshot, expected_refunded_credits_before,
       expected_refunded_amount_before, plan_hash, plan_hash_version, cache_reserved_qty)
    values (v_attempt, p_request_id, 1, p_order_uuid, p_user, lot.id, p_admin, p_reason, p_qty, v_amount,
            p_rail, 'prepared', v_rate, clock_timestamp(), o.paid_at + interval '5 years', o.paid_at,
            o.amount, o.credits, o.refunded_credits, o.refunded_amount, v_plan_hash, 1,
            case when v_live then p_qty else 0 end);
  exception when unique_violation then
    raise exception 'order_has_open_refund' using errcode = 'P0001';
  end;

  -- 로트 예약 + 캐시 차감(live) + refund_reserve 원장
  update public.credit_lots set refund_reserved = refund_reserved + p_qty where id = lot.id;
  if v_live then
    update public.member_accounts set gen_credits = gen_credits - p_qty where user_id = p_user;
    perform public.bp_credit_ledger_write(p_user, -p_qty, 'refund_reserve',
      v_attempt, null, null, null, null, null, null);
  else
    perform public.bp_credit_ledger_write(p_user, 0, 'refund_reserve',
      v_attempt, null, null, null, null, null, null);
  end if;

  -- request building→prepared
  update public.refund_requests
     set state = 'prepared', approved_plan_hash = v_approved_hash,
         approved_plan_hash_version = 1, approved_amount = v_amount
   where id = p_request_id;

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'prepared', 'request_id', p_request_id,
    'attempt_id', v_attempt, 'qty', p_qty, 'amount', v_amount, 'rate_bps', v_rate);
end;
$function$;

-- ── commit(core): admin 감사 원장에 실제 회수 −N 반영 ──────────────────────────
CREATE OR REPLACE FUNCTION public.bp_apply_attempt_commit(p_attempt_id uuid, p_admin uuid, p_reason text, p_action_metadata jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  a public.order_refund_attempts;
  o public.orders;
  lot public.credit_lots;
  v_before int; v_after int;
  v_new_refunded_credits int; v_new_refunded_amount bigint;
  v_closure int; v_avail int; v_recoverable int; v_new_shortfall int; v_existing_covered int;
  v_cache_effect int; v_existing_remaining int; v_lot_live boolean;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  select * into o from public.orders where order_uuid = a.order_uuid for update;
  select * into lot from public.credit_lots where id = a.credit_lot_id for update;
  select gen_credits into v_before from public.member_accounts where user_id = a.user_id for update;

  -- 1. lot rr→refunded(동량) + attempt committed.
  update public.credit_lots
     set refund_reserved = refund_reserved - a.qty, refunded = refunded + a.qty
   where id = lot.id;
  update public.order_refund_attempts set state = 'committed' where id = p_attempt_id;

  -- 2. orders 갱신.
  v_new_refunded_credits := o.refunded_credits + a.qty;
  v_new_refunded_amount := o.refunded_amount + a.amount;
  update public.orders
     set refunded_credits = v_new_refunded_credits, refunded_amount = v_new_refunded_amount,
         receipt_url = coalesce(o.receipt_url, a.cancellation_receipt_url)
   where order_uuid = o.order_uuid;

  -- 3. refund_commit(attempt) 원장 delta 0.
  perform public.bp_credit_ledger_write(a.user_id, 0, 'refund_commit',
    p_attempt_id, null, null, null, null, null, null);

  -- 4. policy-cap closure — 전액 현금 환불(refunded_amount = amount) 도달 시 잔여 credit 종결(§41·A.6.3).
  if v_new_refunded_amount = o.amount and v_new_refunded_credits < o.credits then
    select * into lot from public.credit_lots where id = a.credit_lot_id for update;
    v_lot_live := (lot.expired_at is null);
    v_closure := o.credits - v_new_refunded_credits;
    v_avail := lot.qty - lot.consumed - lot.refunded - lot.refund_reserved;
    v_recoverable := least(v_closure, v_avail);
    -- §41 3분해: closure = recoverable + existing_covered + new_shortfall (clamp 금지).
    --   existing_covered = 잔여 closure 중 이미 shortfall 로 추적 중인 소비분(신규 shortfall 불요·미저장 파생).
    select coalesce(sum(remaining_shortfall_qty), 0) into v_existing_remaining
      from public.credit_refund_shortfalls where lot_id = lot.id;
    v_existing_covered := least(v_closure - v_recoverable, v_existing_remaining);
    v_new_shortfall := v_closure - v_recoverable - v_existing_covered;
    v_cache_effect := case when v_lot_live then v_recoverable else 0 end;
    -- 불변식(§41): new_shortfall <= consumed − 기존 remaining(초과=데이터 모순 → RAISE·Sentry fatal)
    if v_new_shortfall > lot.consumed - v_existing_remaining then
      raise exception 'invariant_violation' using errcode = 'P0001';
    end if;

    if v_recoverable > 0 then
      update public.credit_lots set refunded = refunded + v_recoverable where id = lot.id;
    end if;
    update public.orders set refunded_credits = o.credits where order_uuid = o.order_uuid;
    if v_cache_effect > 0 then
      update public.member_accounts set gen_credits = gen_credits - v_cache_effect where user_id = a.user_id;
    end if;
    perform public.bp_credit_ledger_write(a.user_id, -v_cache_effect, 'refund_policy_close',
      p_attempt_id, null, null, null, null,
      pg_catalog.jsonb_build_object('closure_qty', v_closure, 'recovered_qty', v_recoverable,
        'shortfall_qty', v_new_shortfall, 'lot_was_live', v_lot_live,
        'cache_effect_qty', v_cache_effect, 'rate_bps', a.rate_bps, 'refunded_amount_total', 0),
      null);
    if v_new_shortfall > 0 then
      insert into public.credit_refund_shortfalls
        (source_type, source_attempt_id, source_cancellation_id, order_uuid, lot_id,
         mapped_qty, recovered_qty, initial_shortfall_qty, remaining_shortfall_qty, state)
      values ('policy_cap', p_attempt_id, null, o.order_uuid, lot.id,
              v_closure, 0, v_new_shortfall, v_new_shortfall, 'open');
    end if;
    -- 사후검증(D2 재확인)
    select coalesce(sum(remaining_shortfall_qty), 0) into v_existing_remaining
      from public.credit_refund_shortfalls where lot_id = lot.id;
    select consumed into v_avail from public.credit_lots where id = lot.id;
    if v_existing_remaining > v_avail then
      raise exception 'shortfall_exceeds_consumed' using errcode = 'P0001';
    end if;
  end if;

  -- 5. admin 감사 원장(partial_refund) — 실제 회수 −N 반영(§0068):
  --    begin 시점 캐시 예약분(a.cache_reserved_qty) + commit policy-close 캐시효과를 합산한 실 회수를
  --    before=v_before+cache_reserved_qty, delta=v_after−before 로 표기. (실제 gen_credits 는 불변.)
  select gen_credits into v_after from public.member_accounts where user_id = a.user_id;
  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata, ref_attempt_id, payload_hash, payload_hash_version)
  values (p_admin, 'partial_refund', a.user_id, a.order_uuid,
          v_after - (v_before + a.cache_reserved_qty), a.amount,
          v_before + a.cache_reserved_qty, v_after, p_reason, p_action_metadata, p_attempt_id,
          public.bp_versioned_hash(p_action_metadata || pg_catalog.jsonb_build_object('attempt_id', p_attempt_id::text), 1), 1);
end;
$function$;
