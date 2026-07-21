import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { getPortonePayment, portoneCancelConfigured } from "@/lib/portone";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * stuck 주문 수동 지급 — 관리자만. 페이앱 시절 '콘솔 육안 확인' 절차를 포트원 단건 조회 검증으로 대체:
 * 지급 전에 서버가 직접 PAID + 금액 일치를 확인해야 RPC 를 호출한다(휴먼에러로 미결제 건 지급 차단).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as {
    orderUuid?: string;
    reason?: string;
  } | null;
  if (!body?.orderUuid || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const admin = createAdminClient();

  // 지급 전 검증 — 주문 로드 → 포트원 단건 조회 → PAID + 금액 일치 확인.
  const { data: order, error: loadErr } = await admin
    .from("orders")
    .select("order_uuid, status, amount, payment_id, provider")
    .eq("order_uuid", body.orderUuid)
    .maybeSingle();
  if (loadErr) {
    log.warn("admin.settle_load_fail", { orderUuid: body.orderUuid, ...errInfo(loadErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 400 });
  }
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  if (order.provider !== "portone" || !order.payment_id) {
    return NextResponse.json({ error: "not_settleable" }, { status: 400 });
  }
  if (!portoneCancelConfigured()) {
    return NextResponse.json({ error: "pg_unavailable" }, { status: 503 });
  }
  const got = await getPortonePayment(order.payment_id);
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
  if (got.payment.status !== "PAID") {
    return NextResponse.json(
      { error: "not_paid", message: `포트원 상태가 PAID 가 아니에요(${got.payment.status}) — 지급 불가.` },
      { status: 400 }
    );
  }
  if ((got.payment.amount?.total ?? -1) !== order.amount) {
    log.error("admin.settle_amount_mismatch", {
      orderUuid: order.order_uuid,
      got: got.payment.amount?.total,
      expected: order.amount,
    });
    return NextResponse.json({ error: "amount_mismatch" }, { status: 400 });
  }

  const { data, error } = await admin.rpc("admin_settle_stuck_order", {
    p_admin: gate.user.id,
    p_order_uuid: body.orderUuid,
    p_reason: body.reason.trim(),
  });
  if (error) {
    log.warn("admin.settle_fail", { orderUuid: body.orderUuid, adminId: gate.user.id, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  log.info("admin.settle_ok", { orderUuid: body.orderUuid, adminId: gate.user.id });
  return NextResponse.json(data ?? { ok: true });
}
