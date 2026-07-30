import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  isReconciliationIssueResolutionPostcondition,
  parseReconciliationIssueResolutionResult,
} from "@/lib/pay/refund-mutation-result";
import { refundRpcErrorResponsePayload } from "@/lib/refund-saga";
import {
  requireSupabaseOptionalData,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { errInfo, log } from "@/lib/log";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * reconciliation issue 종결 — 관리자만(§B.8.4). admin_resolve_reconciliation_issue 위임.
 * ignore 제한은 RPC 가 강제: SUCCEEDED·진행형 unmatched event 는 ignore 불가(event_requires_resolution),
 * 미종단 event 의 resolved 도 불가(event_still_unmatched — 경제 화해가 선행). 종단 후 재호출은 no_op(200).
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
    | { issueId?: string; action?: string; note?: string }
    | null;
  const issueId = body?.issueId;
  const action = body?.action;
  const note = body?.note?.trim() ?? "";
  if (!issueId || !UUID_RE.test(issueId)) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (action !== "resolve" && action !== "ignore") {
    return NextResponse.json({ error: "resolution_invalid" }, { status: 400 });
  }
  if (note.length < 5 || note.length > 500) {
    return NextResponse.json({ error: "note_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  const expectedState = action === "ignore" ? "ignored" : "resolved";
  try {
    const { data, error } = await admin.rpc(
      "admin_resolve_reconciliation_issue",
      {
        p_issue_id: issueId,
        p_admin: gate.user.id,
        p_resolution: expectedState,
        p_note: note,
      },
    );
    if (error) {
      const p = refundRpcErrorResponsePayload(error, {
        route: "admin/resolve-issue",
        issueId,
      });
      return NextResponse.json(p.body, { status: p.status });
    }
    const receipt = parseReconciliationIssueResolutionResult(
      data,
      expectedState,
    );
    if (!receipt) {
      return unconfirmed(issueId, "invalid_receipt");
    }
    const proof = await requireSupabaseOptionalData(
      "admin.resolve_issue.proof",
      () =>
        admin
          .from("reconciliation_issues")
          .select("id, state, resolved_at, resolution_source")
          .eq("id", issueId)
          .maybeSingle(),
    );
    if (
      !isReconciliationIssueResolutionPostcondition(proof, {
        issueId,
        state: expectedState,
      })
    ) {
      return unconfirmed(issueId, "postcondition_mismatch");
    }
    log.info("admin.resolve_issue_ok", {
      issueId,
      adminId: gate.user.id,
      action,
    });
    return NextResponse.json({
      ok: true,
      outcome: receipt === "no_op" ? "no_op" : expectedState,
      ...(receipt === "no_op" ? { idempotent: true } : {}),
      issue_id: issueId,
    });
  } catch (error) {
    log.error("admin.resolve_issue_unavailable", {
      issueId,
      ...errInfo(
        error instanceof SupabaseOperationError
          ? error.operationError
          : error,
      ),
    });
    return unconfirmed(issueId, "dependency_unavailable");
  }
}

function unconfirmed(issueId: string, phase: string): NextResponse {
  log.error("admin.resolve_issue_unconfirmed", { issueId, phase });
  return NextResponse.json(
    { error: "action_unconfirmed", retryable: true },
    { status: 503 },
  );
}
