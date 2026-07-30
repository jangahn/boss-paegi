import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isExternalCancellationResolutionPostcondition,
  parseExternalCancellationResolutionResult,
} from "@/lib/pay/refund-mutation-result";
import { refundRpcErrorResponsePayload } from "@/lib/refund-saga";
import {
  requireSupabaseExactCount,
  requireSupabaseOptionalData,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { errInfo, log } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 외부(콘솔 등) 취소 event 의 경제 화해 — 관리자만(§B.8.3).
 * resolve_external_cancellation RPC 위임: 회수·shortfall·원장·event 종결·연결 issue 해소를
 * DB 가 원자 수행. economicQty 미지정(null)이면 RPC 가 비례 역산, 멱등(동일 값 재호출 no_op).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as
    | { cancellationId?: string; note?: string; economicQty?: number }
    | null;
  const cancellationId = body?.cancellationId;
  const note = body?.note?.trim() ?? "";
  if (
    !cancellationId ||
    typeof cancellationId !== "string" ||
    cancellationId.length > 256 ||
    cancellationId !== cancellationId.trim() ||
    /[\u0000-\u001f\u007f]/.test(cancellationId)
  ) {
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
  const expectedEconomicQty = economicQty ?? null;
  try {
    const { data, error } = await admin.rpc("resolve_external_cancellation", {
      p_cancellation_id: cancellationId,
      p_resolved_by: gate.user.id,
      p_note: note,
      p_economic_qty: expectedEconomicQty,
    });
    if (error) {
      const p = refundRpcErrorResponsePayload(error, {
        route: "admin/resolve-cancellation",
        cancellationId,
      });
      return NextResponse.json(p.body, { status: p.status });
    }
    const receipt = parseExternalCancellationResolutionResult(
      data,
      expectedEconomicQty,
    );
    if (!receipt) {
      return unconfirmed(cancellationId, "invalid_receipt");
    }
    const [proof, openIssueCount] = await Promise.all([
      requireSupabaseOptionalData(
        "admin.resolve_cancellation.proof",
        () =>
          admin
            .from("payment_cancellation_events")
            .select(
              "cancellation_id, resolution_state, resolved_economic_qty, resolved_at",
            )
            .eq("cancellation_id", cancellationId)
            .maybeSingle(),
      ),
      requireSupabaseExactCount(
        "admin.resolve_cancellation.issue_postcondition",
        () =>
          admin
            .from("reconciliation_issues")
            .select("id", { count: "exact", head: true })
            .eq("cancellation_id", cancellationId)
            .eq("type", "unmatched_cancellation")
            .eq("state", "open"),
      ),
    ]);
    if (
      !isExternalCancellationResolutionPostcondition(proof, {
        cancellationId,
        economicQty: expectedEconomicQty,
      }) ||
      openIssueCount !== 0
    ) {
      return unconfirmed(cancellationId, "postcondition_mismatch");
    }
    log.info("admin.resolve_cancellation_ok", {
      cancellationId,
      adminId: gate.user.id,
    });
    return NextResponse.json({
      ok: true,
      outcome: receipt.kind === "no_op" ? "no_op" : "resolved",
      ...(receipt.kind === "no_op"
        ? { idempotent: true }
        : { result: receipt.result }),
      cancellation_id: cancellationId,
    });
  } catch (error) {
    log.error("admin.resolve_cancellation_unavailable", {
      cancellationId,
      ...errInfo(
        error instanceof SupabaseOperationError
          ? error.operationError
          : error,
      ),
    });
    return unconfirmed(cancellationId, "dependency_unavailable");
  }
}

function unconfirmed(cancellationId: string, phase: string): NextResponse {
  log.error("admin.resolve_cancellation_unconfirmed", {
    cancellationId,
    phase,
  });
  return NextResponse.json(
    { error: "action_unconfirmed", retryable: true },
    { status: 503 },
  );
}
