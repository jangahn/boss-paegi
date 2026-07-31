import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  clearOAuthFlowCookies,
  readOAuthFlowRouteAuthority,
} from "@/lib/oauth-flow-route";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import { readServerAuthUser } from "@/lib/http/server-auth-user";
import { requireSupabaseData } from "@/lib/supabase-operation";
import { migrateCookieName } from "@/lib/signup-cookie";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 20;

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

function parseAck(
  value: unknown,
  flowId: string,
): "cancelled" | "expired" | "absent" | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const ack = value as Record<string, unknown>;
  const keys = Object.keys(ack);
  return keys.length === 3 &&
    keys.includes("ok") &&
    keys.includes("flowId") &&
    keys.includes("outcome") &&
    ack.ok === true &&
    ack.flowId === flowId &&
    (ack.outcome === "cancelled" ||
      ack.outcome === "expired" ||
      ack.outcome === "absent")
    ? ack.outcome
    : null;
}

async function cancelForProvider(options: {
  flowId: string;
  sourceUserId: string;
  sourceSessionId: string;
  provider: "kakao" | "google";
}): Promise<{
  outcome: "cancelled" | "expired" | "absent" | null;
  raw: unknown;
}> {
  const value = await requireSupabaseData<unknown>(
    "auth.oauth_flow_cancel",
    () =>
      createAdminClient()
        .rpc("cancel_oauth_flow_intent", {
          p_flow_id: options.flowId,
          p_source_user_id: options.sourceUserId,
          p_source_session_id: options.sourceSessionId,
          p_provider: options.provider,
        })
        .abortSignal(AbortSignal.timeout(8_000)),
  );
  return {
    outcome: parseAck(value, options.flowId),
    raw: value,
  };
}

export async function POST(request: NextRequest) {
  if (!browserMutationOriginAllowed(request.url, request.headers)) {
    return response({ error: "forbidden_origin" }, 403);
  }
  const body = await readApiJsonObjectRequest(request);
  if (!body.ok) return response({ error: body.error }, body.status);
  const keys = Object.keys(body.value);
  const flowId = body.value.flowId;
  const requestedProvider = body.value.provider;
  if (
    keys.length !== 2 ||
    !keys.includes("flowId") ||
    !keys.includes("provider") ||
    !isOAuthFlowId(flowId) ||
    (requestedProvider !== "kakao" &&
      requestedProvider !== "google")
  ) {
    return response({ error: "invalid_body" }, 400);
  }

  const authority = readOAuthFlowRouteAuthority({
    cookieHeader: request.headers.get("cookie"),
    flowId,
    provider: requestedProvider,
    recovery: true,
    secret: SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
  });
  let sourceUserId: string;
  let sourceSessionId: string;
  let providers: readonly ("kakao" | "google")[];
  if (authority) {
    // The recovery proof is bound to the original actor, provider, and flow.
    // Cancelling a still-pending row never reads, clears, or revokes the
    // browser's current Auth session, which may legitimately be unrelated.
    sourceUserId = authority.proof.sourceUserId;
    sourceSessionId = authority.proof.sourceSessionId;
    providers = [requestedProvider];
  } else {
    // A begin may commit while its whole response is lost. The exact current
    // Auth actor can cancel only that still-pending row; both providers are
    // tried because no proof cookie was delivered.
    const cookie = await readSupabaseSessionCookieHeader(
      request.headers.get("cookie"),
      PUBLIC_ENV.SUPABASE_URL,
    );
    if (cookie.kind !== "present") {
      return response({ error: "unauthorized" }, 401);
    }
    const user = await readServerAuthUser({
      accessToken: cookie.session.accessToken,
      anonKey: PUBLIC_ENV.SUPABASE_ANON_KEY,
      signal: AbortSignal.timeout(8_000),
      supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
    });
    if (user.kind === "unavailable") {
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }
    if (
      user.kind !== "valid" ||
      user.user.id !== cookie.session.userId
    ) {
      return response({ error: "unauthorized" }, 401);
    }
    sourceUserId = cookie.session.userId;
    sourceSessionId = cookie.session.sessionId;
    providers = [requestedProvider];
  }

  let outcome: "cancelled" | "expired" | "absent" | null =
    null;
  let conflict = false;
  try {
    for (const provider of providers) {
      const attempt = await cancelForProvider({
        flowId,
        sourceUserId,
        sourceSessionId,
        provider,
      });
      if (attempt.outcome) {
        outcome = attempt.outcome;
        break;
      }
      if (
        attempt.raw &&
        typeof attempt.raw === "object" &&
        !Array.isArray(attempt.raw) &&
        (attempt.raw as Record<string, unknown>).error ===
          "oauth_flow_not_cancellable"
      ) {
        conflict = true;
      }
    }
  } catch (error) {
    log.error("auth.oauth_flow_cancel_fail", {
      flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  if (!outcome) {
    return response(
      {
        error: conflict
          ? "oauth_flow_claimed"
          : "oauth_flow_not_found",
      },
      409,
    );
  }
  const result = response({ ok: true, flowId, outcome }, 200);
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
