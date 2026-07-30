import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { log, errInfo } from "@/lib/log";
import { deterministicAdminRequestId } from "@/lib/admin-operation-id";
import { parseAdminModerationMutationResult } from "@/lib/admin-mutation";
import { legacyAdminClientRefresh } from "@/lib/admin-client-compat";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MOD_STATES = new Set(["pending", "hidden", "purged", "dismissed"]);

/**
 * 신고 기각 — 이 캐릭터의 대기중 신고를 모두 무효처리(콘텐츠 공개 유지·가역). 캐릭터 단위.
 *   콘텐츠는 안 바뀌므로 표면 무효화 불요(모더레이션 페이지만 client refresh).
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
  const body = requestBody.value as {
    dollId?: string;
    reason?: string;
    expectedState?: string;
    expectedVersion?: number;
  } | null;
  const refresh = legacyAdminClientRefresh("moderationDismiss", body);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  if (
    !body?.dollId ||
    !UUID_RE.test(body.dollId) ||
    !body.expectedState ||
    !MOD_STATES.has(body.expectedState) ||
    !Number.isSafeInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0 ||
    !body.reason
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const reason = body.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  const requestId = deterministicAdminRequestId(
    "moderation_dismiss",
    gate.user.id,
    body.dollId,
    {
      expectedState: body.expectedState,
      expectedVersion: body.expectedVersion,
      reason,
    },
  );
  const { data, error } = await admin.rpc(
    "admin_moderation_action_idempotent",
    {
      p_action: "dismiss",
      p_admin_id: gate.user.id,
      p_doll_id: body.dollId,
      p_reason: reason,
      p_expected_state: body.expectedState,
      p_expected_version: body.expectedVersion,
      p_request_id: requestId,
    },
  );
  if (error) {
    log.warn("admin.dismiss_fail", { dollId: body.dollId, ...errInfo(error) });
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
  const result = parseAdminModerationMutationResult(data);
  if (!result) {
    log.error("admin.dismiss_invalid_result", { dollId: body.dollId });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  log.info("admin.dismiss_ok", {
    dollId: body.dollId,
    adminId: gate.user.id,
    dismissed: result.dismissed,
    noOp: result.noOp,
    version: result.version,
  });
  return NextResponse.json(result);
}
