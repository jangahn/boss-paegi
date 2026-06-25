import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 신고 기각 — 이 캐릭터의 대기중 신고를 모두 무효처리(콘텐츠 공개 유지·가역). 캐릭터 단위.
 *   콘텐츠는 안 바뀌므로 표면 무효화 불요(모더레이션 페이지만 client refresh).
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

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_dismiss_doll", {
    p_admin_id: gate.user.id,
    p_doll_id: body.dollId,
    p_reason: reason,
  });
  if (error) {
    log.warn("admin.dismiss_fail", { dollId: body.dollId, ...errInfo(error) });
    return NextResponse.json({ error: adminRpcErrorCode(error) }, { status: 400 });
  }
  const result = (data ?? {}) as { dismissed?: number };
  log.info("admin.dismiss_ok", {
    dollId: body.dollId,
    adminId: gate.user.id,
    dismissed: result.dismissed ?? 0,
  });
  return NextResponse.json({ ok: true, dismissed: result.dismissed ?? 0 });
}
