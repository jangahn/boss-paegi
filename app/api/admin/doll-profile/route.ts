import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { revalidateDollSurfaces } from "@/lib/moderation-revalidate";
import { log, errInfo } from "@/lib/log";
import { deterministicAdminRequestId } from "@/lib/admin-operation-id";
import { parseAdminDollProfileMutationResult } from "@/lib/admin-mutation";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { isRoleId } from "@/lib/roles";
import { isGender } from "@/lib/gender";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * 캐릭터 속성(롤·성별) 어드민 변경(v1.29) — 캐릭터 상세의 유일한 쓰기 경로. 유저는 생성 뒤 바꾸지 못한다.
 * 롤·성별은 메타데이터라 이미지는 불변(호칭·인사기록·보이스·공유 카피만 바뀜). 0085 receipt 패턴: 결정적 request id +
 * `admin_update_doll_profile_idempotent`(`dolls.version` CAS → state_conflict 409, 같은 값이면 noOp). 캐릭터 표면 ISR 무효화.
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
    role?: string;
    gender?: string;
    expectedVersion?: number;
  } | null;
  if (
    !body?.dollId ||
    !UUID_RE.test(body.dollId) ||
    !isRoleId(body.role) ||
    !isGender(body.gender) ||
    !Number.isSafeInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const dollId = body.dollId;
  const admin = createAdminClient();
  const requestId = deterministicAdminRequestId(
    "doll_profile_update",
    gate.user.id,
    dollId,
    { role: body.role, gender: body.gender, expectedVersion: body.expectedVersion },
  );

  const { data, error } = await admin.rpc("admin_update_doll_profile_idempotent", {
    p_admin_id: gate.user.id,
    p_doll_id: dollId,
    p_role: body.role,
    p_gender: body.gender,
    p_expected_version: body.expectedVersion,
    p_request_id: requestId,
  });
  if (error) {
    log.warn("admin.doll_profile_fail", { dollId, ...errInfo(error) });
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
  const result = parseAdminDollProfileMutationResult(data);
  if (!result) {
    log.error("admin.doll_profile_invalid_result", { dollId });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }

  // 호칭·인사기록·피격 반응(공유 카드·OG)이 캐릭터의 롤·성별을 읽으므로 doll 표면 ISR 무효화.
  if (!result.noOp) await revalidateDollSurfaces(admin, dollId);

  log.info("admin.doll_profile_ok", {
    dollId,
    adminId: gate.user.id,
    previousRole: result.previousRole,
    nextRole: result.nextRole,
    previousGender: result.previousGender,
    nextGender: result.nextGender,
    noOp: result.noOp,
    version: result.version,
  });
  return NextResponse.json(result);
}
