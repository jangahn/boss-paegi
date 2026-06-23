import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

// CS 크레딧 조정 — 관리자만. RPC 가 기존 회원만(upsert 금지)·범위(-100~100,≠0)·사유 검증.
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as {
    targetUserId?: string;
    delta?: number;
    reason?: string;
  } | null;
  if (!body?.targetUserId || typeof body?.delta !== "number" || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_adjust_credits", {
    p_admin: gate.user.id,
    p_target: body.targetUserId,
    p_delta: Math.trunc(body.delta),
    p_reason: body.reason.trim(),
  });
  if (error) {
    log.warn("admin.adjust_fail", { targetUserId: body.targetUserId, adminId: gate.user.id, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  log.info("admin.adjust_ok", { targetUserId: body.targetUserId, adminId: gate.user.id, delta: Math.trunc(body.delta) });
  return NextResponse.json(data ?? { ok: true });
}
