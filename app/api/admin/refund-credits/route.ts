import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertWriteAllowed } from "@/lib/credits-gate";
import {
  getPortonePaymentSnapshot,
  portoneCancelConfigured,
  type PortonePaymentSnapshot,
} from "@/lib/portone";
import { processAttemptAuto, refundRpcErrorResponsePayload } from "@/lib/refund-saga";
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

  const body = (await req.json().catch(() => null)) as RefundCreditsBody | null;
  if (!body?.mode) return NextResponse.json({ error: "invalid_mode" }, { status: 400 });

  const admin = createAdminClient();
  switch (body.mode) {
    case "preview":
      return handlePreview(admin, body);
    case "begin":
      return handleBegin(admin, gate.user.id, body);
    case "process":
      return handleProcess(admin, gate.user.id, body);
    case "status":
      return handleStatus(admin, body);
    default:
      return NextResponse.json({ error: "invalid_mode" }, { status: 400 });
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

  const { data: orderRow, error: orderErr } = await admin
    .from("orders")
    .select("order_uuid, amount, credits, refunded_credits, refunded_amount, paid_at")
    .eq("order_uuid", orderUuid)
    .eq("user_id", userId)
    .maybeSingle();
  if (orderErr) {
    log.warn("admin.refund_preview_fail", { orderUuid, ...errInfo(orderErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 400 });
  }
  const order = orderRow as {
    amount: number; credits: number; refunded_credits: number; refunded_amount: number;
    paid_at: string | null;
  } | null;
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  if (!order.paid_at) return NextResponse.json({ error: "order_not_paid" }, { status: 400 });

  const { data: lotRow, error: lotErr } = await admin
    .from("credit_lots")
    .select("qty, consumed, refunded, refund_reserved")
    .eq("order_uuid", orderUuid)
    .eq("source", "purchase")
    .maybeSingle();
  if (lotErr) {
    log.warn("admin.refund_preview_fail", { orderUuid, ...errInfo(lotErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 400 });
  }
  const lot = lotRow as {
    qty: number; consumed: number; refunded: number; refund_reserved: number;
  } | null;
  if (!lot) return NextResponse.json({ error: "purchase_lot_not_found" }, { status: 404 });

  // 산식(§4.2) — bp_refund_rate_bps/bp_refund_amount 와 동일. 표시용이며 확정은 begin 이 재계산.
  const paidAtMs = new Date(order.paid_at).getTime();
  const rateBps = Date.parse(customerRequestedAt) <= paidAtMs + 7 * 24 * 60 * 60 * 1000 ? 10000 : 9000;
  const lotAvailable = lot.qty - lot.consumed - lot.refunded - lot.refund_reserved;
  const orderRemainingQty = order.credits - order.refunded_credits;
  const remainingCash = order.amount - order.refunded_amount;
  const amount = Math.min(
    Math.ceil((order.amount * qty * rateBps) / (order.credits * 10000)),
    remainingCash
  );
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
  const maintenance = assertWriteAllowed({ actor: "admin" });
  if (maintenance) return maintenance;

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
  log.info("admin.refund_begin_ok", { orderUuid, requestId, adminId });
  return NextResponse.json(data ?? { ok: true });
}

// ── process — attempt 1건 전진(HTTP 1회당 1건) ────────────────────────────────────────────
async function handleProcess(admin: SupabaseClient, adminId: string, body: RefundCreditsBody) {
  const maintenance = assertWriteAllowed({ actor: "admin" });
  if (maintenance) return maintenance;

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
    log.info("admin.refund_release_ok", { attemptId, adminId });
    return NextResponse.json(data ?? { ok: true });
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
    log.info("admin.refund_commit_manual_ok", { attemptId, adminId });
    return NextResponse.json(data ?? { ok: true });
  }

  if (action === "switch_to_manual") {
    // 무이동 증빙(fresh 스냅샷)이 없으면 manual 전환 불가 — 포트원 미설정은 증빙 불가.
    if (!portoneCancelConfigured()) {
      return NextResponse.json({ error: "evidence_invalid" }, { status: 400 });
    }
    const snap = await freshSnapshotForAttempt(admin, attemptId);
    if ("response" in snap) return snap.response;
    const { data, error } = await admin.rpc("admin_refund_switch_to_manual", {
      p_attempt_id: attemptId,
      p_admin: adminId,
      p_reason: reason,
      p_observed_cancelled_amount: snap.snapshot.cancelledAmount ?? 0,
      p_observed_cancellation_ids: snap.snapshot.cancellations.map((c) => c.id).filter(Boolean),
      p_verification_source: "admin_reconcile",
    });
    if (error) {
      const p = refundRpcErrorResponsePayload(error, {
        route: "admin/refund-credits", mode: "process", action, attemptId,
      });
      return NextResponse.json(p.body, { status: p.status });
    }
    log.info("admin.refund_switch_manual_ok", { attemptId, adminId });
    return NextResponse.json(data ?? { ok: true });
  }

  if (action === "replan") {
    const { data: attemptRow, error: attErr } = await admin
      .from("order_refund_attempts")
      .select("pg_requested_at")
      .eq("id", attemptId)
      .maybeSingle();
    if (attErr) {
      log.warn("admin.refund_replan_load_fail", { attemptId, ...errInfo(attErr) });
      return NextResponse.json({ error: "action_failed" }, { status: 400 });
    }
    const attempt = attemptRow as { pg_requested_at: string | null } | null;
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
      log.info("admin.refund_replan_ok", { attemptId, adminId, phase: "pre_pg" });
      return NextResponse.json(data ?? { ok: true });
    }

    // post-PG(state=manual_review 전제) — fresh 증빙과 함께 해제.
    if (!portoneCancelConfigured()) {
      return NextResponse.json({ error: "evidence_invalid" }, { status: 400 });
    }
    const snap = await freshSnapshotForAttempt(admin, attemptId);
    if ("response" in snap) return snap.response;
    const { data, error } = await admin.rpc("admin_refund_replan_after_pg", {
      p_attempt_id: attemptId,
      p_admin: adminId,
      p_reason: reason,
      p_observed_cancelled_amount: snap.snapshot.cancelledAmount ?? 0,
      p_observed_cancellation_ids: snap.snapshot.cancellations.map((c) => c.id).filter(Boolean),
    });
    if (error) {
      const p = refundRpcErrorResponsePayload(error, {
        route: "admin/refund-credits", mode: "process", action, attemptId,
      });
      return NextResponse.json(p.body, { status: p.status });
    }
    log.info("admin.refund_replan_ok", { attemptId, adminId, phase: "post_pg" });
    return NextResponse.json(data ?? { ok: true });
  }

  return NextResponse.json({ error: "invalid_action" }, { status: 400 });
}

// ── status — request 1행 + attempts 목록(무기록) ──────────────────────────────────────────
async function handleStatus(admin: SupabaseClient, body: RefundCreditsBody) {
  const requestId = body.requestId;
  if (!requestId || !UUID_RE.test(requestId)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const { data: request, error: reqErr } = await admin
    .from("refund_requests")
    .select("*")
    .eq("id", requestId)
    .maybeSingle();
  if (reqErr) {
    log.warn("admin.refund_status_fail", { requestId, ...errInfo(reqErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 400 });
  }
  if (!request) return NextResponse.json({ error: "request_not_found" }, { status: 404 });

  const { data: attempts, error: attErr } = await admin
    .from("order_refund_attempts")
    .select("*")
    .eq("request_id", requestId)
    .order("sequence", { ascending: true })
    .order("id", { ascending: true });
  if (attErr) {
    log.warn("admin.refund_status_fail", { requestId, ...errInfo(attErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 400 });
  }
  return NextResponse.json({ ok: true, request, attempts: attempts ?? [] });
}

/** attempt → 주문 payment_id 로 fresh 스냅샷 — 무이동 증빙(observed 값)의 단일 소스. */
async function freshSnapshotForAttempt(
  admin: SupabaseClient,
  attemptId: string
): Promise<{ snapshot: PortonePaymentSnapshot } | { response: NextResponse }> {
  const { data: attemptRow, error: attErr } = await admin
    .from("order_refund_attempts")
    .select("order_uuid")
    .eq("id", attemptId)
    .maybeSingle();
  if (attErr) {
    log.warn("admin.refund_snapshot_load_fail", { attemptId, ...errInfo(attErr) });
    return { response: NextResponse.json({ error: "action_failed" }, { status: 400 }) };
  }
  const orderUuid = (attemptRow as { order_uuid: string } | null)?.order_uuid;
  if (!orderUuid) {
    return { response: NextResponse.json({ error: "attempt_not_found" }, { status: 404 }) };
  }
  const { data: orderRow } = await admin
    .from("orders")
    .select("payment_id")
    .eq("order_uuid", orderUuid)
    .maybeSingle();
  const paymentId = (orderRow as { payment_id: string | null } | null)?.payment_id ?? null;
  if (!paymentId) {
    // paymentId 유실 — PG 관측 자체가 불가해 무이동 증빙을 만들 수 없다.
    return { response: NextResponse.json({ error: "evidence_invalid" }, { status: 400 }) };
  }
  const snapRes = await getPortonePaymentSnapshot(paymentId);
  if (!snapRes.ok) {
    return {
      response: NextResponse.json(
        { error: "pg_unreachable", message: "포트원 조회 실패 — 잠시 후 재시도하세요." },
        { status: 502 }
      ),
    };
  }
  return { snapshot: snapRes.snapshot };
}
