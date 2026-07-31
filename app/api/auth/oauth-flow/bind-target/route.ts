import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { readServerAuthUser } from "@/lib/http/server-auth-user";
import { readOAuthFlowRouteAuthority } from "@/lib/oauth-flow-route";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  readSupabaseAccessTokenIdentity,
} from "@/lib/supabase/session-cookie";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupabaseData } from "@/lib/supabase-operation";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 20;

const AUTH_TOKEN_MAX_CHARS = 64 * 1024;
const BIND_TARGET_MAX_BODY_BYTES = 132 * 1024;

type BindTargetInput = {
  flowId: string;
  provider: "kakao" | "google";
  accessToken: string;
  refreshToken: string;
};

type VerifiedTarget = {
  userId: string;
  sessionId: string;
};

function tokenDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

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

function parseInput(value: unknown): BindTargetInput | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  if (
    keys.length !== 4 ||
    ![
      "flowId",
      "provider",
      "accessToken",
      "refreshToken",
    ].every((key) => keys.includes(key)) ||
    !isOAuthFlowId(input.flowId) ||
    (input.provider !== "kakao" &&
      input.provider !== "google") ||
    typeof input.accessToken !== "string" ||
    input.accessToken.length === 0 ||
    input.accessToken.length > AUTH_TOKEN_MAX_CHARS ||
    /[\s\u0000-\u001f\u007f]/u.test(input.accessToken) ||
    typeof input.refreshToken !== "string" ||
    input.refreshToken.length === 0 ||
    input.refreshToken.length > AUTH_TOKEN_MAX_CHARS ||
    /[\s\u0000-\u001f\u007f]/u.test(input.refreshToken)
  ) {
    return null;
  }
  return input as BindTargetInput;
}

function parseReceipt(
  value: unknown,
  expectedFlowId: string,
  expectedTarget: VerifiedTarget,
): boolean {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const receipt = value as Record<string, unknown>;
  return (
    Object.keys(receipt).length === 4 &&
    receipt.ok === true &&
    receipt.flowId === expectedFlowId &&
    receipt.targetUserId === expectedTarget.userId &&
    receipt.targetSessionId === expectedTarget.sessionId
  );
}

/**
 * Binds the exact paired Auth token response to the claimed ledger before the
 * callback transport is allowed to expose that response to AuthClient's
 * ordinary cookie storage. A process loss can therefore leave either the
 * source cookie or the exact bound target, never an unidentifiable target.
 */
export async function POST(request: NextRequest) {
  if (!browserMutationOriginAllowed(request.url, request.headers)) {
    return response({ error: "forbidden_origin" }, 403);
  }
  const body = await readApiJsonObjectRequest(
    request,
    BIND_TARGET_MAX_BODY_BYTES,
  );
  if (!body.ok) return response({ error: body.error }, body.status);
  const input = parseInput(body.value);
  if (!input) return response({ error: "invalid_body" }, 400);

  const authority = readOAuthFlowRouteAuthority({
    cookieHeader: request.headers.get("cookie"),
    flowId: input.flowId,
    provider: input.provider,
    recovery: true,
    secret: SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!authority) {
    return response({ error: "oauth_flow_proof_invalid" }, 409);
  }

  const target = readSupabaseAccessTokenIdentity(
    input.accessToken,
  );
  if (
    target === null ||
    target.sessionId === authority.proof.sourceSessionId ||
    (
      authority.proof.sourceIsAnonymous &&
      target.userId === authority.proof.sourceUserId
    )
  ) {
    return response({ error: "oauth_flow_target_invalid" }, 409);
  }
  const targetAuth = await readServerAuthUser({
    accessToken: input.accessToken,
    anonKey: PUBLIC_ENV.SUPABASE_ANON_KEY,
    signal: AbortSignal.timeout(8_000),
    supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
  });
  if (targetAuth.kind === "unavailable") {
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  if (
    targetAuth.kind !== "valid" ||
    targetAuth.user.id !== target.userId ||
    targetAuth.user.is_anonymous !== false
  ) {
    return response({ error: "oauth_flow_target_invalid" }, 409);
  }

  try {
    const value = await requireSupabaseData<unknown>(
      "auth.oauth_flow_bind_target",
      () =>
        createAdminClient()
          .rpc("bind_oauth_flow_intent_target", {
            p_flow_id: input.flowId,
            p_source_user_id: authority.proof.sourceUserId,
            p_source_session_id:
              authority.proof.sourceSessionId,
            p_provider: authority.proof.provider,
            p_target_user_id: target.userId,
            p_target_session_id: target.sessionId,
            p_access_token_sha256: tokenDigest(
              input.accessToken,
            ),
            p_refresh_token_sha256: tokenDigest(
              input.refreshToken,
            ),
          })
          .abortSignal(AbortSignal.timeout(8_000)),
    );
    if (!parseReceipt(value, input.flowId, target)) {
      return response(
        { error: "oauth_flow_target_conflict" },
        409,
      );
    }
  } catch (error) {
    log.error("auth.oauth_flow_bind_target_fail", {
      flowId: input.flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  return response(
    {
      ok: true,
      flowId: input.flowId,
      targetUserId: target.userId,
      targetSessionId: target.sessionId,
    },
    200,
  );
}
