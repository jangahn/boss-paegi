import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getPortonePaymentSnapshot,
  portoneCancelConfigured,
  type PortonePaymentSnapshot,
} from "@/lib/portone";
import {
  isAdminRefundAttemptPostcondition,
  parseAdminRefundAttemptResult,
  parseAdminRefundBeginResult,
  proveAdminRefundBegin,
  type AdminRefundAttemptAction,
} from "@/lib/pay/refund-mutation-result";
import { exactPortoneEvidenceFailure } from "@/lib/pay/payment-evidence";
import { processAttemptAuto, refundRpcErrorResponsePayload } from "@/lib/refund-saga";
import {
  readSupabaseRowsPaginated,
  requireSupabaseOptionalData,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
// process auto 가 PG 부분취소 POST(fetch 65s)를 라우트 안에서 대기한다(§B.8.1).
export const maxDuration = 120;

/**
 * 수량 환불 saga 단일 라우트(v0.76 §B.8.1) — 관리자만. body.mode 4종:
 *  - preview: 서버 직쿼리 산식으로 plan 표시(무기록·재시도 무해). **최종 권위는 begin** —
 *      admin_refund_begin 이 FOR UPDATE 재계산으로 확정한다(이 값은 안내용).
 *  - begin: requestId(클라 생성 uuid)를 멱등키로 admin_refund_begin 위임(동일 payload 재호출 no_op).
 *  - process: attempt 1건 전진(HTTP 1회당 1건). auto(PG 경로)는 lib/refund-saga 오케스트레이션,
 *      switch_to_manual/commit_manual/release/replan 은 대응 RPC 위임.
 *  - status: request 1행 + attempts 목록 조회(무기록).
 * 게이트 대상 = begin·process(§14.2 — preview/status 는 읽기 전용).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYOUT_REF_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const REQUEST_STATES = new Set([
  "building",
  "prepared",
  "processing",
  "blocked",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
const ATTEMPT_STATES = new Set([
  "prepared",
  "pg_requested",
  "pg_pending",
  "pg_succeeded",
  "manual_pending",
  "manual_review",
  "committed",
  "released",
]);

type RefundCreditsBody = {
  mode?: string;
  // preview·begin
  userId?: string;
  orderUuid?: string;
  qty?: number;
  customerRequestedAt?: string;
  // begin·status
  requestId?: string;
  reason?: string;
  rail?: string;
  // process
  attemptId?: string;
  action?: string;
  payout?: { externalPayoutRef?: string; evidenceObjectId?: string };
};

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as RefundCreditsBody | null;
  if (!body?.mode) return NextResponse.json({ error: "invalid_mode" }, { status: 400 });

  const admin = createAdminClient();
  try {
    switch (body.mode) {
      case "preview":
        return await handlePreview(admin, body);
      case "begin":
        return await handleBegin(admin, gate.user.id, body);
      case "process":
        return await handleProcess(admin, gate.user.id, body);
      case "status":
        return await handleStatus(admin, body);
      default:
        return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
    }
  } catch (error) {
    log.error("admin.refund_route_unavailable", {
      mode: body.mode,
      ...errInfo(
        error instanceof SupabaseOperationError
          ? error.operationError
          : error,
      ),
    });
    return NextResponse.json(
      { error: "action_unconfirmed", retryable: true },
      { status: 503 },
    );
  }
}

// ── preview — 표시용 plan 계산(무기록) ─────────────────────────────────────────────────────
async function handlePreview(admin: SupabaseClient, body: RefundCreditsBody) {
  const { userId, orderUuid, qty, customerRequestedAt } = body;
  if (
    !userId || !UUID_RE.test(userId) ||
    !orderUuid || !UUID_RE.test(orderUuid) ||
    typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0 ||
    !customerRequestedAt || Number.isNaN(Date.parse(customerRequestedAt))
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const orderRow = await requireSupabaseOptionalData(
    "admin.refund.preview.order",
    () =>
      admin
        .from("orders")
        .select("order_uuid, amount, credits, refunded_credits, refunded_amount, paid_at")
        .eq("order_uuid", orderUuid)
        .eq("user_id", userId)
        .maybeSingle(),
  );
  const order = orderRow
    ? validateAdminRows<{
        order_uuid: string;
        amount: number;
        credits: number;
        refunded_credits: number;
        refunded_amount: number;
        paid_at: string | null;
      }>("admin.refund.preview.order", [orderRow], {
        order_uuid: "uuid",
        amount: "nonnegativeNumeric",
        credits: "nonnegativeInteger",
        refunded_credits: "nonnegativeInteger",
        refunded_amount: "nonnegativeNumeric",
        paid_at: "nullableTimestamp",
      })[0]!
    : null;
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  if (order.order_uuid !== orderUuid) {
    throw new SupabaseOperationError(
      "admin.refund.preview.order",
      new Error("order_correlation_mismatch"),
    );
  }
  if (!order.paid_at) return NextResponse.json({ error: "order_not_paid" }, { status: 400 });

  const lotRow = await requireSupabaseOptionalData(
    "admin.refund.preview.lot",
    () =>
      admin
        .from("credit_lots")
        .select("order_uuid, source, qty, consumed, refunded, refund_reserved")
        .eq("order_uuid", orderUuid)
        .eq("source", "purchase")
        .maybeSingle(),
  );
  const lot = lotRow
    ? validateAdminRows<{
        order_uuid: string;
        source: string;
        qty: number;
        consumed: number;
        refunded: number;
        refund_reserved: number;
      }>("admin.refund.preview.lot", [lotRow], {
        order_uuid: "uuid",
        source: "string",
        qty: "nonnegativeInteger",
        consumed: "nonnegativeInteger",
        refunded: "nonnegativeInteger",
        refund_reserved: "nonnegativeInteger",
      })[0]!
    : null;
  if (!lot) return NextResponse.json({ error: "purchase_lot_not_found" }, { status: 404 });
  if (lot.order_uuid !== orderUuid || lot.source !== "purchase") {
    throw new SupabaseOperationError(
      "admin.refund.preview.lot",
      new Error("lot_correlation_mismatch"),
    );
  }
  const orderAmount = safeInteger(order.amount);
  const orderCredits = safeInteger(order.credits);
  const refundedCredits = safeInteger(order.refunded_credits);
  const refundedAmount = safeInteger(order.refunded_amount);
  const lotQty = safeInteger(lot.qty);
  const lotConsumed = safeInteger(lot.consumed);
  const lotRefunded = safeInteger(lot.refunded);
  const lotReserved = safeInteger(lot.refund_reserved);
  if (
    orderAmount === null ||
    orderAmount <= 0 ||
    orderCredits === null ||
    orderCredits <= 0 ||
    refundedCredits === null ||
    refundedAmount === null ||
    refundedCredits > orderCredits ||
    refundedAmount > orderAmount ||
    lotQty === null ||
    lotQty <= 0 ||
    lotConsumed === null ||
    lotRefunded === null ||
    lotReserved === null ||
    lotConsumed + lotRefunded + lotReserved > lotQty
  ) {
    throw new SupabaseOperationError(
      "admin.refund.preview.invariants",
      new Error("financial_row_invariant_mismatch"),
    );
  }

  // 산식(§4.2) — bp_refund_rate_bps/bp_refund_amount 와 동일. 표시용이며 확정은 begin 이 재계산.
  const paidAtMs = new Date(order.paid_at).getTime();
  const rateBps = Date.parse(customerRequestedAt) <= paidAtMs + 7 * 24 * 60 * 60 * 1000 ? 10000 : 9000;
  const lotAvailable = lotQty - lotConsumed - lotRefunded - lotReserved;
  const orderRemainingQty = orderCredits - refundedCredits;
  const remainingCash = orderAmount - refundedAmount;
  if (qty > lotAvailable) {
    return NextResponse.json(
      { error: "qty_exceeds_available" },
      { status: 400 },
    );
  }
  if (qty > orderRemainingQty) {
    return NextResponse.json(
      { error: "qty_exceeds_order_remaining" },
      { status: 400 },
    );
  }
  if (remainingCash <= 0) {
    return NextResponse.json(
      { error: "nothing_to_refund" },
      { status: 400 },
    );
  }
  const amount = Math.min(
    Math.ceil((orderAmount * qty * rateBps) / (orderCredits * 10000)),
    remainingCash
  );
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new SupabaseOperationError(
      "admin.refund.preview.amount",
      new Error("refund_amount_invalid"),
    );
  }
  const deadline = new Date(paidAtMs);
  deadline.setFullYear(deadline.getFullYear() + 5); // refund_deadline = paid_at + 5y(attempt 스냅샷과 동일 기준)

  return NextResponse.json({
    ok: true,
    plan: {
      qty,
      amount,
      rateBps,
      lotAvailable,
      orderRemainingQty,
      remainingCash,
      paidAt: order.paid_at,
      deadline: deadline.toISOString(),
    },
  });
}

// ── begin — admin_refund_begin 위임(requestId 멱등) ───────────────────────────────────────
async function handleBegin(admin: SupabaseClient, adminId: string, body: RefundCreditsBody) {
  const { requestId, userId, orderUuid, qty, customerRequestedAt } = body;
  const reason = body.reason?.trim() ?? "";
  if (
    !requestId || !UUID_RE.test(requestId) ||
    !userId || !UUID_RE.test(userId) ||
    !orderUuid || !UUID_RE.test(orderUuid) ||
    typeof qty !== "number" || !Number.isInteger(qty) || qty <= 0 ||
    !customerRequestedAt || Number.isNaN(Date.parse(customerRequestedAt))
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }

  const { data, error } = await admin.rpc("admin_refund_begin", {
    p_request_id: requestId,
    p_admin: adminId,
    p_user: userId,
    p_order_uuid: orderUuid,
    p_qty: qty,
    p_reason: reason,
    p_customer_requested_at: customerRequestedAt,
    p_rail: body.rail ?? "portone_cancel",
  });
  if (error) {
    const p = refundRpcErrorResponsePayload(error, {
      route: "admin/refund-credits", mode: "begin", orderUuid, requestId,
    });
    return NextResponse.json(p.body, { status: p.status });
  }
  const receipt = parseAdminRefundBeginResult(data, {
    requestId,
    qty,
  });
  if (!receipt) return mutationUnconfirmed("begin", { requestId, orderUuid });

  const [requestRow, attemptRow] = await Promise.all([
    requireSupabaseOptionalData("admin.refund.begin.request_proof", () =>
      admin
        .from("refund_requests")
        .select("id, user_id, origin, requested_qty, approved_amount, state")
        .eq("id", requestId)
        .maybeSingle(),
    ),
    requireSupabaseOptionalData("admin.refund.begin.attempt_proof", () =>
      admin
        .from("order_refund_attempts")
        .select("id, request_id, sequence, order_uuid, user_id, qty, amount, rate_bps, state")
        .eq("request_id", requestId)
        .eq("sequence", 1)
        .maybeSingle(),
    ),
  ]);
  const proof = proveAdminRefundBegin(receipt, requestRow, attemptRow, {
    requestId,
    userId,
    orderUuid,
    qty,
  });
  if (!proof) return mutationUnconfirmed("begin_proof", { requestId, orderUuid });
  log.info("admin.refund_begin_ok", { orderUuid, requestId, adminId });
  return NextResponse.json(proof);
}

// ── process — attempt 1건 전진(HTTP 1회당 1건) ────────────────────────────────────────────
async function handleProcess(admin: SupabaseClient, adminId: string, body: RefundCreditsBody) {
  const attemptId = body.attemptId;
  if (!attemptId || !UUID_RE.test(attemptId)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const action = body.action ?? "auto";

  if (action === "auto") {
    if (!portoneCancelConfigured()) {
      return NextResponse.json({ error: "portone_not_configured" }, { status: 503 });
    }
    const res = await processAttemptAuto(admin, attemptId);
    log.info("admin.refund_process_auto", { attemptId, adminId, outcome: res.outcome, detail: res.detail });
    return NextResponse.json({ ok: true, ...res });
  }

  // auto 외 액션은 전부 reason 필수(RPC 5~500 규약과 동일 검증).
  const reason = body.reason?.trim() ?? "";
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }

  if (action === "release") {
    const { data, error } = await admin.rpc("admin_refund_release", {
      p_attempt_id: attemptId,
      p_admin: adminId,
      p_reason: reason,
    });
    if (error) {
      const p = refundRpcErrorResponsePayload(error, {
        route: "admin/refund-credits", mode: "process", action, attemptId,
      });
      return NextResponse.json(p.body, { status: p.status });
    }
    const confirmed = await confirmAttemptMutation(admin, data, {
      action: "release",
      attemptId,
    });
    if (!confirmed) return mutationUnconfirmed("release", { attemptId });
    log.info("admin.refund_release_ok", { attemptId, adminId });
    return NextResponse.json(confirmed);
  }

  if (action === "commit_manual") {
    const payout = body.payout;
    if (
      !payout?.externalPayoutRef || !PAYOUT_REF_RE.test(payout.externalPayoutRef) ||
      !payout?.evidenceObjectId || !UUID_RE.test(payout.evidenceObjectId)
    ) {
      return NextResponse.json({ error: "evidence_invalid" }, { status: 400 });
    }
    const { data, error } = await admin.rpc("admin_refund_commit_manual", {
      p_attempt_id: attemptId,
      p_admin: adminId,
      p_reason: reason,
      p_external_payout_ref: payout.externalPayoutRef,
      p_evidence_object_id: payout.evidenceObjectId,
    });
    if (error) {
      const p = refundRpcErrorResponsePayload(error, {
        route: "admin/refund-credits", mode: "process", action, attemptId,
      });
      return NextResponse.json(p.body, { status: p.status });
    }
    const confirmed = await confirmAttemptMutation(admin, data, {
      action: "commit_manual",
      attemptId,
      externalPayoutRef: payout.externalPayoutRef,
      evidenceObjectId: payout.evidenceObjectId,
    });
    if (!confirmed) {
      return mutationUnconfirmed("commit_manual", { attemptId });
    }
    log.info("admin.refund_commit_manual_ok", { attemptId, adminId });
    return NextResponse.json(confirmed);
  }

  if (action === "switch_to_manual") {
    // 무이동 증빙(fresh 스냅샷)이 없으면 manual 전환 불가 — 포트원 미설정은 증빙 불가.
    if (!portoneCancelConfigured()) {
      return NextResponse.json({ error: "evidence_invalid" }, { status: 400 });
    }
    const snap = await freshSnapshotForAttempt(admin, attemptId);
    if ("response" in snap) return snap.response;
    const observedCancelledAmount = snap.snapshot.cancelledAmount ?? 0;
    const observedCancellationIds = snap.snapshot.cancellations
      .map((c) => c.id)
      .filter(Boolean);
    const { data, error } = await admin.rpc("admin_refund_switch_to_manual", {
      p_attempt_id: attemptId,
      p_admin: adminId,
      p_reason: reason,
      p_observed_cancelled_amount: observedCancelledAmount,
      p_observed_cancellation_ids: observedCancellationIds,
      p_verification_source: "admin_reconcile",
    });
    if (error) {
      const p = refundRpcErrorResponsePayload(error, {
        route: "admin/refund-credits", mode: "process", action, attemptId,
      });
      return NextResponse.json(p.body, { status: p.status });
    }
    const confirmed = await confirmAttemptMutation(admin, data, {
      action: "switch_to_manual",
      attemptId,
      observedCancelledAmount,
      observedCancellationIds,
    });
    if (!confirmed) {
      return mutationUnconfirmed("switch_to_manual", { attemptId });
    }
    log.info("admin.refund_switch_manual_ok", { attemptId, adminId });
    return NextResponse.json(confirmed);
  }

  if (action === "replan") {
    const attemptRow = await requireSupabaseOptionalData(
      "admin.refund.replan.attempt",
      () =>
        admin
          .from("order_refund_attempts")
          .select("id, pg_requested_at")
          .eq("id", attemptId)
          .maybeSingle(),
    );
    const attempt =
      attemptRow &&
      typeof attemptRow === "object" &&
      !Array.isArray(attemptRow) &&
      (attemptRow as { id?: unknown }).id === attemptId &&
      ((attemptRow as { pg_requested_at?: unknown }).pg_requested_at === null ||
        (typeof (attemptRow as { pg_requested_at?: unknown }).pg_requested_at ===
          "string" &&
          Number.isFinite(
            Date.parse(
              (attemptRow as { pg_requested_at: string }).pg_requested_at,
            ),
          )))
        ? (attemptRow as { id: string; pg_requested_at: string | null })
        : null;
    if (attemptRow && !attempt) {
      throw new SupabaseOperationError(
        "admin.refund.replan.attempt",
        new Error("invalid_attempt_shape"),
      );
    }
    if (!attempt) return NextResponse.json({ error: "attempt_not_found" }, { status: 404 });

    if (!attempt.pg_requested_at) {
      // pre-PG — PG 발행 전이라 무이동 증빙 불요.
      const { data, error } = await admin.rpc("admin_refund_replan_pre_pg", {
        p_attempt_id: attemptId,
        p_admin: adminId,
        p_reason: reason,
        p_external: false,
      });
      if (error) {
        const p = refundRpcErrorResponsePayload(error, {
          route: "admin/refund-credits", mode: "process", action, attemptId,
        });
        return NextResponse.json(p.body, { status: p.status });
      }
      const confirmed = await confirmAttemptMutation(admin, data, {
        action: "replan_pre_pg",
        attemptId,
      });
      if (!confirmed) {
        return mutationUnconfirmed("replan_pre_pg", { attemptId });
      }
      log.info("admin.refund_replan_ok", { attemptId, adminId, phase: "pre_pg" });
      return NextResponse.json(confirmed);
    }

    // post-PG(state=manual_review 전제) — fresh 증빙과 함께 해제.
    if (!portoneCancelConfigured()) {
      return NextResponse.json({ error: "evidence_invalid" }, { status: 400 });
    }
    const snap = await freshSnapshotForAttempt(admin, attemptId);
    if ("response" in snap) return snap.response;
    const observedCancelledAmount = snap.snapshot.cancelledAmount ?? 0;
    const observedCancellationIds = snap.snapshot.cancellations
      .map((c) => c.id)
      .filter(Boolean);
    const { data, error } = await admin.rpc("admin_refund_replan_after_pg", {
      p_attempt_id: attemptId,
      p_admin: adminId,
      p_reason: reason,
      p_observed_cancelled_amount: observedCancelledAmount,
      p_observed_cancellation_ids: observedCancellationIds,
    });
    if (error) {
      const p = refundRpcErrorResponsePayload(error, {
        route: "admin/refund-credits", mode: "process", action, attemptId,
      });
      return NextResponse.json(p.body, { status: p.status });
    }
    const confirmed = await confirmAttemptMutation(admin, data, {
      action: "replan_after_pg",
      attemptId,
      observedCancelledAmount,
      observedCancellationIds,
    });
    if (!confirmed) {
      return mutationUnconfirmed("replan_after_pg", { attemptId });
    }
    log.info("admin.refund_replan_ok", { attemptId, adminId, phase: "post_pg" });
    return NextResponse.json(confirmed);
  }

  return NextResponse.json({ error: "invalid_action" }, { status: 400 });
}

// ── status — request 1행 + attempts 목록(무기록) ──────────────────────────────────────────
async function handleStatus(admin: SupabaseClient, body: RefundCreditsBody) {
  const requestId = body.requestId;
  if (!requestId || !UUID_RE.test(requestId)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const requestRaw = await requireSupabaseOptionalData(
    "admin.refund.status.request",
    () =>
      admin
        .from("refund_requests")
        .select("*")
        .eq("id", requestId)
        .maybeSingle(),
  );
  if (!requestRaw) {
    return NextResponse.json({ error: "request_not_found" }, { status: 404 });
  }
  const request = validateAdminRows<Record<string, unknown>>(
    "admin.refund.status.request",
    [requestRaw],
    {
      id: "uuid",
      user_id: "uuid",
      admin_user_id: "uuid",
      origin: "string",
      scope_order_uuid: "nullableUuid",
      requested_qty: "nonnegativeInteger",
      customer_requested_at: "timestamp",
      reason: "string",
      state: "string",
      approved_amount: "nullableNonnegativeNumeric",
      created_at: "timestamp",
      updated_at: "timestamp",
      version: "nonnegativeInteger",
    },
  )[0]!;
  if (request.id !== requestId) {
    throw new SupabaseOperationError(
      "admin.refund.status.request",
      new Error("request_correlation_mismatch"),
    );
  }
  if (
    !REQUEST_STATES.has(request.state as string) ||
    (request.origin !== "admin_manual" && request.origin !== "cancel_intent") ||
    (request.requested_qty as number) <= 0
  ) {
    throw new SupabaseOperationError(
      "admin.refund.status.request",
      new Error("request_semantic_shape_mismatch"),
    );
  }

  const attemptsRaw = await readSupabaseRowsPaginated<Record<string, unknown>>(
    "admin.refund.status.attempts",
    (offset, limit) =>
      admin
        .from("order_refund_attempts")
        .select("*")
        .eq("request_id", requestId)
        .order("sequence", { ascending: true })
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1),
  );
  const attempts = validateAdminRows<Record<string, unknown>>(
    "admin.refund.status.attempts",
    attemptsRaw,
    {
      id: "uuid",
      request_id: "uuid",
      sequence: "nonnegativeInteger",
      order_uuid: "uuid",
      user_id: "uuid",
      qty: "nonnegativeInteger",
      amount: "nonnegativeNumeric",
      rail: "string",
      state: "string",
      rate_bps: "nonnegativeInteger",
      created_at: "timestamp",
      updated_at: "timestamp",
      version: "nonnegativeInteger",
    },
  );
  const seenIds = new Set<string>();
  let priorSequence = 0;
  for (const attempt of attempts) {
    const id = attempt.id as string;
    const sequence = attempt.sequence as number;
    if (
      attempt.request_id !== requestId ||
      seenIds.has(id) ||
      sequence <= priorSequence ||
      (attempt.qty as number) <= 0 ||
      safeInteger(attempt.amount) === null ||
      (safeInteger(attempt.amount) ?? 0) <= 0 ||
      ((attempt.rate_bps as number) !== 9000 &&
        (attempt.rate_bps as number) !== 10000) ||
      (attempt.rail !== "portone_cancel" &&
        attempt.rail !== "manual_transfer") ||
      !ATTEMPT_STATES.has(attempt.state as string)
    ) {
      throw new SupabaseOperationError(
        "admin.refund.status.attempts",
        new Error("attempt_correlation_or_order_mismatch"),
      );
    }
    seenIds.add(id);
    priorSequence = sequence;
  }
  return NextResponse.json({ ok: true, request, attempts });
}

/** attempt → 주문 payment_id 로 fresh 스냅샷 — 무이동 증빙(observed 값)의 단일 소스. */
async function freshSnapshotForAttempt(
  admin: SupabaseClient,
  attemptId: string
): Promise<{ snapshot: PortonePaymentSnapshot } | { response: NextResponse }> {
  const attemptRow = await requireSupabaseOptionalData(
    "admin.refund.snapshot.attempt",
    () =>
      admin
        .from("order_refund_attempts")
        .select("id, order_uuid")
        .eq("id", attemptId)
        .maybeSingle(),
  );
  if (!attemptRow) {
    return { response: NextResponse.json({ error: "attempt_not_found" }, { status: 404 }) };
  }
  if (
    typeof attemptRow !== "object" ||
    Array.isArray(attemptRow) ||
    (attemptRow as { id?: unknown }).id !== attemptId ||
    typeof (attemptRow as { order_uuid?: unknown }).order_uuid !== "string" ||
    !UUID_RE.test((attemptRow as { order_uuid: string }).order_uuid)
  ) {
    throw new SupabaseOperationError(
      "admin.refund.snapshot.attempt",
      new Error("invalid_attempt_shape"),
    );
  }
  const orderUuid = (attemptRow as { order_uuid: string }).order_uuid;
  const orderRow = await requireSupabaseOptionalData(
    "admin.refund.snapshot.order",
    () =>
      admin
        .from("orders")
        .select(
          "order_uuid, payment_id, amount, is_test, expected_store_id, expected_currency, expected_channel_key",
        )
        .eq("order_uuid", orderUuid)
        .maybeSingle(),
  );
  if (!orderRow) {
    return {
      response: NextResponse.json(
        { error: "evidence_invalid" },
        { status: 400 },
      ),
    };
  }
  const checkedOrder = validateAdminRows<{
    order_uuid: string;
    payment_id: string | null;
    amount: number;
    is_test: boolean;
    expected_store_id: string | null;
    expected_currency: string | null;
    expected_channel_key: string | null;
  }>("admin.refund.snapshot.order", [orderRow], {
    order_uuid: "uuid",
    payment_id: "nullableString",
    amount: "nonnegativeInteger",
    is_test: "boolean",
    expected_store_id: "nullableString",
    expected_currency: "nullableString",
    expected_channel_key: "nullableString",
  })[0]!;
  if (checkedOrder.order_uuid !== orderUuid) {
    throw new SupabaseOperationError(
      "admin.refund.snapshot.order",
      new Error("invalid_order_shape"),
    );
  }
  const paymentId = checkedOrder.payment_id;
  if (!paymentId) {
    // paymentId 유실 — PG 관측 자체가 불가해 무이동 증빙을 만들 수 없다.
    return { response: NextResponse.json({ error: "evidence_invalid" }, { status: 400 }) };
  }
  const snapRes = await getPortonePaymentSnapshot(
    paymentId,
    checkedOrder.expected_store_id ?? undefined,
  );
  if (!snapRes.ok) {
    return {
      response: NextResponse.json(
        { error: "pg_unreachable", message: "포트원 조회 실패 — 잠시 후 재시도하세요." },
        { status: 502 }
      ),
    };
  }
  const evidenceFailure = exactPortoneEvidenceFailure(
    snapRes.snapshot,
    checkedOrder,
  );
  if (evidenceFailure) {
    log.error("admin.refund_snapshot_evidence_rejected", {
      attemptId,
      orderUuid,
      paymentId,
      reason: evidenceFailure,
    });
    return {
      response: NextResponse.json(
        {
          error:
            evidenceFailure === "legacy_snapshot"
              ? "payment_evidence_incomplete"
              : "payment_evidence_mismatch",
        },
        {
          status: evidenceFailure === "legacy_snapshot" ? 503 : 409,
        },
      ),
    };
  }
  return { snapshot: snapRes.snapshot };
}

type AttemptConfirmation =
  | {
      action: "release";
      attemptId: string;
    }
  | {
      action: "commit_manual";
      attemptId: string;
      externalPayoutRef: string;
      evidenceObjectId: string;
    }
  | {
      action: "switch_to_manual";
      attemptId: string;
      observedCancelledAmount: number;
      observedCancellationIds: string[];
    }
  | {
      action: "replan_pre_pg";
      attemptId: string;
    }
  | {
      action: "replan_after_pg";
      attemptId: string;
      observedCancelledAmount: number;
      observedCancellationIds: string[];
    };

async function confirmAttemptMutation(
  admin: SupabaseClient,
  data: unknown,
  expected: AttemptConfirmation,
): Promise<Record<string, unknown> | null> {
  const receipt = parseAdminRefundAttemptResult(data, {
    action: expected.action as AdminRefundAttemptAction,
    attemptId: expected.attemptId,
  });
  if (!receipt) return null;
  const row = await requireSupabaseOptionalData(
    `admin.refund.${expected.action}.proof`,
    () =>
      admin
        .from("order_refund_attempts")
        .select(
          "id, state, rail, release_reason, external_payout_ref, payout_evidence, reconciliation_result, observed_cancelled_amount, observed_cancellation_ids, verification_source",
        )
        .eq("id", expected.attemptId)
        .maybeSingle(),
  );
  if (!isAdminRefundAttemptPostcondition(row, expected)) return null;
  return {
    ...(typeof data === "object" && data && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : {}),
    ok: true,
    attempt_id: expected.attemptId,
    ...(receipt === "no_op" ? { outcome: "no_op", idempotent: true } : {}),
  };
}

function mutationUnconfirmed(
  phase: string,
  context: Record<string, unknown>,
): NextResponse {
  log.error("admin.refund_mutation_unconfirmed", { phase, ...context });
  return NextResponse.json(
    { error: "action_unconfirmed", retryable: true },
    { status: 503 },
  );
}

function safeInteger(value: unknown): number | null {
  if (Number.isSafeInteger(value)) return value as number;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}
