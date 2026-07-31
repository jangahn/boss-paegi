import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { readServerAuthUser } from "@/lib/http/server-auth-user";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  readOAuthFlowRouteAuthority,
} from "@/lib/oauth-flow-route";
import {
  parseOAuthFlowEvidenceVerification,
  parseOAuthFlowRotateReceipt,
  parseOAuthFlowTargetEvidence,
} from "@/lib/oauth-flow-status";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupabaseData } from "@/lib/supabase-operation";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 25;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

type RotateTargetInput = {
  flowId: string;
  targetUserId: string;
  targetSessionId: string;
  accessTokenDigest: string;
  refreshTokenDigest: string;
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

function parseInput(value: unknown): RotateTargetInput | null {
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
    keys.length !== 5 ||
    ![
      "flowId",
      "targetUserId",
      "targetSessionId",
      "accessTokenDigest",
      "refreshTokenDigest",
    ].every((key) => keys.includes(key)) ||
    !isOAuthFlowId(input.flowId) ||
    typeof input.targetUserId !== "string" ||
    !UUID_RE.test(input.targetUserId) ||
    typeof input.targetSessionId !== "string" ||
    !UUID_RE.test(input.targetSessionId) ||
    typeof input.accessTokenDigest !== "string" ||
    !SHA256_HEX_RE.test(input.accessTokenDigest) ||
    typeof input.refreshTokenDigest !== "string" ||
    !SHA256_HEX_RE.test(input.refreshTokenDigest)
  ) {
    return null;
  }
  return input as RotateTargetInput;
}

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function POST(request: NextRequest) {
  if (!browserMutationOriginAllowed(request.url, request.headers)) {
    return response({ error: "forbidden_origin" }, 403);
  }
  const body = await readApiJsonObjectRequest(request);
  if (!body.ok) return response({ error: body.error }, body.status);
  const input = parseInput(body.value);
  if (!input) return response({ error: "invalid_body" }, 400);

  const authority = readOAuthFlowRouteAuthority({
    cookieHeader: request.headers.get("cookie"),
    flowId: input.flowId,
    recovery: true,
    secret: SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!authority) {
    return response({ error: "oauth_flow_proof_invalid" }, 409);
  }

  const raw = await readSupabaseSessionCookieHeader(
    request.headers.get("cookie"),
    PUBLIC_ENV.SUPABASE_URL,
  );
  if (
    raw.kind !== "present" ||
    raw.session.userId !== input.targetUserId ||
    raw.session.sessionId !== input.targetSessionId ||
    digest(raw.session.accessToken) !== input.accessTokenDigest ||
    digest(raw.session.refreshToken) !== input.refreshTokenDigest
  ) {
    return response({ error: "auth_session_changed" }, 409);
  }

  const expected = {
    flowId: input.flowId,
    targetUserId: input.targetUserId,
    targetSessionId: input.targetSessionId,
  };
  const admin = createAdminClient();
  let verified = null;
  try {
    const value = await requireSupabaseData<unknown>(
      "auth.oauth_flow_target_evidence_verify",
      () =>
        admin
          .rpc("verify_oauth_flow_target_session_evidence", {
            p_flow_id: input.flowId,
            p_target_user_id: input.targetUserId,
            p_target_session_id: input.targetSessionId,
            p_access_token_sha256: input.accessTokenDigest,
            p_refresh_token_sha256:
              input.refreshTokenDigest,
          })
          .abortSignal(AbortSignal.timeout(8_000)),
    );
    verified = parseOAuthFlowEvidenceVerification(
      value,
      input.flowId,
    );
  } catch (error) {
    log.error("auth.oauth_flow_target_evidence_verify_fail", {
      flowId: input.flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  if (verified?.releasedAt !== null && verified !== null) {
    return response(
      {
        ok: true,
        flowId: input.flowId,
        targetUserId: input.targetUserId,
        targetSessionId: input.targetSessionId,
      },
      200,
    );
  }

  const auth = await readServerAuthUser({
    accessToken: raw.session.accessToken,
    anonKey: PUBLIC_ENV.SUPABASE_ANON_KEY,
    signal: AbortSignal.timeout(8_000),
    supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
  });
  if (auth.kind === "unavailable") {
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  if (
    auth.kind !== "valid" ||
    auth.user.id !== input.targetUserId ||
    auth.user.is_anonymous
  ) {
    // The caller may perform one proof-bound refresh and retry. This includes
    // remotely revoked-but-locally-unexpired access tokens; local wall-clock
    // expiry is not authorization.
    return response(
      { error: "auth_session_refresh_required" },
      409,
    );
  }

  if (verified !== null) {
    return response(
      {
        ok: true,
        flowId: input.flowId,
        targetUserId: input.targetUserId,
        targetSessionId: input.targetSessionId,
      },
      200,
    );
  }

  let stored;
  try {
    const value = await requireSupabaseData<unknown>(
      "auth.oauth_flow_target_evidence_read",
      () =>
        admin
          .rpc("read_oauth_flow_target_session_evidence", {
            p_flow_id: input.flowId,
            p_target_user_id: input.targetUserId,
            p_target_session_id: input.targetSessionId,
          })
          .abortSignal(AbortSignal.timeout(8_000)),
    );
    stored = parseOAuthFlowTargetEvidence(value, expected);
  } catch (error) {
    log.error("auth.oauth_flow_target_evidence_read_fail", {
      flowId: input.flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  if (!stored) {
    return response({ error: "oauth_flow_target_conflict" }, 409);
  }
  if (
    stored.accessTokenSha256 === input.accessTokenDigest &&
    stored.refreshTokenSha256 === input.refreshTokenDigest
  ) {
    return response(
      {
        ok: true,
        flowId: input.flowId,
        targetUserId: input.targetUserId,
        targetSessionId: input.targetSessionId,
      },
      200,
    );
  }

  try {
    const value = await requireSupabaseData<unknown>(
      "auth.oauth_flow_target_evidence_rotate",
      () =>
        admin
          .rpc("rotate_oauth_flow_target_session_evidence", {
            p_flow_id: input.flowId,
            p_target_user_id: input.targetUserId,
            p_target_session_id: input.targetSessionId,
            p_old_access_token_sha256:
              stored.accessTokenSha256,
            p_old_refresh_token_sha256:
              stored.refreshTokenSha256,
            p_new_access_token_sha256:
              input.accessTokenDigest,
            p_new_refresh_token_sha256:
              input.refreshTokenDigest,
          })
          .abortSignal(AbortSignal.timeout(8_000)),
    );
    if (!parseOAuthFlowRotateReceipt(value, expected)) {
      return response(
        { error: "oauth_flow_target_conflict" },
        409,
      );
    }
  } catch (error) {
    log.error("auth.oauth_flow_target_evidence_rotate_fail", {
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
      targetUserId: input.targetUserId,
      targetSessionId: input.targetSessionId,
    },
    200,
  );
}
