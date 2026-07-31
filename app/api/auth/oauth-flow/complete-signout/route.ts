import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  clearOAuthFlowCookies,
  readOAuthFlowRouteAuthority,
} from "@/lib/oauth-flow-route";
import { readOAuthFlowStatusStrict } from "@/lib/oauth-flow-admin";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import { requireSupabaseData } from "@/lib/supabase-operation";
import { migrateCookieName } from "@/lib/signup-cookie";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";
import { safeFlowDestination } from "@/lib/oauth-flow-status";

export const runtime = "nodejs";
export const maxDuration = 15;

function response(
  body: Record<string, unknown>,
  status: number,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}

export async function POST(request: NextRequest) {
  if (!browserMutationOriginAllowed(request.url, request.headers)) {
    return response({ error: "forbidden_origin" }, 403);
  }
  const body = await readApiJsonObjectRequest(request);
  if (!body.ok) return response({ error: body.error }, body.status);
  const keys = Object.keys(body.value);
  const flowId = body.value.flowId;
  if (
    keys.length !== 1 ||
    keys[0] !== "flowId" ||
    !isOAuthFlowId(flowId)
  ) {
    return response({ error: "invalid_body" }, 400);
  }
  const authority = readOAuthFlowRouteAuthority({
    cookieHeader: request.headers.get("cookie"),
    flowId,
    recovery: true,
    secret: SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!authority) {
    return response({ error: "oauth_flow_proof_invalid" }, 409);
  }

  let status;
  try {
    status = await readOAuthFlowStatusStrict(
      authority.proof,
      AbortSignal.timeout(8_000),
    );
  } catch (error) {
    log.error("auth.oauth_flow_complete_signout_status_fail", {
      flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  if (
    status.action !== "signout" ||
    !status.targetUserId ||
    !status.targetSessionId ||
    !status.destination ||
    // 종착지는 서버 기록 값 — safeNext(로그인 차단목록)가 아니라
    // safeFlowDestination 으로 검증한다(/login?error=account_deleted 가
    // 정당한 종착지. 2026-08-01 운영 실측: safeNext 잔존으로 PR#203 이후에도
    // ACK 409 무한 루프가 한 단계 뒤에서 재현).
    !safeFlowDestination(status.destination) ||
    !["signout_revoked", "completed"].includes(status.state)
  ) {
    // 이 409 는 클라 복구 루프의 원인이 된다 — 침묵 금지(M2).
    log.error("auth.oauth_flow_complete_signout_not_completable", {
      flowId,
      state: status.state,
      action: status.action,
      destination: status.destination,
    });
    return response(
      { error: "oauth_flow_signout_not_completable" },
      409,
    );
  }

  const rawSession = await readSupabaseSessionCookieHeader(
    request.headers.get("cookie"),
    PUBLIC_ENV.SUPABASE_URL,
  );
  if (
    rawSession.kind === "invalid" ||
    (
      rawSession.kind === "present" &&
      rawSession.session.userId === status.targetUserId &&
      rawSession.session.sessionId ===
        status.targetSessionId
    )
  ) {
    return response(
      {
        error:
          rawSession.kind === "invalid"
            ? "auth_session_invalid"
            : "auth_target_session_still_present",
      },
      409,
    );
  }

  let destination: string | null = null;
  try {
    const value = await requireSupabaseData<unknown>(
      "auth.oauth_flow_complete_signout",
      () =>
        createAdminClient()
          .rpc("complete_oauth_flow_signout", {
            p_flow_id: flowId,
            p_source_user_id: authority.proof.sourceUserId,
            p_source_session_id:
              authority.proof.sourceSessionId,
            p_provider: authority.proof.provider,
            p_target_user_id: status.targetUserId,
            p_target_session_id: status.targetSessionId,
          })
          .abortSignal(AbortSignal.timeout(8_000)),
    );
    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 3 &&
      (value as Record<string, unknown>).ok === true &&
      (value as Record<string, unknown>).flowId === flowId &&
      typeof (value as Record<string, unknown>).destination ===
        "string" &&
      safeFlowDestination(
        (value as Record<string, unknown>).destination,
      )
    ) {
      destination = (value as Record<string, unknown>)
        .destination as string;
    }
  } catch (error) {
    log.error("auth.oauth_flow_complete_signout_fail", {
      flowId,
      ...errInfo(error),
    });
  }
  if (!destination || destination !== status.destination) {
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  const result = response(
    { ok: true, flowId, destination },
    200,
  );
  clearOAuthFlowCookies(result, flowId);
  result.cookies.set(migrateCookieName(flowId), "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return result;
}
