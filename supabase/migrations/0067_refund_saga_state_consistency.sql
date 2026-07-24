-- ─────────────────────────────────────────────────────────────────────────────
-- 0067: 환불 saga 상태정합 2건 수정 (로컬 QA 매트릭스 service_role 실측 발견)
--
-- B) admin_refund_switch_to_manual 에 refund_requests state 재유도가 누락돼 있었다. 다른 모든 종단
--    환불 RPC(admin_refund_commit·release·replan_pre/after_pg·commit_manual)는
--    `update refund_requests set state = derive_refund_request_state(request_id)` 로 파생 상태를 갱신하는데
--    이 함수만 빠져, prepared/pg_requested/pg_pending 출처에서 attempt 는 manual_pending(파생=blocked)로
--    가지만 request 는 prepared/processing 에 머문다. DEFERRED 트리거 enforce_request_state_derive(0066,
--    SECURITY DEFINER)가 커밋 시 refund_request_state_derive_mismatch(P0001)로 **전체 트랜잭션 abort**.
--    앱 UI(RefundQueueActions)가 switch 를 manual_review 출처에만 노출해 실경로는 가려졌으나(그 출처는
--    이미 request='blocked'라 우연히 정합), route 는 이 RPC 를 단독 트랜잭션으로 호출하므로 서버 계약상
--    잠복 결함. → 종단 직전 재유도 1줄 추가(다른 RPC 와 동일, derive 는 'blocked' 멱등 반환).
--
-- C) admin_refund_mark_pg_requested 의 manual_review 출처 재시도(manual_review->pg_requested)는
--    set-once 트리거(pg_preflight_at/pg_requested_at 재스탬프 금지)와 충돌해 구조적으로 도달불가였다
--    (첫 prepared->pg_requested 에서 이미 non-null → 재호출 시 refund_attempts_set_once_violation, fail-closed).
--    가드(state not in ('prepared','manual_review'))에서 manual_review 를 제거해 invalid_state 로 깔끔히
--    거부한다. PG 실패 후 복구는 replan_after_pg(신규 sequence attempt, 새 타임스탬프)로 일원화.
--    비고: transition 화이트리스트의 'manual_review->pg_requested' 항목은 이제 어떤 함수도 구동하지 않는
--    무해한 잔여(mark_pg_requested 가 유일한 pg_requested 세터였음). 향후 비-머니패스 정리 대상으로 남긴다.
--
-- 데이터 무변경(함수 본문만). 로컬 Supabase service_role 컨텍스트 repro 로 검증.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── B: switch_to_manual + request state 재유도 ──────────────────────────────────
CREATE OR REPLACE FUNCTION public.admin_refund_switch_to_manual(p_attempt_id uuid, p_admin uuid, p_reason text, p_observed_cancelled_amount bigint, p_observed_cancellation_ids jsonb, p_verification_source text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  a public.order_refund_attempts;
  v_evhash text; v_verified_by uuid;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  if a.state = 'manual_pending' then
    return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
  end if;
  if a.state not in ('prepared', 'pg_requested', 'pg_pending', 'manual_review') then
    raise exception 'invalid_state' using errcode = 'P0001';
  end if;
  if char_length(p_reason) < 5 or char_length(p_reason) > 500 then raise exception 'reason_invalid' using errcode = 'P0001'; end if;
  if p_verification_source not in ('pg_failed_response', 'admin_reconcile', 'resolver') then
    raise exception 'verification_source_invalid' using errcode = 'P0001';
  end if;

  v_verified_by := case when p_verification_source = 'pg_failed_response' then null else p_admin end;
  v_evhash := public.bp_versioned_hash(pg_catalog.jsonb_build_object(
    'attempt_id', p_attempt_id::text, 'observed_cancelled_amount', p_observed_cancelled_amount,
    'observed_cancellation_ids', p_observed_cancellation_ids, 'verification_source', p_verification_source), 1);

  update public.order_refund_attempts
     set rail = 'manual_transfer', state = 'manual_pending',
         reconciliation_verified_at = clock_timestamp(), reconciliation_result = 'no_movement',
         observed_cancelled_amount = p_observed_cancelled_amount,
         observed_cancellation_ids = coalesce(p_observed_cancellation_ids, '[]'::jsonb),
         verification_source = p_verification_source, verified_by = v_verified_by,
         evidence_hash = v_evhash, evidence_hash_version = 1,
         last_reconciled_at = clock_timestamp()
   where id = p_attempt_id;

  -- 검증된 FAILED event 는 같은 트랜잭션에서 system-ignore 종결(관측된 것이 있으면).
  update public.payment_cancellation_events
     set resolution_state = 'ignored', resolved_at = now(), resolution_source = 'system', resolved_by = null
   where order_uuid = a.order_uuid and status = 'FAILED' and resolution_state = 'unmatched';

  insert into public.admin_actions_ledger
    (admin_user_id, action_type, target_user_id, order_uuid, credit_delta, order_amount,
     before_credits, after_credits, reason, metadata, ref_attempt_id, payload_hash, payload_hash_version)
  select p_admin, 'refund_switch_manual', a.user_id, a.order_uuid, 0, a.amount,
         ma.gen_credits, ma.gen_credits, p_reason,
         pg_catalog.jsonb_build_object('from_state', a.state, 'from_rail', a.rail,
           'to_rail', 'manual_transfer', 'evidence_hash', v_evhash),
         p_attempt_id,
         public.bp_versioned_hash(pg_catalog.jsonb_build_object('attempt_id', p_attempt_id::text, 'op', 'switch_manual'), 1), 1
    from public.member_accounts ma where ma.user_id = a.user_id;

  -- QA-0067(B): request state 재유도(다른 종단 RPC 와 동일) — deferred 트리거 mismatch abort 방지.
  --   manual_pending attempt → derive 는 'blocked' 반환(멱등). manual_review 출처는 이미 blocked 라 무변화.
  update public.refund_requests set state = public.derive_refund_request_state(a.request_id)
    where id = a.request_id;

  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'manual_pending', 'attempt_id', p_attempt_id);
end;
$function$;

-- ── C: mark_pg_requested 가드에서 manual_review 제거(도달불가 재시도 → invalid_state 로 명확 거부) ──
CREATE OR REPLACE FUNCTION public.admin_refund_mark_pg_requested(p_attempt_id uuid, p_total_before bigint, p_cancelled_before bigint, p_cancellable_before bigint, p_cancellation_ids_before jsonb, p_request_body jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare a public.order_refund_attempts;
begin
  select * into a from public.order_refund_attempts where id = p_attempt_id for update;
  if not found then raise exception 'attempt_not_found' using errcode = 'P0001'; end if;
  -- 멱등: 이미 pg_requested 이고 저장 body/preflight 동일이면 no_op.
  if a.state in ('pg_requested', 'pg_pending', 'pg_succeeded') then
    if a.pg_request_body = p_request_body and a.pg_total_before = p_total_before then
      return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'no_op', 'idempotent', true);
    end if;
    raise exception 'request_conflict' using errcode = 'P0001';
  end if;
  -- QA-0067(C): 'manual_review' 제거 — manual_review->pg_requested 재시도는 set-once 와 충돌해 도달불가였음.
  --   PG 재시도 복구는 replan_after_pg(신규 attempt)로 일원화. 여기선 prepared 만 PG 진입 허용.
  if a.state not in ('prepared') then raise exception 'invalid_state' using errcode = 'P0001'; end if;
  if a.rail <> 'portone_cancel' then raise exception 'rail_not_pg' using errcode = 'P0001'; end if;

  update public.order_refund_attempts
     set state = 'pg_requested',
         pg_total_before = p_total_before, pg_cancelled_before = p_cancelled_before,
         pg_cancellable_before = p_cancellable_before, pg_cancellation_ids_before = p_cancellation_ids_before,
         pg_preflight_at = clock_timestamp(),
         pg_idempotency_key = a.id::text, pg_requested_at = clock_timestamp(),
         pg_request_body = p_request_body
   where id = p_attempt_id;
  update public.refund_requests set state = 'processing'
    where id = a.request_id and state = 'prepared';
  return pg_catalog.jsonb_build_object('ok', true, 'outcome', 'pg_requested', 'attempt_id', p_attempt_id);
end;
$function$;
