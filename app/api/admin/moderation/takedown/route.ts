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
 * doll takedown (Phase 2 — **가역**). private 버킷이라 RPC 의 soft-delete(deleted_at) 만으로
 *   신규 signed URL 발급이 중단(=앱 표면에서 invisible). storage 객체는 **물리삭제하지 않음**
 *   → 오삭제 복구(restore) 가능. 영구 제거는 별도 permanent-delete 라우트.
 * ⚠️ 이미 발급된 signed URL 은 TTL(doll 10분/clip 15분) 동안 생존 — "즉시 차단" 아님(신규 발급 중단).
 * 멱등: 이미 삭제된 doll 도 ok(already_deleted).
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
  const refresh = legacyAdminClientRefresh("moderationTakedown", body);
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
    "moderation_takedown",
    gate.user.id,
    dollId,
    {
      expectedState: body.expectedState,
      expectedVersion: body.expectedVersion,
      reason,
    },
  );

  // DB 상태 변경(멱등): soft-delete + 하이라이트 cascade 태깅 + 이 doll pending 신고 actioned.
  //   storage 물리삭제 없음(가역). targets 는 permanent-delete 가 쓰고, takedown 은 무시.
  const { data, error } = await admin.rpc(
    "admin_moderation_action_idempotent",
    {
      p_action: "takedown",
      p_admin_id: gate.user.id,
      p_doll_id: dollId,
      p_reason: reason,
      p_expected_state: body.expectedState,
      p_expected_version: body.expectedVersion,
      p_request_id: requestId,
    },
  );
  if (error) {
    log.warn("admin.takedown_fail", { dollId, ...errInfo(error) });
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
    log.error("admin.takedown_invalid_result", { dollId });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }

  // 이 doll 이 박힌 모든 표면 ISR 캐시 무효화(앱 표면에서 즉시 기본 부장님으로).
  await revalidateDollSurfaces(admin, dollId);

  log.info("admin.takedown_ok", {
    dollId,
    adminId: gate.user.id,
    noOp: result.noOp,
    version: result.version,
  });
  return NextResponse.json(result);
}
