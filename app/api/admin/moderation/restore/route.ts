import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { revalidateDollSurfaces } from "@/lib/moderation-revalidate";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * doll 복구 (Phase 2) — takedown 의 가역 되돌리기. RPC 가 deleted_at=null + **이 doll 의 takedown 이
 *   숨긴 하이라이트만** 되살림(만료 등 다른 숨김 불간섭). 영구삭제(artifacts_purged_at)된 건 객체가
 *   없어 복구 불가(RPC already_purged → 400). 신고는 actioned 유지(복구는 새 결정).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as
    | { dollId?: string; reason?: string }
    | null;
  if (!body?.dollId || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const reason = body.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }
  const dollId = body.dollId;
  const admin = createAdminClient();

  const { data, error } = await admin.rpc("admin_restore_doll", {
    p_admin_id: gate.user.id,
    p_doll_id: dollId,
    p_reason: reason,
  });
  if (error) {
    log.warn("admin.restore_fail", { dollId, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  const result = (data ?? {}) as { already_active?: boolean };

  // 복구된 얼굴이 다시 보이도록 표면 ISR 캐시 무효화.
  await revalidateDollSurfaces(admin, dollId);

  log.info("admin.restore_ok", {
    dollId,
    adminId: gate.user.id,
    alreadyActive: !!result.already_active,
  });
  return NextResponse.json({ ok: true, already_active: !!result.already_active });
}
