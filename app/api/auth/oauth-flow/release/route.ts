import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { readServerAuthUser } from "@/lib/http/server-auth-user";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  clearOAuthFlowCookies,
  readOAuthFlowRouteAuthority,
} from "@/lib/oauth-flow-route";
import { readOAuthFlowStatusStrict } from "@/lib/oauth-flow-admin";
import {
  parseOAuthFlowEvidenceVerification,
  type OAuthFlowStatus,
} from "@/lib/oauth-flow-status";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupabaseData } from "@/lib/supabase-operation";
import { migrateCookieName } from "@/lib/signup-cookie";
import { PUBLIC_ENV } from "@/lib/env";
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

function tokenDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseReleaseReceipt(
  value: unknown,
  flowId: string,
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
    receipt.flowId === flowId &&
    receipt.state === "completed" &&
    typeof receipt.releasedAt === "string" &&
    Number.isFinite(Date.parse(receipt.releasedAt))
  );
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
  let status: OAuthFlowStatus;
  try {
    status = await readOAuthFlowStatusStrict(
      authority.proof,
      AbortSignal.timeout(8_000),
    );
  } catch (error) {
    log.error("auth.oauth_flow_release_status_fail", {
      flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  if (
    ![
      "completed",
      "failed",
      "cancelled",
      "abandoned",
      "expired",
    ].includes(status.state)
  ) {
    return response({ error: "oauth_flow_not_terminal" }, 409);
  }
  if (
    status.state === "completed" &&
    status.action === "continue" &&
    status.revokeConfirmedAt !== null
  ) {
    // A cleanup path won the race and revoked the exact bound target. Never
    // collapse that result into the normal-release acknowledgement: the
    // caller must re-read status and replay the cleanup-specific route.
    return response(
      { error: "oauth_flow_cleanup_committed" },
      409,
    );
  }

  if (
    status.state === "completed" &&
    status.action === "continue"
  ) {
    // A committed release is idempotent cleanup authority. It must remain
    // replayable when the browser lost the response or has since installed an
    // unrelated Auth session. Only the first release commit needs the exact
    // bound target cookie and live/evidence checks.
    if (status.releasedAt === null) {
      const rawSession = await readSupabaseSessionCookieHeader(
        request.headers.get("cookie"),
        PUBLIC_ENV.SUPABASE_URL,
      );
      if (
        !status.targetUserId ||
        !status.targetSessionId ||
        rawSession.kind !== "present" ||
        rawSession.session.userId !== status.targetUserId ||
        rawSession.session.sessionId !==
          status.targetSessionId
      ) {
        return response({ error: "auth_session_changed" }, 409);
      }
      const accessTokenSha256 = tokenDigest(
        rawSession.session.accessToken,
      );
      const refreshTokenSha256 = tokenDigest(
        rawSession.session.refreshToken,
      );
      let verified: ReturnType<
        typeof parseOAuthFlowEvidenceVerification
      >;
      try {
        const verifyValue = await requireSupabaseData<unknown>(
          "auth.oauth_flow_release_verify",
          () =>
            createAdminClient()
              .rpc("verify_oauth_flow_target_session_evidence", {
                p_flow_id: flowId,
                p_target_user_id: status.targetUserId,
                p_target_session_id:
                  status.targetSessionId,
                p_access_token_sha256: accessTokenSha256,
                p_refresh_token_sha256:
                  refreshTokenSha256,
              })
              .abortSignal(AbortSignal.timeout(8_000)),
        );
        verified = parseOAuthFlowEvidenceVerification(
          verifyValue,
          flowId,
        );
      } catch (error) {
        log.error("auth.oauth_flow_release_verify_fail", {
          flowId,
          ...errInfo(error),
        });
        const result = response(
          { error: "auth_unavailable" },
          503,
        );
        result.headers.set("Retry-After", "60");
        return result;
      }
      if (!verified) {
        return response(
          { error: "oauth_flow_release_conflict" },
          409,
        );
      }
      if (verified.releasedAt === null) {
        const targetUser = await readServerAuthUser({
          accessToken: rawSession.session.accessToken,
          anonKey: PUBLIC_ENV.SUPABASE_ANON_KEY,
          signal: AbortSignal.timeout(8_000),
          supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
        });
        if (targetUser.kind === "unavailable") {
          const result = response(
            { error: "auth_unavailable" },
            503,
          );
          result.headers.set("Retry-After", "60");
          return result;
        }
        if (
          targetUser.kind !== "valid" ||
          targetUser.user.id !== status.targetUserId ||
          targetUser.user.is_anonymous
        ) {
          return response(
            { error: "auth_session_refresh_required" },
            409,
          );
        }
        try {
          const value = await requireSupabaseData<unknown>(
            "auth.oauth_flow_release",
            () =>
              createAdminClient()
                .rpc("release_oauth_flow_intent", {
                  p_flow_id: flowId,
                  p_target_user_id: status.targetUserId,
                  p_target_session_id:
                    status.targetSessionId,
                  p_access_token_sha256:
                    accessTokenSha256,
                  p_refresh_token_sha256:
                    refreshTokenSha256,
                })
                .abortSignal(AbortSignal.timeout(8_000)),
          );
          if (!parseReleaseReceipt(value, flowId)) {
            return response(
              { error: "oauth_flow_release_conflict" },
              409,
            );
          }
        } catch (error) {
          log.error("auth.oauth_flow_release_commit_fail", {
            flowId,
            ...errInfo(error),
          });
          const result = response(
            { error: "auth_unavailable" },
            503,
          );
          result.headers.set("Retry-After", "60");
          return result;
        }
      } else {
        // Evidence verification and this route's first status read are
        // separate transactions. Cleanup may have acquired the flow lock
        // between them and produced the same non-null releasedAt signal.
        // Re-read under the ledger's flow/source locks and acknowledge only a
        // normal release; cleanup-specific state must converge through its
        // own exact receipt.
        let committed;
        try {
          committed = await readOAuthFlowStatusStrict(
            authority.proof,
            AbortSignal.timeout(8_000),
          );
        } catch (error) {
          log.error(
            "auth.oauth_flow_release_recheck_fail",
            {
              flowId,
              ...errInfo(error),
            },
          );
          const result = response(
            { error: "auth_unavailable" },
            503,
          );
          result.headers.set("Retry-After", "60");
          return result;
        }
        if (committed.revokeConfirmedAt !== null) {
          return response(
            { error: "oauth_flow_cleanup_committed" },
            409,
          );
        }
        if (
          committed.state !== "completed" ||
          committed.action !== "continue" ||
          committed.releasedAt === null ||
          committed.targetUserId !== status.targetUserId ||
          committed.targetSessionId !==
            status.targetSessionId
        ) {
          return response(
            { error: "oauth_flow_release_conflict" },
            409,
          );
        }
        status = committed;
      }
    }
  } else if (status.state === "completed") {
    return response(
      { error: "oauth_flow_not_releasable" },
      409,
    );
  }

  const result = response({ ok: true, flowId }, 200);
  clearOAuthFlowCookies(result, flowId);
  if (
    status.state !== "completed" ||
    status.action === "signout"
  ) {
    result.cookies.set(migrateCookieName(flowId), "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/",
      maxAge: 0,
    });
  }
  return result;
}
