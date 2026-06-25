import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 회원 재활성(탈퇴 복구) — 본인 요청 시 운영자가 **계정만** 복구. 관리자만.
 * `admin_reactivate_account`(0037): profiles.deleted_at 해제 + identities 원본 닉/프사/이메일 복원
 * + 재동의 트리거. 캐릭터·하이라이트·생성권은 이미 영구삭제 → 복구되지 않음.
 * RPC 예외(not_withdrawn/email_conflict/identity_email_missing/reason_invalid)는 화이트리스트로 노출.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as
    | { userId?: string; reason?: string; emailOverride?: string }
    | null;
  if (!body?.userId || !UUID_RE.test(body.userId) || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const reason = body.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }
  const emailOverride = body.emailOverride?.trim() || null;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_reactivate_account", {
    p_user_id: body.userId,
    p_admin: gate.user.id,
    p_reason: reason,
    p_email_override: emailOverride,
  });
  if (error) {
    const code = adminRpcErrorCode(error);
    log.warn("admin.reactivate_fail", { userId: body.userId, code, ...errInfo(error) });
    return NextResponse.json(
      { error: code },
      { status: code === "action_failed" ? 500 : 400 }
    );
  }
  log.info("admin.reactivate_success", { userId: body.userId, adminId: gate.user.id });
  return NextResponse.json({ ok: true, ...(data as Record<string, unknown>) });
}
