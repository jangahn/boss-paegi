import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { deterministicAdminRequestId } from "@/lib/admin-operation-id";
import { parseAdminIntegrityMutationResult } from "@/lib/admin-mutation";
import { legacyAdminClientRefresh } from "@/lib/admin-client-compat";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEMBER_STATES = new Set(["clean", "flagged", "banned"]);

/** 유저 정지 해제 — member status 만 clean. 기존 voided 점수는 자동복구 안 함(score 별 clear 별도). */
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
  const body = requestBody.value as {
    memberId?: string;
    reason?: string;
    expectedState?: string;
    expectedVersion?: number;
  } | null;
  const refresh = legacyAdminClientRefresh("integrityUnban", body);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  const reason = (body?.reason ?? "").trim();
  if (
    !body?.memberId ||
    !UUID_RE.test(body.memberId) ||
    !body.expectedState ||
    !MEMBER_STATES.has(body.expectedState) ||
    !Number.isSafeInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0 ||
    reason.length < 5 ||
    reason.length > 500
  ) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }
  const requestId = deterministicAdminRequestId(
    "integrity_unban",
    gate.user.id,
    body.memberId,
    {
      expectedState: body.expectedState,
      expectedVersion: body.expectedVersion,
      reason,
    },
  );
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("admin_integrity_action_idempotent", {
    p_action: "unban",
    p_admin_id: gate.user.id,
    p_target_id: body.memberId,
    p_reason: reason,
    p_expected_state: body.expectedState,
    p_expected_version: body.expectedVersion,
    p_request_id: requestId,
  });
  if (error) {
    log.warn("admin.integrity.unban_fail", {
      memberId: body.memberId,
      ...errInfo(error),
    });
    const code = adminRpcErrorCode(error);
    return NextResponse.json(
      { error: code },
      {
        status:
          code === "state_conflict"
            ? 409
            : code === "action_failed"
              ? 500
              : 400,
      },
    );
  }
  const result = parseAdminIntegrityMutationResult(data);
  if (!result) {
    log.error("admin.integrity.unban_invalid_result", {
      memberId: body.memberId,
    });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  log.info("admin.integrity.unban_ok", {
    memberId: body.memberId,
    adminId: gate.user.id,
    noOp: result.noOp,
    version: result.version,
  });
  return NextResponse.json(result);
}
