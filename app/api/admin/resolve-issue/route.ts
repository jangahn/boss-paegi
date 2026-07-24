import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertWriteAllowed } from "@/lib/credits-gate";
import { refundRpcErrorResponsePayload } from "@/lib/refund-saga";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * reconciliation issue 종결 — 관리자만(§B.8.4). admin_resolve_reconciliation_issue 위임.
 * ignore 제한은 RPC 가 강제: SUCCEEDED·진행형 unmatched event 는 ignore 불가(event_requires_resolution),
 * 미종단 event 의 resolved 도 불가(event_still_unmatched — 경제 화해가 선행). 종단 후 재호출은 no_op(200).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  // Phase-A 유지보수 게이트(v0.76 컷오버) — closed 면 신규 종결 진입 차단.
  const maintenance = assertWriteAllowed({ actor: "admin" });
  if (maintenance) return maintenance;

  const body = (await req.json().catch(() => null)) as
    | { issueId?: string; action?: string; note?: string }
    | null;
  const issueId = body?.issueId;
  const action = body?.action;
  const note = body?.note?.trim() ?? "";
  if (!issueId) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (action !== "resolve" && action !== "ignore") {
    return NextResponse.json({ error: "resolution_invalid" }, { status: 400 });
  }
  if (note.length < 5 || note.length > 500) {
    return NextResponse.json({ error: "note_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_resolve_reconciliation_issue", {
    p_issue_id: issueId,
    p_admin: gate.user.id,
    p_resolution: action === "ignore" ? "ignored" : "resolved",
    p_note: note,
  });
  if (error) {
    const p = refundRpcErrorResponsePayload(error, { route: "admin/resolve-issue", issueId });
    return NextResponse.json(p.body, { status: p.status });
  }
  log.info("admin.resolve_issue_ok", { issueId, adminId: gate.user.id, action });
  return NextResponse.json(data ?? { ok: true });
}
