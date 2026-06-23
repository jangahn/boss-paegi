import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

// 주문 환불/취소 표시 — 관리자만. RPC 가 멱등(이미 canceled=error), 회수는 0까지만.
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as {
    orderUuid?: string;
    clawback?: boolean;
    reason?: string;
  } | null;
  if (!body?.orderUuid || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_cancel_order", {
    p_admin: gate.user.id,
    p_order_uuid: body.orderUuid,
    p_clawback: body.clawback === true,
    p_reason: body.reason.trim(),
  });
  if (error) {
    log.warn("admin.cancel_fail", { orderUuid: body.orderUuid, adminId: gate.user.id, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  log.info("admin.cancel_ok", { orderUuid: body.orderUuid, adminId: gate.user.id, clawback: body.clawback === true });
  return NextResponse.json(data ?? { ok: true });
}
