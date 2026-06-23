import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

// stuck 주문 수동 지급 — 관리자만. 페이앱 결제완료 확인 후 사용(RPC 가 pending+mul_no 만 허용).
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
