import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import {
  isOAuthFlowId,
} from "@/lib/oauth-flow-lease";
import {
  readOAuthFlowRouteAuthority,
  setOAuthFlowRecoveryCookies,
} from "@/lib/oauth-flow-route";
import { requireSupabaseData } from "@/lib/supabase-operation";
import { SERVER_ENV } from "@/lib/env.server";
import { PUBLIC_ENV } from "@/lib/env";
import { log, errInfo } from "@/lib/log";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";

export const runtime = "nodejs";
export const maxDuration = 15;

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

export async function POST(request: NextRequest) {
  if (!browserMutationOriginAllowed(request.url, request.headers)) {
    return response({ error: "forbidden_origin" }, 403);
  }
  const body = await readApiJsonObjectRequest(request);
  if (!body.ok) return response({ error: body.error }, body.status);
  const keys = Object.keys(body.value);
  const flowId = body.value.flowId;
  const provider = body.value.provider;
  if (
    keys.length !== 2 ||
    !keys.includes("flowId") ||
    !keys.includes("provider") ||
    !isOAuthFlowId(flowId) ||
    (provider !== "kakao" && provider !== "google")
  ) {
    return response({ error: "invalid_body" }, 400);
  }
  const authority = readOAuthFlowRouteAuthority({
    cookieHeader: request.headers.get("cookie"),
    flowId,
    provider,
    recovery: true,
    secret: SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!authority) {
    return response({ error: "oauth_flow_proof_invalid" }, 409);
  }
  const source = await readSupabaseSessionCookieHeader(
    request.headers.get("cookie"),
    PUBLIC_ENV.SUPABASE_URL,
  );
  if (
    source.kind !== "present" ||
    source.session.userId !== authority.proof.sourceUserId ||
    source.session.sessionId !==
      authority.proof.sourceSessionId
  ) {
    return response({ error: "auth_session_changed" }, 409);
  }

  try {
    const value = await requireSupabaseData<unknown>(
      "auth.oauth_flow_preflight",
      () =>
        createAdminClient()
          .rpc("claim_oauth_flow_intent", {
            p_flow_id: flowId,
            p_source_user_id: authority.proof.sourceUserId,
            p_source_session_id:
              authority.proof.sourceSessionId,
            p_provider: authority.proof.provider,
            p_source_access_token_sha256: tokenDigest(
              source.session.accessToken,
            ),
            p_source_refresh_token_sha256: tokenDigest(
              source.session.refreshToken,
            ),
          })
          .abortSignal(AbortSignal.timeout(8_000)),
    );
    const valid =
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      Object.keys(value as Record<string, unknown>).length === 2 &&
      (value as Record<string, unknown>).ok === true &&
      (value as Record<string, unknown>).flowId === flowId;
    if (!valid) {
      return response({ error: "oauth_flow_not_active" }, 409);
    }
  } catch (error) {
    log.error("auth.oauth_flow_preflight_fail", {
      flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  const result = response(
    {
      ok: true,
      flowId,
      sourceUserId: authority.proof.sourceUserId,
      sourceSessionId: authority.proof.sourceSessionId,
    },
    200,
  );
  setOAuthFlowRecoveryCookies(result, authority);
  return result;
}
