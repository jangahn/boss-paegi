import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  migrateCookieName,
  signMigrateValue,
  MIGRATE_COOKIE,
  MIGRATE_MAX_AGE,
} from "@/lib/signup-cookie";
import { log, errInfo } from "@/lib/log";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import {
  oauthFlowCookieName,
  OAUTH_FLOW_COOKIE_PREFIX,
} from "@/lib/oauth-flow-lease";
import {
  oauthFlowProofCookieName,
  OAUTH_FLOW_PROOF_COOKIE_PREFIX,
  OAUTH_FLOW_RECOVERY_MAX_AGE_SECONDS,
  parseOAuthFlowPrepareRequest,
  signOAuthFlowProof,
} from "@/lib/oauth-flow-proof";
import { parseOAuthFlowBeginAck } from "@/lib/oauth-flow-intent";
import { SERVER_ENV } from "@/lib/env.server";
import { requireSupabaseData } from "@/lib/supabase-operation";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import { PUBLIC_ENV } from "@/lib/env";
import {
  parseRawCookieHeaderForPrefixes,
} from "@/lib/http/raw-cookie-header";
import { readServerAuthUser } from "@/lib/http/server-auth-user";

export const runtime = "nodejs";
export const maxDuration = 25;

const NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
} as const;

function tokenDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function json(
  body: Record<string, unknown>,
  status = 200,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE,
  });
}

function clearLegacyMigrateCookie(response: NextResponse): void {
  response.cookies.set(MIGRATE_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

/**
 * OAuth 시작은 한 exact flow ID로 재전달 가능한 서버 mutation이다.
 * Auth의 현재 actor/fingerprint를 요청 증거와 대조하고, 익명 이전 cookie,
 * browser-visible marker, HttpOnly HMAC proof, DB pending intent를 한 응답
 * 경계에서 발급한다. Member actor이면 남아 있던 MIGRATE cookie를 반드시
 * 만료해 이전 사용자의 익명 데이터가 다음 OAuth에 붙지 않게 한다.
 */
export async function POST(request: NextRequest) {
  if (!browserMutationOriginAllowed(request.url, request.headers)) {
    return json({ error: "forbidden_origin" }, 403);
  }
  const requestBody = await readApiJsonObjectRequest(request);
  if (!requestBody.ok) {
    return json(
      { error: requestBody.error },
      requestBody.status,
    );
  }
  const input = parseOAuthFlowPrepareRequest(requestBody.value);
  if (!input) return json({ error: "invalid_body" }, 400);

  const rawCookies = parseRawCookieHeaderForPrefixes(
    request.headers.get("cookie"),
    [
      OAUTH_FLOW_COOKIE_PREFIX,
      OAUTH_FLOW_PROOF_COOKIE_PREFIX,
    ],
  );
  if (rawCookies.kind !== "ok") {
    return json({ error: "invalid_cookie_header" }, 400);
  }
  const markerCookies = rawCookies.cookies
    .filter(({ name }) => name.startsWith(OAUTH_FLOW_COOKIE_PREFIX));
  const proofCookies = rawCookies.cookies
    .filter(({ name }) =>
      name.startsWith(OAUTH_FLOW_PROOF_COOKIE_PREFIX),
    );
  const expectedMarker = oauthFlowCookieName(input.flowId);
  const expectedProof = oauthFlowProofCookieName(input.flowId);
  if (
    markerCookies.some(({ name }) => name !== expectedMarker) ||
    proofCookies.some(({ name }) => name !== expectedProof) ||
    markerCookies.length > 1 ||
    proofCookies.length > 1
  ) {
    return json({ error: "oauth_flow_already_active" }, 409);
  }

  const cookieRead = await readSupabaseSessionCookieHeader(
    request.headers.get("cookie"),
    PUBLIC_ENV.SUPABASE_URL,
  );
  if (cookieRead.kind !== "present") {
    return json(
      {
        error:
          cookieRead.kind === "absent"
            ? "unauthorized"
            : "auth_session_invalid",
      },
      cookieRead.kind === "absent" ? 401 : 409,
    );
  }
  const cookieSession = cookieRead.session;
  const authResult = await readServerAuthUser({
    accessToken: cookieSession.accessToken,
    anonKey: PUBLIC_ENV.SUPABASE_ANON_KEY,
    signal: AbortSignal.timeout(8_000),
    supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
  });
  if (authResult.kind !== "valid") {
    log.warn("auth.prepare_signup_user_fail", {
      kind: authResult.kind,
    });
    return json(
      {
        error:
          authResult.kind === "invalid"
            ? "unauthorized"
            : "auth_unavailable",
      },
      authResult.kind === "invalid" ? 401 : 503,
    );
  }
  if (
    authResult.user.id !== input.expectedUserId ||
    cookieSession.userId !== authResult.user.id ||
    authResult.user.is_anonymous !== input.expectedAnonymous
  ) {
    const response = json({ error: "auth_session_changed" }, 409);
    // No flow was issued. Any previous migration proof belongs to a session
    // the browser no longer observes and must not survive into a retry.
    clearLegacyMigrateCookie(response);
    return response;
  }

  const admin = createAdminClient();
  let begin;
  try {
    const value = await requireSupabaseData<unknown>(
      "auth.oauth_flow_begin",
      () =>
        admin
          .rpc("begin_oauth_flow_intent", {
            p_flow_id: input.flowId,
            p_source_user_id: authResult.user.id,
            p_source_session_id: cookieSession.sessionId,
            p_source_is_anonymous:
              authResult.user.is_anonymous,
            p_provider: input.provider,
            p_requested_next: input.next,
            p_source_access_token_sha256: tokenDigest(
              cookieSession.accessToken,
            ),
            p_source_refresh_token_sha256: tokenDigest(
              cookieSession.refreshToken,
            ),
          })
          .abortSignal(AbortSignal.timeout(12_000)),
    );
    begin = parseOAuthFlowBeginAck(value, input.flowId);
    if (!begin) throw new Error("invalid_oauth_flow_begin_ack");
  } catch (error) {
    log.error("auth.oauth_flow_begin_fail", {
      flowId: input.flowId,
      ...errInfo(error),
    });
    return json({ error: "auth_unavailable" }, 503);
  }

  let signed;
  try {
    signed = signOAuthFlowProof(
      {
        flowId: input.flowId,
        sourceUserId: authResult.user.id,
        sourceSessionId: cookieSession.sessionId,
        sourceIsAnonymous: authResult.user.is_anonymous,
        provider: input.provider,
      },
      SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
      Date.now(),
      Date.parse(begin.expiresAt),
    );
  } catch (error) {
    log.error("auth.oauth_flow_proof_fail", {
      flowId: input.flowId,
      ...errInfo(error),
    });
    return json({ error: "auth_unavailable" }, 503);
  }

  const response = json({ ok: true, flowId: input.flowId });
  clearLegacyMigrateCookie(response);
  if (authResult.user.is_anonymous) {
    try {
      response.cookies.set(
        migrateCookieName(input.flowId),
        signMigrateValue(authResult.user.id, input.flowId),
        {
          httpOnly: true,
          secure: process.env.NODE_ENV === "production",
          sameSite: "lax",
          path: "/",
          maxAge: MIGRATE_MAX_AGE,
        },
      );
    } catch (error) {
      log.error("auth.prepare_signup_cookie_fail", errInfo(error));
      return json({ error: "auth_unavailable" }, 503);
    }
  }
  response.cookies.set(expectedMarker, input.flowId, {
    httpOnly: false,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: OAUTH_FLOW_RECOVERY_MAX_AGE_SECONDS,
  });
  response.cookies.set(expectedProof, signed.value, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    // The signed proof remains claimable for the DB's exact ten-minute
    // window, but the cookie survives long enough to recover a claimed flow
    // or a lost terminal response without creating a proof-only loop.
    maxAge: OAUTH_FLOW_RECOVERY_MAX_AGE_SECONDS,
  });
  return response;
}
