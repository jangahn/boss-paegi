import { NextResponse, type NextRequest } from "next/server";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  clearOAuthFlowCookies,
  readOAuthFlowRouteAuthority,
} from "@/lib/oauth-flow-route";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupabaseData } from "@/lib/supabase-operation";
import { migrateCookieName } from "@/lib/signup-cookie";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

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

function parseOutcome(
  value: unknown,
  flowId: string,
): "expired" | "absent" | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const receipt = value as Record<string, unknown>;
  return (
    Object.keys(receipt).length === 3 &&
    receipt.ok === true &&
    receipt.flowId === flowId &&
    (receipt.outcome === "expired" ||
      receipt.outcome === "absent")
  )
    ? receipt.outcome
    : null;
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

  let outcome: "expired" | "absent" | null = null;
  try {
    const value = await requireSupabaseData<unknown>(
      "auth.oauth_flow_expire",
      () =>
        createAdminClient()
          .rpc("expire_oauth_flow_intent", {
            p_flow_id: flowId,
          })
          .abortSignal(AbortSignal.timeout(8_000)),
    );
    outcome = parseOutcome(value, flowId);
  } catch (error) {
    log.error("auth.oauth_flow_expire_fail", {
      flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  if (!outcome) {
    return response({ error: "oauth_flow_active" }, 409);
  }

  const result = response(
    { ok: true, flowId, outcome },
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
