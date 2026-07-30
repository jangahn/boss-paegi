import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import {
  getPortonePaymentSnapshot,
  portoneCancelConfigured,
} from "@/lib/portone";
import { log, errInfo } from "@/lib/log";
import { deterministicAdminRequestId } from "@/lib/admin-operation-id";
import {
  isAdminSettlementReceiptProof,
  parseAdminSettlementMutationResult,
  parseAdminSettlementReceipt,
} from "@/lib/admin-mutation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { classifyPortoneEvidenceForRollout } from "@/lib/pay/payment-evidence";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * stuck 주문 수동 지급 — 관리자만. 페이앱 시절 '콘솔 육안 확인' 절차를 포트원 단건 조회 검증으로 대체:
 * 지급 전에 서버가 직접 PAID + immutable evidence exact 를 확인해야 RPC 를 호출한다
 * (휴먼에러로 미결제·다른 store/channel 건 지급 차단).
 */
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
  const body = requestBody.value as {
    orderUuid?: string;
    reason?: string;
  } | null;
  const reason = body?.reason?.trim() ?? "";
  if (
    !body?.orderUuid ||
    !UUID_RE.test(body.orderUuid) ||
    reason.length < 5 ||
    reason.length > 500
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const admin = createAdminClient();
  const requestId = deterministicAdminRequestId(
    "order_settle",
    gate.user.id,
    body.orderUuid,
    { orderUuid: body.orderUuid, reason },
  );

  // Response-loss recovery must happen before another external PG read. The
  // exact payload-bound receipt is authoritative proof that the previous
  // PortOne verification and financial commit both completed.
  const { data: receiptData, error: receiptError } = await admin.rpc(
    "get_admin_settlement_receipt",
    {
      p_admin: gate.user.id,
      p_order_uuid: body.orderUuid,
      p_reason: reason,
      p_request_id: requestId,
    },
  );
  if (receiptError) {
    const code = adminRpcErrorCode(receiptError);
    log.warn("admin.settle_receipt_fail", {
      orderUuid: body.orderUuid,
      code,
      ...errInfo(receiptError),
    });
    return NextResponse.json(
      { error: code },
      {
        status:
          code === "idempotency_conflict" || code === "request_aborted"
            ? 409
            : code === "action_failed"
              ? 500
              : 400,
      },
    );
  }
  const receipt = parseAdminSettlementReceipt(receiptData);
  if (!receipt) {
    log.error("admin.settle_receipt_invalid", {
      orderUuid: body.orderUuid,
    });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  if (receipt.found) {
    log.info("admin.settle_recovered", {
      orderUuid: body.orderUuid,
      adminId: gate.user.id,
    });
    return NextResponse.json(receipt.result);
  }

  // 지급 전 검증 — 주문 로드 → 포트원 단건 조회 → PAID + 금액 일치 확인.
  const { data: order, error: loadErr } = await admin
    .from("orders")
    .select(
      "order_uuid, status, amount, payment_id, provider, is_test, expected_store_id, expected_currency, expected_channel_key",
    )
    .eq("order_uuid", body.orderUuid)
    .maybeSingle();
  if (loadErr) {
    log.warn("admin.settle_load_fail", { orderUuid: body.orderUuid, ...errInfo(loadErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 503 });
  }
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  const checkedOrder = validateAdminRows<{
    order_uuid: string;
    status: string;
    amount: number;
    payment_id: string | null;
    provider: string | null;
    is_test: boolean;
    expected_store_id: string | null;
    expected_currency: string | null;
    expected_channel_key: string | null;
  }>("admin.settle.order", [order], {
    order_uuid: "uuid",
    status: "string",
    amount: "nonnegativeInteger",
    payment_id: "nullableString",
    provider: "nullableString",
    is_test: "boolean",
    expected_store_id: "nullableString",
    expected_currency: "nullableString",
    expected_channel_key: "nullableString",
  })[0]!;
  if (
    checkedOrder.provider !== "portone" ||
    !checkedOrder.payment_id ||
    !["pending", "failed"].includes(checkedOrder.status) ||
    checkedOrder.amount <= 0
  ) {
    return NextResponse.json({ error: "not_settleable" }, { status: 400 });
  }
  if (!portoneCancelConfigured()) {
    return NextResponse.json({ error: "pg_unavailable" }, { status: 503 });
  }
  const got = await getPortonePaymentSnapshot(
    checkedOrder.payment_id,
    checkedOrder.expected_store_id ?? undefined,
  );
  if (!got.ok) {
    if (got.kind === "not_found") {
      return NextResponse.json(
        { error: "not_paid", message: "포트원에 결제 건이 없어요(미결제 이탈) — 지급 대상이 아니에요." },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { error: "pg_unreachable", message: "포트원 조회 실패 — 잠시 후 재시도하세요." },
      { status: 502 }
    );
  }
  const snapshot = got.snapshot;
  if (snapshot.status !== "PAID") {
    return NextResponse.json(
      { error: "not_paid", message: `포트원 상태가 PAID 가 아니에요(${snapshot.status}) — 지급 불가.` },
      { status: 400 }
    );
  }
  const evidence = classifyPortoneEvidenceForRollout(
    snapshot,
    checkedOrder,
  );
  if (evidence.kind === "mismatch") {
    log.error("admin.settle_evidence_mismatch", {
      orderUuid: checkedOrder.order_uuid,
      reason: evidence.reason,
    });
    return NextResponse.json(
      { error: "payment_evidence_mismatch", reason: evidence.reason },
      { status: 409 },
    );
  }
  if (evidence.kind === "legacy_deferred") {
    log.warn("admin.settle_legacy_evidence_deferred", {
      orderUuid: checkedOrder.order_uuid,
      paymentId: checkedOrder.payment_id,
    });
    // Manual settlement is still a money grant. An unbackfilled legacy tuple
    // cannot be elevated by administrator intent alone.
    return NextResponse.json(
      { error: "payment_evidence_incomplete" },
      { status: 503 },
    );
  }
  const paidAt =
    typeof snapshot.raw.paidAt === "string" &&
    Number.isFinite(Date.parse(snapshot.raw.paidAt))
      ? snapshot.raw.paidAt
      : null;
  const transactionId =
    typeof snapshot.raw.transactionId === "string" &&
    snapshot.raw.transactionId.length > 0 &&
    snapshot.raw.transactionId.length <= 500
      ? snapshot.raw.transactionId
      : null;
  if (!paidAt || !transactionId) {
    return NextResponse.json(
      { error: "payment_evidence_incomplete" },
      { status: 503 },
    );
  }

  const { data, error } = await admin.rpc("admin_settle_stuck_order_verified", {
    p_admin: gate.user.id,
    p_order_uuid: body.orderUuid,
    p_reason: reason,
    p_request_id: requestId,
    p_paid_at: paidAt,
    p_pg_tx_id: transactionId,
    p_receipt_url:
      typeof snapshot.raw.receiptUrl === "string"
        ? snapshot.raw.receiptUrl
        : null,
    p_raw: snapshot.raw,
  });
  if (error) {
    log.warn("admin.settle_fail", { orderUuid: body.orderUuid, adminId: gate.user.id, ...errInfo(error) });
    const code = adminRpcErrorCode(error);
    return NextResponse.json(
      { error: code },
      { status: code === "action_failed" ? 500 : 400 },
    );
  }
  const result = parseAdminSettlementMutationResult(data);
  if (!result) {
    log.error("admin.settle_invalid_result", {
      orderUuid: body.orderUuid,
      adminId: gate.user.id,
    });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  const { data: proofData, error: proofError } = await admin.rpc(
    "get_admin_settlement_receipt",
    {
      p_admin: gate.user.id,
      p_order_uuid: body.orderUuid,
      p_reason: reason,
      p_request_id: requestId,
    },
  );
  const proof = proofError
    ? null
    : parseAdminSettlementReceipt(proofData);
  if (!proof || !isAdminSettlementReceiptProof(proof, result)) {
    log.error("admin.settle_postcondition_unconfirmed", {
      orderUuid: body.orderUuid,
      adminId: gate.user.id,
      ...errInfo(proofError),
    });
    return NextResponse.json(
      { error: "action_unconfirmed" },
      { status: 503 },
    );
  }
  log.info("admin.settle_ok", {
    orderUuid: body.orderUuid,
    adminId: gate.user.id,
    quarantined: result.quarantined,
    requestedCredits: result.requestedCredits,
    grantedCredits: result.credits,
    noOp: result.noOp,
  });
  return NextResponse.json(result);
}
