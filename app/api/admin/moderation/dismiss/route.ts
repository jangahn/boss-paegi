import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/** 신고 기각 — 콘텐츠 유지(가역). 신고 1건 단위. */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as
    | { reportId?: string; reason?: string }
    | null;
  if (!body?.reportId || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const reason = body.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { error } = await admin.rpc("admin_dismiss_report", {
    p_admin_id: gate.user.id,
    p_report_id: body.reportId,
    p_reason: reason,
  });
  if (error) {
    log.warn("admin.dismiss_fail", { reportId: body.reportId, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  log.info("admin.dismiss_ok", { reportId: body.reportId, adminId: gate.user.id });
  return NextResponse.json({ ok: true });
}
