import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { cancelPortonePayment, portoneCancelConfigured } from "@/lib/portone";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 오래된 결제요청(pending) 취소 — 포트원 취소 API(실제 취소/환불) + 로컬 canceled 표시.
 * pending 전용(paid 환불은 /api/admin/refund). pending 은 지급된 크레딧이 없어 회수 없음(clawback=false).
 * 미승인 pending 은 포트원에 결제 건 자체가 없을 수 있음(PAYMENT_NOT_FOUND) → 로컬 표시만으로 충분.
 * 시크릿 미설정/paymentId 없음이면 로컬 표시만(폴백).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as
    | { orderUuid?: string; reason?: string }
    | null;
  if (!body?.orderUuid || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const orderUuid = body.orderUuid;
  const reason = body.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: order, error: loadErr } = await admin
    .from("orders")
    .select("status, payment_id, provider")
    .eq("order_uuid", orderUuid)
    .maybeSingle();
  if (loadErr) {
    log.warn("admin.cancel_load_fail", { orderUuid, ...errInfo(loadErr) });
    return NextResponse.json({ error: "action_failed" }, { status: 400 });
  }
  if (!order) return NextResponse.json({ error: "order_not_found" }, { status: 404 });
  if (order.status !== "pending") {
    // paid 환불은 /api/admin/refund. 이미 canceled/failed 면 취소 불가.
    return NextResponse.json(
      { error: order.status === "paid" ? "use_refund" : "not_cancelable" },
      { status: 400 }
    );
  }

  const usePg =
    order.provider === "portone" && !!order.payment_id && portoneCancelConfigured();

  // 1) 포트원 실취소(가능할 때). 미결제 pending 은 PAYMENT_NOT_FOUND 로 떨어지므로 로컬 취소로 폴백.
  let pgDone = false;
  if (usePg) {
    const pc = await cancelPortonePayment({ paymentId: order.payment_id!, reason });
    if (pc.ok) {
      pgDone = true;
    } else if (
      pc.kind === "unknown" &&
      (pc.error === "PAYMENT_NOT_FOUND" || pc.error === "PAYMENT_NOT_PAID")
    ) {
      // 결제 시도가 없거나(NOT_FOUND) 결제창만 열고 이탈(NOT_PAID·READY) — 외부 취소 대상 없음.
      // pending 전용 라우트라 지급된 크레딧이 없어 로컬 표시만으로 안전.
      pgDone = false;
    } else if (pc.kind === "unknown") {
      return NextResponse.json(
        { error: "unknown_cancel_state", message: `포트원 취소 응답 확인 필요(${pc.error}) — 콘솔 확인 후 재시도하세요.` },
        { status: 502 }
      );
    } else {
      return NextResponse.json(
        { error: "pg_unreachable", message: "포트원 연결 실패 — 잠시 후 재시도하세요." },
        { status: 502 }
      );
    }
  }

  // 2) 로컬 canceled 표시(pending → 회수 없음). 포트원 취소 성공이면 pg_done=true.
  const { data, error } = await admin.rpc("admin_cancel_order", {
    p_admin: gate.user.id,
    p_order_uuid: orderUuid,
    p_clawback: false,
    p_reason: reason,
    p_pg_done: pgDone,
  });
  if (error) {
    log.warn("admin.cancel_fail", { orderUuid, adminId: gate.user.id, pg: pgDone, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  log.info("admin.cancel_ok", { orderUuid, adminId: gate.user.id, pg: pgDone });
  return NextResponse.json({ ...(data as Record<string, unknown>), pg: pgDone });
}
