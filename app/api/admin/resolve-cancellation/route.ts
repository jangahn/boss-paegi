import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { assertWriteAllowed } from "@/lib/credits-gate";
import { refundRpcErrorResponsePayload } from "@/lib/refund-saga";
import { log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 외부(콘솔 등) 취소 event 의 경제 화해 — 관리자만(§B.8.3).
 * resolve_external_cancellation RPC 위임: 회수·shortfall·원장·event 종결·연결 issue 해소를
 * DB 가 원자 수행. economicQty 미지정(null)이면 RPC 가 비례 역산, 멱등(동일 값 재호출 no_op).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  // Phase-A 유지보수 게이트(v0.76 컷오버) — closed 면 신규 화해 진입 차단.
  const maintenance = assertWriteAllowed({ actor: "admin" });
  if (maintenance) return maintenance;

  const body = (await req.json().catch(() => null)) as
    | { cancellationId?: string; note?: string; economicQty?: number }
    | null;
  const cancellationId = body?.cancellationId;
  const note = body?.note?.trim() ?? "";
  if (!cancellationId || typeof cancellationId !== "string") {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (note.length < 5 || note.length > 500) {
    return NextResponse.json({ error: "note_invalid" }, { status: 400 });
  }
  const economicQty = body?.economicQty;
  if (
    economicQty !== undefined && economicQty !== null &&
    (!Number.isInteger(economicQty) || economicQty < 0)
  ) {
    return NextResponse.json({ error: "qty_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("resolve_external_cancellation", {
    p_cancellation_id: cancellationId,
    p_resolved_by: gate.user.id,
    p_note: note,
    p_economic_qty: economicQty ?? null,
  });
  if (error) {
    const p = refundRpcErrorResponsePayload(error, {
      route: "admin/resolve-cancellation", cancellationId,
    });
    return NextResponse.json(p.body, { status: p.status });
  }
  log.info("admin.resolve_cancellation_ok", { cancellationId, adminId: gate.user.id });
  return NextResponse.json(data ?? { ok: true });
}
