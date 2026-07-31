import { NextResponse, type NextRequest } from "next/server";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";
import {
  MIGRATE_COOKIE,
  MIGRATE_COOKIE_PREFIX,
  cookieHeaderHasOAuthFlowBarrier,
} from "@/lib/cookies";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { readBoundedResponseBytes } from "@/lib/http/bounded-response";
import {
  isDefinitiveHttpRejectionStatus,
} from "@/lib/http/definitive-http-rejection";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import {
  readOAuthFlowRouteAuthority,
} from "@/lib/oauth-flow-route";
import {
  readOAuthFlowStatusStrict,
} from "@/lib/oauth-flow-admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupabaseData } from "@/lib/supabase-operation";
import {
  parseOAuthFlowSignoutRevokeReceipt,
} from "@/lib/oauth-flow-status";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 30;

const SIGNOUT_REVOKE_TIMEOUT_MS = 12_000;
const SIGNOUT_ERROR_BODY_MAX_BYTES = 16 * 1024;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

type SignoutInput = {
  flowId: string | null;
  expectedUserId: string;
  expectedSessionId: string;
};

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

function parseInput(value: unknown): SignoutInput | null {
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
    keys.length !== 3 ||
    !keys.includes("flowId") ||
    !keys.includes("expectedUserId") ||
    !keys.includes("expectedSessionId") ||
    (input.flowId !== null && !isOAuthFlowId(input.flowId)) ||
    typeof input.expectedUserId !== "string" ||
    !UUID_RE.test(input.expectedUserId) ||
    typeof input.expectedSessionId !== "string" ||
    !UUID_RE.test(input.expectedSessionId)
  ) {
    return null;
  }
  return input as SignoutInput;
}

function isSessionAlreadyAbsentBody(bytes: Uint8Array): boolean {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return false;
    }
    const error = parsed as Record<string, unknown>;
    return (
      error.code === "session_not_found" ||
      error.error_code === "session_not_found"
    );
  } catch {
    return false;
  }
}

/**
 * Revokes the exact Auth session represented by the access-token
 * `session_id`. A replay after a committed/lost response is accepted only
 * when Auth returns its exact `session_not_found` semantic code.
 */
async function revokeSession(
  accessToken: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await fetch(
    new URL("/auth/v1/logout?scope=local", PUBLIC_ENV.SUPABASE_URL),
    {
      method: "POST",
      headers: {
        accept: "application/json",
        apikey: PUBLIC_ENV.SUPABASE_ANON_KEY,
        authorization: `Bearer ${accessToken}`,
      },
      cache: "no-store",
      credentials: "omit",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    },
  );
  const body = await readBoundedResponseBytes(
    response,
    SIGNOUT_ERROR_BODY_MAX_BYTES,
    signal,
  );
  if (!body.ok) throw new Error("signout_revoke_body_invalid");
  if (
    response.ok ||
    (
      isDefinitiveHttpRejectionStatus(response.status) &&
      isSessionAlreadyAbsentBody(body.bytes)
    )
  ) {
    return;
  }
  throw new Error(`signout_revoke_http_${response.status}`);
}

function clearMigrationCookies(
  result: NextResponse,
  request: NextRequest,
): void {
  const names = new Set<string>([MIGRATE_COOKIE]);
  for (const { name } of request.cookies.getAll()) {
    if (name.startsWith(MIGRATE_COOKIE_PREFIX)) names.add(name);
  }
  for (const name of names) {
    result.cookies.set(name, "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
}

export async function handleSignoutRequest(
  request: NextRequest,
  mode: "ordinary" | "oauth",
) {
  if (!browserMutationOriginAllowed(request.url, request.headers)) {
    return response({ error: "forbidden_origin" }, 403);
  }
  const body = await readApiJsonObjectRequest(request);
  if (!body.ok) return response({ error: body.error }, body.status);
  const input = parseInput(body.value);
  if (!input) return response({ error: "invalid_body" }, 400);
  if (
    (mode === "ordinary" && input.flowId !== null) ||
    (mode === "oauth" && input.flowId === null)
  ) {
    return response({ error: "invalid_signout_mode" }, 400);
  }
  if (
    mode === "ordinary" &&
    cookieHeaderHasOAuthFlowBarrier(
      request.headers.get("cookie"),
    )
  ) {
    return response({ error: "oauth_flow_active" }, 409);
  }

  const rawSession = await readSupabaseSessionCookieHeader(
    request.headers.get("cookie"),
    PUBLIC_ENV.SUPABASE_URL,
  );
  let authority:
    | ReturnType<typeof readOAuthFlowRouteAuthority>
    | null = null;
  if (mode === "oauth" && input.flowId !== null) {
    authority = readOAuthFlowRouteAuthority({
      cookieHeader: request.headers.get("cookie"),
      flowId: input.flowId,
      recovery: true,
      secret: SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
    });
    if (!authority) {
      return response({ error: "oauth_flow_proof_invalid" }, 409);
    }
    try {
      const status = await readOAuthFlowStatusStrict(
        authority.proof,
        AbortSignal.timeout(8_000),
      );
      if (
        status.action !== "signout" ||
        status.targetUserId !== input.expectedUserId ||
        status.targetSessionId !== input.expectedSessionId ||
        ![
          "signout_required",
          "signout_revoked",
          "completed",
        ].includes(status.state)
      ) {
        return response({ error: "oauth_flow_signout_conflict" }, 409);
      }
      if (
        status.state === "signout_revoked" ||
        status.state === "completed"
      ) {
        if (
          rawSession.kind === "invalid" ||
          (rawSession.kind === "present" &&
            (rawSession.session.userId !==
              input.expectedUserId ||
              rawSession.session.sessionId !==
                input.expectedSessionId))
        ) {
          return response(
            { error: "auth_session_changed" },
            409,
          );
        }
        const result = response(
          {
            ok: true,
            flowId: input.flowId,
            userId: input.expectedUserId,
            sessionId: input.expectedSessionId,
          },
          200,
        );
        clearMigrationCookies(result, request);
        return result;
      }
    } catch (error) {
      log.error("auth.oauth_flow_signout_status_fail", {
        flowId: input.flowId,
        ...errInfo(error),
      });
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }
  }

  if (
    rawSession.kind !== "present" ||
    rawSession.session.userId !== input.expectedUserId ||
    rawSession.session.sessionId !== input.expectedSessionId
  ) {
    return response(
      {
        error:
          rawSession.kind === "invalid"
            ? "auth_session_invalid"
            : "auth_session_changed",
      },
      409,
    );
  }

  const revokeSignal = AbortSignal.any([
    request.signal,
    AbortSignal.timeout(SIGNOUT_REVOKE_TIMEOUT_MS),
  ]);
  try {
    await revokeSession(rawSession.session.accessToken, revokeSignal);
  } catch (error) {
    log.warn("auth.signout_revoke_fail", {
      flowId: input.flowId,
      userId: input.expectedUserId,
      sessionId: input.expectedSessionId,
      ...errInfo(error),
    });
    const result = response(
      { error: "signout_revoke_unavailable" },
      503,
    );
    result.headers.set("Retry-After", "60");
    return result;
  }

  if (input.flowId !== null && authority) {
    try {
      const value = await requireSupabaseData<unknown>(
        "auth.oauth_flow_signout_revoke",
        () =>
          createAdminClient()
            .rpc("confirm_oauth_flow_signout_revoke", {
              p_flow_id: input.flowId,
              p_source_user_id: authority!.proof.sourceUserId,
              p_source_session_id:
                authority!.proof.sourceSessionId,
              p_provider: authority!.proof.provider,
              p_target_user_id: input.expectedUserId,
              p_target_session_id: input.expectedSessionId,
            })
            .abortSignal(AbortSignal.timeout(8_000)),
      );
      if (
        !parseOAuthFlowSignoutRevokeReceipt(value, {
          flowId: input.flowId,
          targetUserId: input.expectedUserId,
          targetSessionId: input.expectedSessionId,
        })
      ) {
        throw new Error("invalid_oauth_signout_revoke_receipt");
      }
    } catch (error) {
      // The remote revoke may already be committed. Preserve browser cookies
      // and replay this exact route until the durable ledger confirms it.
      log.error("auth.oauth_flow_signout_revoke_record_fail", {
        flowId: input.flowId,
        ...errInfo(error),
      });
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }
  }

  const result = response(
    {
      ok: true,
      flowId: input.flowId,
      userId: input.expectedUserId,
      sessionId: input.expectedSessionId,
    },
    200,
  );
  clearMigrationCookies(result, request);
  return result;
}

export async function POST(request: NextRequest) {
  return handleSignoutRequest(request, "ordinary");
}
