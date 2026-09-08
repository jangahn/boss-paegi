import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { revalidateDollSurfaces } from "@/lib/moderation-revalidate";
import { log, errInfo } from "@/lib/log";
import { deterministicAdminRequestId } from "@/lib/admin-operation-id";
import { parseAdminDollGenderMutationResult } from "@/lib/admin-mutation";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { isGender } from "@/lib/gender";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 캐릭터 성별 후처리(v1.26) — 얼굴검사 자동 판정을 어드민이 캐릭터 상세에서 바꾼다. 보이스(시비 멘트·피격 반응)만
 * 바뀌고 이미지는 불변. 0085 receipt 패턴: 결정적 request id + `admin_update_doll_gender_idempotent`
 * (dolls.version CAS → state_conflict 409). 같은 값이면 noOp. 공유·OG 표면 ISR 은 doll 단위로 무효화.
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
    gender?: string;
    expectedVersion?: number;
  } | null;
  if (
    !body?.dollId ||
    !UUID_RE.test(body.dollId) ||
    !isGender(body.gender) ||
    !Number.isSafeInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const dollId = body.dollId;
  const admin = createAdminClient();
  const requestId = deterministicAdminRequestId(
    "doll_gender_update",
    gate.user.id,
    dollId,
    { gender: body.gender, expectedVersion: body.expectedVersion },
  );

  const { data, error } = await admin.rpc("admin_update_doll_gender_idempotent", {
    p_admin_id: gate.user.id,
    p_doll_id: dollId,
    p_gender: body.gender,
    p_expected_version: body.expectedVersion,
    p_request_id: requestId,
  });
  if (error) {
    log.warn("admin.doll_gender_fail", { dollId, ...errInfo(error) });
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
  const result = parseAdminDollGenderMutationResult(data);
  if (!result) {
    log.error("admin.doll_gender_invalid_result", { dollId });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }

  // 피격 반응(공유 카드·OG)이 이 doll 의 성별 보이스를 읽으므로 doll 표면 ISR 무효화.
  if (!result.noOp) await revalidateDollSurfaces(admin, dollId);

  log.info("admin.doll_gender_ok", {
    dollId,
    adminId: gate.user.id,
    previousGender: result.previousGender,
    nextGender: result.nextGender,
    noOp: result.noOp,
    version: result.version,
  });
  return NextResponse.json(result);
}
