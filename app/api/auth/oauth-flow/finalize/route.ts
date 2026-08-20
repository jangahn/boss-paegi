import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractOAuthProfile, safeNext } from "@/lib/oauth-metadata";
import { syncOAuthProfile } from "@/lib/account-onboard";
import {
  missingConsentItems,
  type ConsentMember,
} from "@/lib/consent";
import {
  resolveDbRead,
  resolveRequiredDbRead,
  type AuthReadSource,
} from "@/lib/auth-read-policy";
import {
  requireSupabaseData,
  requireSupabaseSuccess,
} from "@/lib/supabase-operation";
import { log, errInfo } from "@/lib/log";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  type OAuthFlowProvider,
} from "@/lib/oauth-flow-proof";
import {
  readOAuthFlowRouteAuthority,
} from "@/lib/oauth-flow-route";
import { readOAuthFlowStatusStrict } from "@/lib/oauth-flow-admin";
import {
  parseOAuthFlowFinalizeReceipt,
  type OAuthFlowFinalizeReceipt,
  type OAuthFlowStatus,
} from "@/lib/oauth-flow-status";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { readServerAuthUser } from "@/lib/http/server-auth-user";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";

export const runtime = "nodejs";
export const maxDuration = 60;

const NO_STORE = {
  "Cache-Control": "private, no-store, max-age=0",
} as const;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/u;

type FailureCode =
  | "identity_already_exists"
  | "provider_error"
  | "missing_code"
  | "exchange_error";

type FinalizeInput = {
  flowId: string;
  provider: OAuthFlowProvider;
  next: string;
  exchangeOutcome: "completed" | "failed";
  failureCode: FailureCode | null;
  expectedTargetUserId: string | null;
  expectedTargetSessionId: string | null;
  expectedAccessTokenDigest: string | null;
  expectedRefreshTokenDigest: string | null;
};

function response(
  body: Record<string, unknown>,
  status: number,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: NO_STORE,
  });
}

function parseInput(value: unknown): FinalizeInput | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const input = value as Record<string, unknown>;
  const keys = Object.keys(input);
  const failureCodes: readonly unknown[] = [
    "identity_already_exists",
    "provider_error",
    "missing_code",
    "exchange_error",
  ];
  const expectedValues = [
    input.expectedTargetUserId,
    input.expectedTargetSessionId,
    input.expectedAccessTokenDigest,
    input.expectedRefreshTokenDigest,
  ];
  const completedEvidence =
    typeof input.expectedTargetUserId === "string" &&
    UUID_RE.test(input.expectedTargetUserId) &&
    typeof input.expectedTargetSessionId === "string" &&
    UUID_RE.test(input.expectedTargetSessionId) &&
    typeof input.expectedAccessTokenDigest === "string" &&
    SHA256_HEX_RE.test(input.expectedAccessTokenDigest) &&
    typeof input.expectedRefreshTokenDigest === "string" &&
    SHA256_HEX_RE.test(input.expectedRefreshTokenDigest);
  if (
    keys.length !== 9 ||
    ![
      "flowId",
      "provider",
      "next",
      "exchangeOutcome",
      "failureCode",
      "expectedTargetUserId",
      "expectedTargetSessionId",
      "expectedAccessTokenDigest",
      "expectedRefreshTokenDigest",
    ].every((key) => keys.includes(key)) ||
    !isOAuthFlowId(input.flowId) ||
    (input.provider !== "kakao" && input.provider !== "google") ||
    typeof input.next !== "string" ||
    input.next.length > 2_048 ||
    safeNext(input.next) !== input.next ||
    (input.exchangeOutcome !== "completed" &&
      input.exchangeOutcome !== "failed") ||
    (input.failureCode !== null &&
      !failureCodes.includes(input.failureCode)) ||
    (input.exchangeOutcome === "completed"
      ? input.failureCode !== null || !completedEvidence
      : input.failureCode === null ||
        expectedValues.some((item) => item !== null))
  ) {
    return null;
  }
  return input as FinalizeInput;
}

function failureDestination(input: FinalizeInput): string {
  if (input.failureCode === "identity_already_exists") {
    return (
      `/login?auto=${input.provider}` +
      `&next=${encodeURIComponent(input.next)}`
    );
  }
  return input.failureCode === "exchange_error"
    ? "/login?error=exchange"
    : "/login?error=oauth";
}

function tokenDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function receiptFromStatus(
  status: OAuthFlowStatus,
): OAuthFlowFinalizeReceipt | null {
  if (
    ![
      "completed",
      "failed",
      "signout_required",
      "signout_revoked",
    ].includes(status.state) ||
    !status.destination ||
    !status.action
  ) {
    return null;
  }
  const outcome =
    status.state === "failed" ? "failed" : "completed";
  if (
    (outcome === "failed" &&
      (status.targetUserId !== null ||
        status.targetSessionId !== null ||
        status.action !== "continue")) ||
    (outcome === "completed" &&
      (!status.targetUserId || !status.targetSessionId))
  ) {
    return null;
  }
  return {
    outcome,
    targetUserId: status.targetUserId,
    targetSessionId: status.targetSessionId,
    destination: status.destination,
    action: status.action,
  };
}

function finalizeResponse(
  flowId: string,
  receipt: OAuthFlowFinalizeReceipt,
): NextResponse {
  // The durable receipt and recovery proof remain until a separate release or
  // signout-complete ACK. A lost JSON body can therefore always be recovered.
  return response(
    {
      ok: true,
      flowId,
      outcome: receipt.outcome,
      targetUserId: receipt.targetUserId,
      targetSessionId: receipt.targetSessionId,
      destination: receipt.destination,
      action: receipt.action,
    },
    200,
  );
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
    provider: input.provider,
    recovery: true,
    secret: SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
  });
  if (!authority) {
    return response({ error: "oauth_flow_proof_invalid" }, 409);
  }

  const routeDeadline = AbortSignal.timeout(42_000);
  const admin = createAdminClient();
  let status: OAuthFlowStatus;
  try {
    status = await readOAuthFlowStatusStrict(
      authority.proof,
      AbortSignal.timeout(8_000),
    );
  } catch (error) {
    log.error("auth.oauth_flow_finalize_status_fail", {
      flowId: input.flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
  if (
    status.provider !== input.provider ||
    status.requestedNext !== input.next
  ) {
    return response({ error: "oauth_flow_input_conflict" }, 409);
  }
  const terminal = receiptFromStatus(status);
  if (terminal) return finalizeResponse(input.flowId, terminal);
  if (status.state !== "claimed") {
    return response({ error: "oauth_flow_not_finalizable" }, 409);
  }

  let decision: OAuthFlowFinalizeReceipt;
  if (input.exchangeOutcome === "failed") {
    const raw = await readSupabaseSessionCookieHeader(
      request.headers.get("cookie"),
      PUBLIC_ENV.SUPABASE_URL,
    );
    if (
      raw.kind !== "present" ||
      raw.session.userId !== authority.proof.sourceUserId ||
      raw.session.sessionId !==
        authority.proof.sourceSessionId
    ) {
      return response(
        { error: "oauth_failure_source_session_changed" },
        409,
      );
    }
    decision = {
      outcome: "failed",
      targetUserId: null,
      targetSessionId: null,
      destination: failureDestination(input),
      action: "continue",
    };
  } else {
    const raw = await readSupabaseSessionCookieHeader(
      request.headers.get("cookie"),
      PUBLIC_ENV.SUPABASE_URL,
    );
    if (raw.kind !== "present") {
      return response({ error: "auth_session_invalid" }, 409);
    }
    const cookieSession = raw.session;
    if (
      cookieSession.userId !== input.expectedTargetUserId ||
      cookieSession.sessionId !==
        input.expectedTargetSessionId ||
      tokenDigest(cookieSession.accessToken) !==
        input.expectedAccessTokenDigest ||
      tokenDigest(cookieSession.refreshToken) !==
        input.expectedRefreshTokenDigest ||
      (cookieSession.userId === authority.proof.sourceUserId &&
        cookieSession.sessionId ===
          authority.proof.sourceSessionId)
    ) {
      return response({ error: "auth_session_changed" }, 409);
    }
    // The bearer-token validity read and the identities-bearing admin read
    // are independent verifications of the same session. Run them together;
    // both results are still checked with unchanged semantics below.
    const fullUserPending = requireSupabaseSuccess(
      "auth.oauth_finalize_full_user",
      () =>
        admin.auth.admin.getUserById(cookieSession.userId),
    ).then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error: error as unknown }),
    );
    const authRead = await readServerAuthUser({
      accessToken: cookieSession.accessToken,
      anonKey: PUBLIC_ENV.SUPABASE_ANON_KEY,
      signal: AbortSignal.timeout(8_000),
      supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
    });
    if (authRead.kind === "unavailable") {
      await fullUserPending;
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }
    if (
      authRead.kind !== "valid" ||
      authRead.user.id !== cookieSession.userId ||
      authRead.user.is_anonymous
    ) {
      await fullUserPending;
      return response({ error: "auth_session_changed" }, 409);
    }

    let user;
    try {
      const settledFull = await fullUserPending;
      if (!settledFull.ok) throw settledFull.error;
      const full = settledFull.value;
      if (
        !full.data.user ||
        full.data.user.id !== cookieSession.userId ||
        full.data.user.is_anonymous === true
      ) {
        throw new Error("auth_user_missing");
      }
      user = full.data.user;
    } catch (error) {
      log.error("auth.oauth_finalize_full_user_fail", {
        userId: cookieSession.userId,
        ...errInfo(error),
      });
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }

    const profile = extractOAuthProfile(user);
    let destination = input.next;
    let action: "continue" | "signout" = "continue";
    let dependencyFailed = false;
    const readRetry = (
      source: AuthReadSource,
      readError: unknown,
    ) => {
      dependencyFailed = true;
      log.error("auth.oauth_finalize_read_fail", {
        userId: user.id,
        source,
        ...errInfo(readError),
      });
    };

    // The three authority reads are data-independent. Start them together so
    // the finalize hot path pays one round trip instead of three; each branch
    // below still consumes its own settled result with unchanged attribution.
    const settleRead = <T,>(read: Promise<T>) =>
      read.then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error: error as unknown }),
      );
    const profilePending = settleRead(
      Promise.resolve(
        admin
          .from("profiles")
          .select("deleted_at")
          .eq("id", user.id)
          .abortSignal(routeDeadline)
          .maybeSingle(),
      ),
    );
    const memberPending = settleRead(
      Promise.resolve(
        admin
          .from("member_accounts")
          .select(
            "age_confirmed_at, terms_agreed_at, privacy_agreed_at, email",
          )
          .eq("user_id", user.id)
          .abortSignal(routeDeadline)
          .maybeSingle(),
      ),
    );

    let profileResult;
    {
      const settled = await profilePending;
      if (settled.ok) {
        profileResult = settled.value;
      } else {
        readRetry("profile", settled.error);
      }
    }
    if (profileResult !== undefined) {
      const profileRead = resolveRequiredDbRead(
        "profile",
        profileResult,
      );
      if (!profileRead.ok) {
        readRetry(profileRead.source, profileRead.error);
      } else if (
        (
          profileRead.data as {
            deleted_at?: string | null;
          } | null
        )?.deleted_at
      ) {
        destination = "/login?error=account_deleted";
        action = "signout";
      }
    }

    if (
      !dependencyFailed &&
      action === "continue" &&
      (!profile.email || !profile.emailVerified)
    ) {
      destination = "/login?error=email_required";
      action = "signout";
    }

    if (!dependencyFailed && action === "continue") {
      let memberResult;
      {
        const settled = await memberPending;
        if (settled.ok) {
          memberResult = settled.value;
        } else {
          readRetry("member", settled.error);
        }
      }
      if (memberResult !== undefined) {
        const memberRead = resolveDbRead("member", memberResult);
        if (!memberRead.ok) {
          readRetry(memberRead.source, memberRead.error);
        } else {
          const memberRow = memberRead.data as {
            age_confirmed_at: string | null;
            terms_agreed_at: string | null;
            privacy_agreed_at: string | null;
            email: string | null;
          } | null;
          if (!dependencyFailed) {
            if (memberRow && profile.email) {
              try {
                await syncOAuthProfile(
                  admin,
                  user.id,
                  profile,
                  routeDeadline,
                );
              } catch (error) {
                readRetry("member", error);
              }
            }
            const member: ConsentMember = memberRow
              ? {
                  age_confirmed_at:
                    memberRow.age_confirmed_at,
                  terms_agreed_at: memberRow.terms_agreed_at,
                  privacy_agreed_at: memberRow.privacy_agreed_at,
                }
              : null;
            if (
              !dependencyFailed &&
              missingConsentItems(member).length > 0
            ) {
              const consentDestination =
                `/consent?next=${encodeURIComponent(input.next)}`;
              destination = authority.proof.sourceIsAnonymous
                ? consentDestination +
                  `&migrationFlow=${encodeURIComponent(input.flowId)}`
                : consentDestination;
            }
          }
        }
      }
    }
    if (dependencyFailed) {
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }
    decision = {
      outcome: "completed",
      targetUserId: cookieSession.userId,
      targetSessionId: cookieSession.sessionId,
      destination,
      action,
    };
  }

  try {
    const value = await requireSupabaseData<unknown>(
      "auth.oauth_flow_finalize",
      () =>
        admin
          .rpc("finalize_oauth_flow_intent", {
            p_flow_id: input.flowId,
            p_source_user_id: authority.proof.sourceUserId,
            p_source_session_id:
              authority.proof.sourceSessionId,
            p_provider: authority.proof.provider,
            p_requested_next: input.next,
            p_outcome: decision.outcome,
            p_target_user_id: decision.targetUserId,
            p_target_session_id: decision.targetSessionId,
            p_target_access_token_sha256:
              input.expectedAccessTokenDigest,
            p_target_refresh_token_sha256:
              input.expectedRefreshTokenDigest,
            p_destination: decision.destination,
            p_action: decision.action,
          })
          .abortSignal(AbortSignal.timeout(8_000)),
    );
    const finalized = parseOAuthFlowFinalizeReceipt(
      value,
      input.flowId,
    );
    if (!finalized) {
      const error =
        value &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        typeof (value as Record<string, unknown>).error ===
          "string"
          ? (value as Record<string, unknown>).error
          : null;
      return response(
        {
          error:
            error === "oauth_flow_finalize_conflict"
              ? error
              : "auth_unavailable",
        },
        error === "oauth_flow_finalize_conflict" ? 409 : 503,
      );
    }
    return finalizeResponse(input.flowId, finalized);
  } catch (error) {
    log.error("auth.oauth_flow_finalize_fail", {
      flowId: input.flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }
}
