import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/** 유저 정지 해제 — member status 만 clean. 기존 voided 점수는 자동복구 안 함(score 별 clear 별도). */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as { memberId?: string; reason?: string } | null;
  const reason = (body?.reason ?? "").trim();
  if (!body?.memberId || reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_unban_member", {
    p_admin_id: gate.user.id,
    p_member_id: body.memberId,
    p_reason: reason,
  });
  if (error) {
    log.warn("admin.integrity.unban_fail", { memberId: body.memberId, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  log.info("admin.integrity.unban_ok", { memberId: body.memberId, adminId: gate.user.id });
  return NextResponse.json({ ok: true, ...(data as object) });
}
