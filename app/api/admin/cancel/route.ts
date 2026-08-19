import "server-only";
import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  PAYMENT_INTENT_EXPIRE_MS,
  getPortonePaymentSnapshot,
  portoneCancelConfigured,
  type PortonePaymentSnapshot,
} from "@/lib/portone";
import {
  isCanceledUnpaidPostcondition,
  isCancelIntentPostcondition,
  isCancelIntentResolvePostcondition,
  parseAdminCancelOrderResult,
  parseCancelIntentBeginResult,
  parseCancelIntentResolveResult,
  parseMarkPaidAndGrantResult,
  parsePaidOrderPostcondition,
  parseMarkOrderCanceledUnpaidResult,
} from "@/lib/pay/order-mutation-result";
import { handleObservedCancellation, refundRpcErrorResponsePayload } from "@/lib/refund-saga";
import {
  requireSupabaseOptionalData,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { exactPortoneEvidenceFailure } from "@/lib/pay/payment-evidence";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 주문 취소 — cancel intent 흐름(v0.76 §B.8.2). 이 라우트는 PG 취소 POST 를 직접 하지 않는다.
 * ① cancel_intent_begin(set-once·멱등)으로 고객 취소 의사를 먼저 영속 → ② fresh 스냅샷 분기:
 *  - CANCELLED 관측 → handleObservedCancellation(이벤트 영속·무결제 종단/auto-full).
 *  - PAID/PARTIAL_CANCELLED → (로컬 미지급이면 mark_paid_and_grant finalizer — intent 가 이미
 *    기록돼 지급은 quarantine 로트+late_paid issue 로 흡수) → cancel_intent_resolve 로 scoped
 *    환불 준비. 실취소 실행은 /api/admin/refund-credits process 가 담당.
 *  - PortOne READY/PENDING/FAILED·결제건 없음 → 과거 브라우저가 이미 받은 paymentId로
 *    결제를 늦게 시작할 수 있으므로 로컬 취소 금지. 같은 intent를 미해결로 유지한다.
 *  - 비-PortOne 레거시 무이동 주문만 미지급 로컬 취소를 허용한다.
 * PortOne PG 관측 불가(paymentId 없음·API 미설정)도 무이동을 증명하지 못하므로
 * fail-closed 한다. PortOne 미지급 주문의 로컬 종단은 exact CANCELLED 관측 뒤
 * mark_order_canceled_unpaid 경로에서만 가능하다.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type OrderRow = {
  order_uuid: string;
  status: string;
  payment_id: string | null;
  provider: string | null;
  paid_at: string | null;
  created_at: string;
  credits: number;
  refunded_credits: number;
  amount: number;
  is_test: boolean;
  expected_store_id: string | null;
  expected_currency: string | null;
  expected_channel_key: string | null;
  cancel_intent_created_at: string | null;
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
  const body = requestBody.value as
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
  try {
    // 1) intent 기록(set-once·exact replay). The authoritative order read
    // follows the locked mutation so every branch sees a post-intent snapshot.
    const { data: intentData, error: intentErr } = await admin.rpc(
      "cancel_intent_begin",
      {
        p_admin: gate.user.id,
        p_order_uuid: orderUuid,
        p_customer_requested_at: customerRequestedAt,
        p_reason: reason,
      },
    );
    if (intentErr) {
      const p = refundRpcErrorResponsePayload(intentErr, {
        route: "admin/cancel",
        stage: "intent",
        orderUuid,
      });
      return NextResponse.json(p.body, { status: p.status });
    }
    if (!parseCancelIntentBeginResult(intentData)) {
      return mutationUnconfirmed("intent_receipt", orderUuid);
    }

    const orderRaw = await requireSupabaseOptionalData(
      "admin.cancel.intent_proof",
      () =>
        admin
          .from("orders")
          .select(
            "order_uuid, status, payment_id, provider, paid_at, created_at, credits, refunded_credits, amount, is_test, expected_store_id, expected_currency, expected_channel_key, cancel_requested_at, cancel_intent_created_at, cancel_intent_reason",
          )
          .eq("order_uuid", orderUuid)
          .maybeSingle(),
    );
    if (!orderRaw) {
      return NextResponse.json({ error: "order_not_found" }, { status: 404 });
    }
    const order = validateAdminRows<
      OrderRow & {
        cancel_requested_at: string;
        cancel_intent_reason: string;
      }
    >("admin.cancel.intent_proof", [orderRaw], {
      order_uuid: "uuid",
      status: "string",
      payment_id: "nullableString",
      provider: "nullableString",
      paid_at: "nullableTimestamp",
      created_at: "timestamp",
      credits: "nonnegativeInteger",
      refunded_credits: "nonnegativeInteger",
      amount: "nonnegativeInteger",
      is_test: "boolean",
      expected_store_id: "nullableString",
      expected_currency: "nullableString",
      expected_channel_key: "nullableString",
      cancel_requested_at: "timestamp",
      cancel_intent_created_at: "timestamp",
      cancel_intent_reason: "string",
    })[0]!;
    if (
      !isCancelIntentPostcondition(order, {
        orderUuid,
        customerRequestedAt,
        reason,
      }) ||
      !["pending", "paid", "canceled", "failed"].includes(order.status) ||
      order.credits <= 0 ||
      order.amount <= 0 ||
      order.refunded_credits > order.credits
    ) {
      return mutationUnconfirmed("intent_postcondition", orderUuid);
    }

    if (order.status === "canceled") {
      return NextResponse.json({ ok: true, outcome: "already_canceled" });
    }

    // 2) 비-PortOne 레거시 주문만 기존 로컬 취소를 유지한다. PortOne checkout
    // receipt는 provider에 아직 객체가 없어도 과거 탭에 이미 노출됐을 수 있다.
    // 따라서 404/구성 장애를 "결제 불가능"으로 해석해 intent를 해제하면 안 된다.
    if (order.provider !== "portone") {
      if (!order.paid_at) {
        return localCancel(admin, gate.user.id, order.order_uuid, reason);
      }
      return NextResponse.json({ error: "use_refund_saga" }, { status: 409 });
    }
    if (!order.payment_id || !portoneCancelConfigured()) {
      return NextResponse.json(
        {
          error: "pg_unreachable",
          message: "포트원 결제 상태를 확인할 수 없어 취소하지 않았습니다.",
        },
        { status: 502 },
      );
    }

    // 3) fresh 스냅샷 분기.
    const snapRes = await getPortonePaymentSnapshot(
      order.payment_id,
      order.expected_store_id ?? undefined,
    );
    if (!snapRes.ok) {
      if (snapRes.kind === "not_found") {
        // requestPayment 호출 전이면 provider 객체가 아직 없다. 하지만 checkout
        // receipt를 가진 과거 탭은 이후 같은 paymentId로 결제를 시작할 수 있으므로
        // 미해결 intent를 유지해 새 paymentId 발급을 막는다.
        return order.paid_at
          ? NextResponse.json(
              { error: "pg_state_mismatch" },
              { status: 409 },
            )
          : NextResponse.json(
              { error: "pg_state_pending", status: "NOT_FOUND" },
              { status: 409 },
            );
      }
      return NextResponse.json(
        {
          error: "pg_unreachable",
          message: "포트원 연결 실패 — 잠시 후 재시도하세요.",
        },
        { status: 502 },
      );
    }
    const snapshot = snapRes.snapshot;
    const evidenceFailure = exactPortoneEvidenceFailure(snapshot, order);
    if (evidenceFailure) {
      log.error("admin.cancel_payment_evidence_rejected", {
        orderUuid,
        paymentId: order.payment_id,
        reason: evidenceFailure,
      });
      return NextResponse.json(
        {
          error:
            evidenceFailure === "legacy_snapshot"
              ? "payment_evidence_incomplete"
              : "payment_evidence_mismatch",
        },
        { status: evidenceFailure === "legacy_snapshot" ? 503 : 409 },
      );
    }

    switch (snapshot.status) {
      case "CANCELLED": {
        const observed = await handleObservedCancellation(
          admin,
          {
            order_uuid: order.order_uuid,
            paid_at: order.paid_at,
            payment_id: order.payment_id,
            amount: order.amount,
            is_test: order.is_test,
            expected_store_id: order.expected_store_id,
            expected_currency: order.expected_currency,
            expected_channel_key: order.expected_channel_key,
          },
          snapshot,
        );
        if (observed.outcome === "error") {
          const p = refundRpcErrorResponsePayload(
            { message: observed.error },
            {
              route: "admin/cancel",
              stage: "observed",
              orderUuid,
            },
          );
          return NextResponse.json(p.body, { status: p.status });
        }
        log.info("admin.cancel_observed", {
          orderUuid,
          adminId: gate.user.id,
          outcome: observed.outcome,
        });
        if (observed.outcome === "resolved_full") {
          return NextResponse.json({
            ok: true,
            outcome: observed.outcome,
            batchId: observed.batchId ?? null,
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
        const qty = order.credits - order.refunded_credits;
        const { data, error } = await admin.rpc("cancel_intent_resolve", {
          p_admin: gate.user.id,
          p_order_uuid: orderUuid,
          p_qty: qty,
        });
        if (error) {
          const p = refundRpcErrorResponsePayload(error, {
            route: "admin/cancel",
            stage: "resolve",
            orderUuid,
          });
          return NextResponse.json(p.body, { status: p.status });
        }
        const receipt = parseCancelIntentResolveResult(data, qty);
        if (!receipt) {
          return mutationUnconfirmed("resolve_receipt", orderUuid);
        }
        const [requestProof, attemptProof] = await Promise.all([
          requireSupabaseOptionalData(
            "admin.cancel.resolve_request_proof",
            () =>
              admin
                .from("refund_requests")
                .select(
                  "id, origin, scope_order_uuid, requested_qty, approved_amount, state",
                )
                .eq("id", receipt.requestId)
                .maybeSingle(),
          ),
          requireSupabaseOptionalData(
            "admin.cancel.resolve_attempt_proof",
            () =>
              admin
                .from("order_refund_attempts")
                .select(
                  "id, request_id, order_uuid, sequence, qty, amount, state",
                )
                .eq("id", receipt.attemptId)
                .maybeSingle(),
          ),
        ]);
        if (
          !isCancelIntentResolvePostcondition(
            requestProof,
            attemptProof,
            {
              orderUuid,
              requestId: receipt.requestId,
              attemptId: receipt.attemptId,
              qty: receipt.qty,
              amount: receipt.amount,
            },
          )
        ) {
          return mutationUnconfirmed("resolve_postcondition", orderUuid);
        }
        log.info("admin.cancel_refund_prepared", {
          orderUuid,
          adminId: gate.user.id,
          attemptId: receipt.attemptId,
        });
        // 이후 실행(PG 부분취소)은 /api/admin/refund-credits process(auto) 로 진행.
        return NextResponse.json({
          ok: true,
          outcome: "refund_prepared",
          requestId: receipt.requestId,
          attemptId: receipt.attemptId,
          qty: receipt.qty,
          amount: receipt.amount,
        });
      }

      case "READY":
      case "PENDING":
      case "FAILED": {
        // PortOne permits a browser-held paymentId to remain/re-become
        // charge-capable, so a fresh intent is never terminalized locally.
        // 단 시효(PAYMENT_INTENT_EXPIRE_MS)가 지난 미지급 intent 는 결제창 세션이
        // 소멸한 지 한참이라 재청구 실가능성이 없고, 방치하면 사용자 전역 1-intent
        // 잠금이 영구화된다(2026-08-19 실사고) — 방금 단건조회로 비-PAID 를 재확인한
        // 상태에서만 canceled 시효 종단을 허용한다.
        if (
          !order.paid_at &&
          Date.now() - new Date(order.created_at).getTime() >
            PAYMENT_INTENT_EXPIRE_MS
        ) {
          const { data: eData, error: eErr } = await admin.rpc(
            "mark_order_canceled_unpaid",
            {
              p_order_uuid: order.order_uuid,
              p_pg_status: snapshot.status,
              p_pg_tx_id: null,
              p_raw: snapshot.raw,
            },
          );
          if (eErr) {
            const p = refundRpcErrorResponsePayload(eErr, {
              route: "admin/cancel",
              stage: "expire",
              orderUuid,
            });
            return NextResponse.json(p.body, { status: p.status });
          }
          const eResult = parseMarkOrderCanceledUnpaidResult(eData);
          if (!eResult || eResult.outcome === "skipped") {
            return mutationUnconfirmed("expire_receipt", orderUuid);
          }
          log.info("admin.cancel_expired_intent", {
            orderUuid,
            adminId: gate.user.id,
            pgStatus: snapshot.status,
          });
          return NextResponse.json({ ok: true, outcome: "expired" });
        }
        return order.paid_at
          ? NextResponse.json(
              { error: "pg_state_mismatch" },
              { status: 409 },
            )
          : NextResponse.json(
              { error: "pg_state_pending", status: snapshot.status },
              { status: 409 },
            );
      }

      default:
        // VIRTUAL_ACCOUNT_ISSUED·UNRECOGNIZED — 진행형/판정불가. 종단 확정 불가.
        return NextResponse.json(
          { error: "pg_state_pending", status: snapshot.status },
          { status: 409 },
        );
    }
  } catch (error) {
    log.error("admin.cancel_unavailable", {
      orderUuid,
      ...errInfo(
        error instanceof SupabaseOperationError
          ? error.operationError
          : error,
      ),
    });
    return mutationUnconfirmed("dependency_unavailable", orderUuid);
  }
}

/** 무이동 확정 시 로컬 취소 — 미지급(pending 등) 전용(회수 없음). paid 는 RPC 가 use_refund_saga RAISE. */
async function localCancel(
  admin: SupabaseClient,
  adminId: string,
  orderUuid: string,
  reason: string
): Promise<NextResponse> {
  const { data, error } = await admin.rpc("admin_cancel_order", {
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
  if (!parseAdminCancelOrderResult(data)) {
    return mutationUnconfirmed("local_cancel_receipt", orderUuid);
  }
  const proof = await requireSupabaseOptionalData(
    "admin.cancel.local_postcondition",
    () =>
      admin
        .from("orders")
        .select("order_uuid, status, canceled_at, paid_at")
        .eq("order_uuid", orderUuid)
        .maybeSingle(),
  );
  if (
    !proof ||
    typeof proof !== "object" ||
    Array.isArray(proof) ||
    (proof as { order_uuid?: unknown }).order_uuid !== orderUuid ||
    !isCanceledUnpaidPostcondition(proof)
  ) {
    return mutationUnconfirmed("local_cancel_postcondition", orderUuid);
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
    // The database re-verifies the immutable checkout evidence directly from
    // the provider payload. Do not replace it with route-local metadata.
    p_raw: snapshot.raw,
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
  const grantResult = parseMarkPaidAndGrantResult(granted);
  if (grantResult === null) {
    return mutationUnconfirmed("grant_receipt", order.order_uuid);
  }
  if (grantResult === false) {
    // 멱등 skip(동시 처리·금액 불일치 등) — 이후 resolve 가 order_not_paid 등으로 정확히 실패한다.
    log.warn("admin.cancel_grant_noop", { orderUuid: order.order_uuid });
  }
  const current = await requireSupabaseOptionalData(
    "admin.cancel.grant_postcondition",
    () =>
      admin
        .from("orders")
        .select("order_uuid, status, paid_at, error_message")
        .eq("order_uuid", order.order_uuid)
        .maybeSingle(),
  );
  if (
    !current ||
    typeof current !== "object" ||
    Array.isArray(current) ||
    (current as { order_uuid?: unknown }).order_uuid !== order.order_uuid ||
    !parsePaidOrderPostcondition(current)
  ) {
    return mutationUnconfirmed("grant_postcondition", order.order_uuid);
  }
  return null;
}

function mutationUnconfirmed(
  phase: string,
  orderUuid: string,
): NextResponse {
  log.error("admin.cancel_mutation_unconfirmed", { phase, orderUuid });
  return NextResponse.json(
    { error: "action_unconfirmed", retryable: true },
    { status: 503 },
  );
}
