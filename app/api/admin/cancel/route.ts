import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { paycancelOrder, payappCancelConfigured } from "@/lib/payapp";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 오래된 결제요청(pending) 취소 — 페이앱 `paycancel` 실연동(실제 취소/환불) + 로컬 canceled 표시.
 * pending 전용(paid 환불은 /api/admin/refund). pending 은 지급된 크레딧이 없어 회수 없음(clawback=false).
 * paycancel: 결제됐던 건이면 환불, 미승인 요청이면 요청 취소(매뉴얼 2.3). LINKKEY 미설정/mul_no 없으면 로컬 표시만(폴백).
 * ⚠️ paycancel 응답 문구 분류(allowlist)는 lib/payapp.ts — dev 라이브 확인으로 확정 필요(미스 시 안전 실패).
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
    .from("payapp_orders")
    .select("status, mul_no")
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

  const usePayapp = !!order.mul_no && payappCancelConfigured();

  // 1) 페이앱 실취소(가능할 때). 성공해야 로컬 canceled 진행.
  if (usePayapp) {
    const pc = await paycancelOrder({ mulNo: order.mul_no!, cancelMemo: reason });
    if (!pc.ok) {
      if (pc.kind === "settled") {
        return NextResponse.json(
          {
            manual: true,
            error: "manual_required",
            message: "정산 마감 등으로 페이앱 자동 취소 불가 — 페이앱 콘솔에서 처리 후 확인하세요.",
          },
          { status: 200 }
        );
      }
      if (pc.kind === "unknown") {
        return NextResponse.json(
          { error: "unknown_cancel_state", message: "페이앱 취소 응답 확인 필요 — 페이앱 콘솔 확인 후 재시도하세요." },
          { status: 502 }
        );
      }
      return NextResponse.json(
        { error: "payapp_unreachable", message: "페이앱 연결 실패 — 잠시 후 재시도하세요." },
        { status: 502 }
      );
    }
  }

  // 2) 로컬 canceled 표시(pending → 회수 없음). 페이앱 취소 성공이면 payapp_done=true.
  const { data, error } = await admin.rpc("admin_cancel_order", {
    p_admin: gate.user.id,
    p_order_uuid: orderUuid,
    p_clawback: false,
    p_reason: reason,
    p_payapp_done: usePayapp,
  });
  if (error) {
    log.warn("admin.cancel_fail", { orderUuid, adminId: gate.user.id, payapp: usePayapp, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  log.info("admin.cancel_ok", { orderUuid, adminId: gate.user.id, payapp: usePayapp });
  return NextResponse.json({ ...(data as Record<string, unknown>), payapp: usePayapp });
}
