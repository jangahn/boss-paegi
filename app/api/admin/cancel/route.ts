import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  getPortonePaymentSnapshot,
  portoneCancelConfigured,
  type PortonePaymentSnapshot,
} from "@/lib/portone";
import { assertWriteAllowed } from "@/lib/credits-gate";
import { handleObservedCancellation, refundRpcErrorResponsePayload } from "@/lib/refund-saga";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 주문 취소 — cancel intent 흐름(v0.76 §B.8.2). 이 라우트는 PG 취소 POST 를 직접 하지 않는다.
 * ① cancel_intent_begin(set-once·멱등)으로 고객 취소 의사를 먼저 영속 → ② fresh 스냅샷 분기:
 *  - CANCELLED 관측 → handleObservedCancellation(이벤트 영속·무결제 종단/auto-full).
 *  - PAID/PARTIAL_CANCELLED → (로컬 미지급이면 mark_paid_and_grant finalizer — intent 가 이미
 *    기록돼 지급은 quarantine 로트+late_paid issue 로 흡수) → cancel_intent_resolve 로 scoped
 *    환불 준비. 실취소 실행은 /api/admin/refund-credits process 가 담당.
 *  - 무이동(READY/PENDING/FAILED·결제건 없음) → 미지급이면 admin_cancel_order 로컬 취소,
 *    로컬 paid 면 PG 무이동과 모순(409 pg_state_mismatch).
 * PG 관측 불가(paymentId 없음·포트원 미설정)면 무이동 확정 불가 — 미지급만 로컬 취소,
 * paid 는 스냅샷 없이 환불 진행 금지(409 use_refund_saga).
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrderRow = {
  order_uuid: string;
  status: string;
  payment_id: string | null;
  provider: string | null;
  paid_at: string | null;
  credits: number;
  refunded_credits: number;
  amount: number;
  cancel_intent_created_at: string | null;
};

export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  // Phase-A 유지보수 게이트(v0.76 컷오버) — closed 면 신규 cancel intent 진입 차단.
  const maintenance = assertWriteAllowed({ actor: "admin" });
  if (maintenance) return maintenance;

  const body = (await req.json().catch(() => null)) as
    | { orderUuid?: string; reason?: string; customerRequestedAt?: string }
    | null;
  const orderUuid = body?.orderUuid;
  const reason = body?.reason?.trim() ?? "";
  const customerRequestedAt = body?.customerRequestedAt;
  if (!orderUuid || !UUID_RE.test(orderUuid) || !customerRequestedAt) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (Number.isNaN(Date.parse(customerRequestedAt))) {
    return NextResponse.json({ error: "malformed" }, { status: 400 });
  }
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: orderRow, error: loadErr } = await admin
    .from("orders")
    .select(
      "order_uuid, status, payment_id, provider, paid_at, credits, refunded_credits, amount, cancel_intent_created_at"
    )
    .eq("order_uuid", orderUuid)
    .maybeSingle();
  if (loadErr) {
    log.warn("admin.cancel_load_fail", { orderUuid, ...errInfo(loadErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 400 });
  }
  const order = orderRow as OrderRow | null;
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });

  // 1) intent 기록(set-once·멱등 — 재호출은 no_op, version 무증가).
  const { error: intentErr } = await admin.rpc("cancel_intent_begin", {
    p_admin: gate.user.id,
    p_order_uuid: orderUuid,
    p_customer_requested_at: customerRequestedAt,
    p_reason: reason,
  });
  if (intentErr) {
    const p = refundRpcErrorResponsePayload(intentErr, {
      route: "admin/cancel", stage: "intent", orderUuid,
    });
    return NextResponse.json(p.body, { status: p.status });
  }

  if (order.status === "canceled") {
    return NextResponse.json({ ok: true, outcome: "already_canceled" });
  }

  // 2) PG 관측 불가 — 무이동 확정 불가. 미지급만 로컬 취소.
  const canObservePg =
    order.provider === "portone" && !!order.payment_id && portoneCancelConfigured();
  if (!canObservePg) {
    if (!order.paid_at) return localCancel(admin, gate.user.id, order.order_uuid, reason);
    return NextResponse.json({ error: "use_refund_saga" }, { status: 409 });
  }

  // 3) fresh 스냅샷 분기.
  const snapRes = await getPortonePaymentSnapshot(order.payment_id!);
  if (!snapRes.ok) {
    if (snapRes.kind === "not_found") {
      // 결제 시도 자체가 없음 — 무이동 확정.
      if (!order.paid_at) return localCancel(admin, gate.user.id, order.order_uuid, reason);
      // 로컬 paid 인데 PG 에 결제 건이 없음 — 모순(운영 확인 필요).
      return NextResponse.json({ error: "pg_state_mismatch" }, { status: 409 });
    }
    return NextResponse.json(
      { error: "pg_unreachable", message: "포트원 연결 실패 — 잠시 후 재시도하세요." },
      { status: 502 }
    );
  }
  const snapshot = snapRes.snapshot;

  switch (snapshot.status) {
    case "CANCELLED": {
      const observed = await handleObservedCancellation(
        admin,
        { order_uuid: order.order_uuid, paid_at: order.paid_at },
        snapshot
      );
      if (observed.outcome === "error") {
        const p = refundRpcErrorResponsePayload({ message: observed.error }, {
          route: "admin/cancel", stage: "observed", orderUuid,
        });
        return NextResponse.json(p.body, { status: p.status });
      }
      log.info("admin.cancel_observed", {
        orderUuid, adminId: gate.user.id, outcome: observed.outcome,
      });
      if (observed.outcome === "resolved_full") {
        return NextResponse.json({
          ok: true, outcome: observed.outcome, batchId: observed.batchId ?? null,
        });
      }
      return NextResponse.json({ ok: true, outcome: observed.outcome });
    }

    case "PAID":
    case "PARTIAL_CANCELLED": {
      if (!order.paid_at) {
        const grantFail = await finalizeGrant(admin, order, snapshot);
        if (grantFail) return grantFail;
      }
      const { data, error } = await admin.rpc("cancel_intent_resolve", {
        p_admin: gate.user.id,
        p_order_uuid: orderUuid,
        p_qty: order.credits - order.refunded_credits,
      });
      if (error) {
        const p = refundRpcErrorResponsePayload(error, {
          route: "admin/cancel", stage: "resolve", orderUuid,
        });
        return NextResponse.json(p.body, { status: p.status });
      }
      const res = data as
        | { request_id?: string; attempt_id?: string; qty?: number; amount?: number }
        | null;
      log.info("admin.cancel_refund_prepared", {
        orderUuid, adminId: gate.user.id, attemptId: res?.attempt_id,
      });
      // 이후 실행(PG 부분취소)은 /api/admin/refund-credits process(auto) 로 진행.
      return NextResponse.json({
        ok: true,
        outcome: "refund_prepared",
        requestId: res?.request_id,
        attemptId: res?.attempt_id,
        qty: res?.qty,
        amount: res?.amount,
      });
    }

    case "READY":
    case "PENDING":
    case "FAILED": {
      // 무이동 확정 — 미지급이면 로컬 취소, 로컬 paid 면 모순.
      if (!order.paid_at) return localCancel(admin, gate.user.id, order.order_uuid, reason);
      return NextResponse.json({ error: "pg_state_mismatch" }, { status: 409 });
    }

    default:
      // VIRTUAL_ACCOUNT_ISSUED·UNRECOGNIZED — 진행형/판정불가. 종단 확정 불가.
      return NextResponse.json(
        { error: "pg_state_pending", status: snapshot.status },
        { status: 409 }
      );
  }
}

/** 무이동 확정 시 로컬 취소 — 미지급(pending 등) 전용(회수 없음). paid 는 RPC 가 use_refund_saga RAISE. */
async function localCancel(
  admin: SupabaseClient,
  adminId: string,
  orderUuid: string,
  reason: string
): Promise<NextResponse> {
  const { error } = await admin.rpc("admin_cancel_order", {
    p_admin: adminId,
    p_order_uuid: orderUuid,
    p_clawback: false,
    p_reason: reason,
    p_pg_done: false,
  });
  if (error) {
    const p = refundRpcErrorResponsePayload(error, {
      route: "admin/cancel", stage: "local_cancel", orderUuid,
    });
    return NextResponse.json(p.body, { status: p.status });
  }
  log.info("admin.cancel_ok", { orderUuid, adminId });
  return NextResponse.json({ ok: true, outcome: "canceled" });
}

/**
 * 지급 finalizer — 로컬 미지급(paid_at null)인데 PG 가 PAID/PARTIAL_CANCELLED 인 주문의 지급 종결.
 * intent 가 이미 기록돼 있어 RPC 가 quarantine 로트+late_paid issue 로 흡수한다(§40).
 * 실패 시 오류 응답을, 성공(멱등 skip 포함) 시 null 을 돌려준다.
 */
async function finalizeGrant(
  admin: SupabaseClient,
  order: OrderRow,
  snapshot: PortonePaymentSnapshot
): Promise<NextResponse | null> {
  const paidAt = typeof snapshot.raw.paidAt === "string" ? snapshot.raw.paidAt : null;
  if (!paidAt) {
    // paid_at 없이 grant 금지(RPC paid_at_required) — 호출 전 확인, 시도 자체를 실패로 기록.
    log.error("admin.cancel_grant_fail", { orderUuid: order.order_uuid, cause: "paid_at_missing" });
    return NextResponse.json({ error: "paid_at_required" }, { status: 400 });
  }
  if (snapshot.totalAmount === null) {
    // 금액 판정불가 스냅샷 — 지급 검증 불가(진행형/판정불가와 동일 취급).
    log.error("admin.cancel_grant_fail", {
      orderUuid: order.order_uuid, cause: "total_amount_missing",
    });
    return NextResponse.json(
      { error: "pg_state_pending", status: snapshot.status },
      { status: 409 }
    );
  }
  const { data: granted, error } = await admin.rpc("mark_paid_and_grant", {
    p_order_uuid: order.order_uuid,
    p_pg_tx_id: typeof snapshot.raw.transactionId === "string" ? snapshot.raw.transactionId : null,
    p_price: snapshot.totalAmount,
    p_raw: { source: "admin_cancel", verified_status: snapshot.status },
    p_paid_at: paidAt,
    p_receipt_url: typeof snapshot.raw.receiptUrl === "string" ? snapshot.raw.receiptUrl : null,
  });
  if (error) {
    log.error("admin.cancel_grant_fail", { orderUuid: order.order_uuid, ...errInfo(error) });
    const p = refundRpcErrorResponsePayload(error, {
      route: "admin/cancel", stage: "grant", orderUuid: order.order_uuid,
    });
    return NextResponse.json(p.body, { status: p.status });
  }
  if (granted === false) {
    // 멱등 skip(동시 처리·금액 불일치 등) — 이후 resolve 가 order_not_paid 등으로 정확히 실패한다.
    log.warn("admin.cancel_grant_noop", { orderUuid: order.order_uuid });
  }
  return null;
}
