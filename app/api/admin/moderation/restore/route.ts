import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { revalidateDollSurfaces } from "@/lib/moderation-revalidate";
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
 * doll 복구 (Phase 2) — takedown 의 가역 되돌리기. RPC 가 deleted_at=null + **이 doll 의 takedown 이
 *   숨긴 하이라이트만** 되살림(만료 등 다른 숨김 불간섭). 영구삭제(artifacts_purged_at)된 건 객체가
 *   없어 복구 불가(RPC already_purged → 400). 신고는 actioned 유지(복구는 새 결정).
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
  const refresh = legacyAdminClientRefresh("moderationRestore", body);
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
  const dollId = body.dollId;
  const admin = createAdminClient();
  const requestId = deterministicAdminRequestId(
    "moderation_restore",
    gate.user.id,
    dollId,
    {
      expectedState: body.expectedState,
      expectedVersion: body.expectedVersion,
      reason,
    },
  );

  const { data, error } = await admin.rpc(
    "admin_moderation_action_idempotent",
    {
      p_action: "restore",
      p_admin_id: gate.user.id,
      p_doll_id: dollId,
      p_reason: reason,
      p_expected_state: body.expectedState,
      p_expected_version: body.expectedVersion,
      p_request_id: requestId,
    },
  );
  if (error) {
    log.warn("admin.restore_fail", { dollId, ...errInfo(error) });
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
    log.error("admin.restore_invalid_result", { dollId });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }

  // 복구된 얼굴이 다시 보이도록 표면 ISR 캐시 무효화.
  await revalidateDollSurfaces(admin, dollId);

  log.info("admin.restore_ok", {
    dollId,
    adminId: gate.user.id,
    noOp: result.noOp,
    version: result.version,
  });
  return NextResponse.json(result);
}
