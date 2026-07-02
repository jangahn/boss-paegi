import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { revalidatePath } from "next/cache";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/** 점수 정상 확인 → cleared(공개면 노출·cron 재flag 방지). */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as { scoreId?: string; reason?: string } | null;
  const reason = (body?.reason ?? "").trim();
  if (!body?.scoreId || reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_clear_score", {
    p_admin_id: gate.user.id,
    p_score_id: body.scoreId,
    p_reason: reason,
  });
  if (error) {
    log.warn("admin.integrity.clear_fail", { scoreId: body.scoreId, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  revalidatePath("/leaderboard");
  log.info("admin.integrity.clear_ok", { scoreId: body.scoreId, adminId: gate.user.id });
  return NextResponse.json({ ok: true, ...(data as object) });
}
