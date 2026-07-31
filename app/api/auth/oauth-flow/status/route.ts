import { createHash } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { browserMutationOriginAllowed } from "@/lib/browser-mutation-origin";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import {
  parseRawCookieHeaderForPrefixes,
} from "@/lib/http/raw-cookie-header";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import { readServerAuthUser } from "@/lib/http/server-auth-user";
import { deploymentIdentityHeaders } from "@/lib/deployment-identity";
import {
  OAUTH_FLOW_COOKIE_PREFIX,
  OAUTH_FLOW_PROOF_COOKIE_PREFIX,
} from "@/lib/cookies";
import {
  isOAuthFlowId,
  OAUTH_FLOW_MAX_AGE_SECONDS,
} from "@/lib/oauth-flow-lease";
import {
  signOAuthFlowRecoveryProof,
} from "@/lib/oauth-flow-proof";
import {
  clearOAuthFlowCookies,
  discoverOAuthFlowRouteAuthority,
  readOAuthFlowRouteAuthority,
  setOAuthFlowRecoveryCookies,
  type OAuthFlowRouteAuthority,
} from "@/lib/oauth-flow-route";
import {
  OAuthFlowStatusNotFoundError,
  readOAuthFlowStatusStrict,
} from "@/lib/oauth-flow-admin";
import {
  oauthFlowStatusNeedsRecoveryAuthority,
  parseOAuthFlowEvidenceVerification,
  parseOAuthFlowDiscoveredAuthority,
  parseOAuthFlowDiscoveryAbsent,
  parseOAuthFlowMinimalRecovery,
  parseOAuthFlowRecoveredAuthority,
  parseOAuthFlowSourceEvidenceVerification,
  type OAuthFlowMinimalRecovery,
  type OAuthFlowStatus,
} from "@/lib/oauth-flow-status";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireSupabaseData } from "@/lib/supabase-operation";
import { migrateCookieName } from "@/lib/signup-cookie";
import { PUBLIC_ENV } from "@/lib/env";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 30;

function response(
  body: Record<string, unknown>,
  status: number,
): NextResponse {
  return NextResponse.json(body, {
    status,
    headers: {
      ...deploymentIdentityHeaders(),
      "Cache-Control": "private, no-store, max-age=0",
    },
  });
}

function tokenDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function recoveryCookieShapeAllowed(
  cookieHeader: string | null,
  flowId: string,
): boolean {
  const shape = discoverCookieShapeFlowId(cookieHeader);
  return shape.kind === "absent" || (
    shape.kind === "flow" && shape.flowId === flowId
  );
}

type CookieShapeFlow =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "flow"; flowId: string };

function discoverCookieShapeFlowId(
  cookieHeader: string | null,
): CookieShapeFlow {
  const parsed = parseRawCookieHeaderForPrefixes(
    cookieHeader,
    [
      OAUTH_FLOW_COOKIE_PREFIX,
      OAUTH_FLOW_PROOF_COOKIE_PREFIX,
    ],
  );
  if (parsed.kind !== "ok") return { kind: "invalid" };
  const markers = parsed.cookies.filter(({ name }) =>
    name.startsWith(OAUTH_FLOW_COOKIE_PREFIX),
  );
  const proofs = parsed.cookies.filter(({ name }) =>
    name.startsWith(OAUTH_FLOW_PROOF_COOKIE_PREFIX),
  );
  if (markers.length === 0 && proofs.length === 0) {
    return { kind: "absent" };
  }
  if (markers.length > 1 || proofs.length > 1) {
    return { kind: "invalid" };
  }
  const markerFlowId = markers.length === 1
    ? markers[0].name.slice(OAUTH_FLOW_COOKIE_PREFIX.length)
    : null;
  const proofFlowId = proofs.length === 1
    ? proofs[0].name.slice(
        OAUTH_FLOW_PROOF_COOKIE_PREFIX.length,
      )
    : null;
  if (
    (markerFlowId !== null &&
      (!isOAuthFlowId(markerFlowId) ||
        markers[0].value !== markerFlowId)) ||
    (proofFlowId !== null && !isOAuthFlowId(proofFlowId)) ||
    (markerFlowId !== null &&
      proofFlowId !== null &&
      markerFlowId !== proofFlowId)
  ) {
    return { kind: "invalid" };
  }
  const flowId = markerFlowId ?? proofFlowId;
  return flowId === null
    ? { kind: "invalid" }
    : { kind: "flow", flowId };
}

async function recoverByObservedSession(options: {
  flowId: string;
  observedUserId: string | null;
  observedSessionId: string | null;
}): Promise<unknown> {
  return requireSupabaseData<unknown>(
    "auth.oauth_flow_authority_recover",
    () =>
      createAdminClient()
        .rpc("recover_oauth_flow_intent_authority", {
          p_flow_id: options.flowId,
          p_observed_user_id: options.observedUserId,
          p_observed_session_id: options.observedSessionId,
        })
        .abortSignal(AbortSignal.timeout(8_000)),
  );
}

async function recoverActiveByObservedSession(options: {
  observedUserId: string;
  observedSessionId: string;
}): Promise<unknown> {
  return requireSupabaseData<unknown>(
    "auth.oauth_flow_active_authority_recover",
    () =>
      createAdminClient()
        .rpc("recover_active_oauth_flow_by_observed_session", {
          p_observed_user_id: options.observedUserId,
          p_observed_session_id: options.observedSessionId,
        })
        .abortSignal(AbortSignal.timeout(8_000)),
  );
}

function exactRecoveredSignoutComplete(
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
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    record.ok === true &&
    record.flowId === flowId &&
    record.state === "completed" &&
    typeof record.destination === "string"
  );
}

async function finishMinimalRecovery(
  minimal: OAuthFlowMinimalRecovery,
): Promise<OAuthFlowMinimalRecovery | null> {
  if (minimal.state !== "signout_revoked") return minimal;
  const value = await requireSupabaseData<unknown>(
    "auth.oauth_flow_recovered_signout_complete",
    () =>
      createAdminClient()
        .rpc("complete_recovered_oauth_flow_signout", {
          p_flow_id: minimal.flowId,
        })
        .abortSignal(AbortSignal.timeout(8_000)),
  );
  return exactRecoveredSignoutComplete(value, minimal.flowId)
    ? {
        flowId: minimal.flowId,
        state: "completed",
        active: false,
      }
    : null;
}

async function expiredObservedEvidenceMatches(options: {
  flowId: string;
  role: "source" | "target";
  userId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
}): Promise<boolean> {
  const value = await requireSupabaseData<unknown>(
    "auth.oauth_flow_target_evidence_recover",
    () =>
      createAdminClient()
        .rpc(
          options.role === "source"
            ? "verify_oauth_flow_source_session_evidence"
            : "verify_oauth_flow_target_session_evidence",
          options.role === "source"
            ? {
                p_flow_id: options.flowId,
                p_source_user_id: options.userId,
                p_source_session_id: options.sessionId,
                p_access_token_sha256: tokenDigest(
                  options.accessToken,
                ),
                p_refresh_token_sha256: tokenDigest(
                  options.refreshToken,
                ),
              }
            : {
                p_flow_id: options.flowId,
                p_target_user_id: options.userId,
                p_target_session_id: options.sessionId,
                p_access_token_sha256: tokenDigest(
                  options.accessToken,
                ),
                p_refresh_token_sha256: tokenDigest(
                  options.refreshToken,
                ),
              },
        )
        .abortSignal(AbortSignal.timeout(8_000)),
  );
  return options.role === "source"
    ? parseOAuthFlowSourceEvidenceVerification(
        value,
        options.flowId,
      ) !== null
    : parseOAuthFlowEvidenceVerification(
        value,
        options.flowId,
      ) !== null;
}

async function observedSessionProvesRecoveryAuthority(options: {
  flowId: string;
  role: "source" | "target";
  userId: string;
  sessionId: string;
  accessToken: string;
  refreshToken: string;
  expectedAnonymous: boolean;
}): Promise<boolean> {
  const auth = await readServerAuthUser({
    accessToken: options.accessToken,
    anonKey: PUBLIC_ENV.SUPABASE_ANON_KEY,
    signal: AbortSignal.timeout(8_000),
    supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
  });
  if (auth.kind === "valid") {
    return (
      auth.user.id === options.userId &&
      auth.user.is_anonymous === options.expectedAnonymous
    );
  }
  if (auth.kind === "unavailable") return false;
  try {
    return await expiredObservedEvidenceMatches({
      flowId: options.flowId,
      role: options.role,
      userId: options.userId,
      sessionId: options.sessionId,
      accessToken: options.accessToken,
      refreshToken: options.refreshToken,
    });
  } catch (error) {
    log.error("auth.oauth_flow_reissue_evidence_fail", {
      flowId: options.flowId,
      ...errInfo(error),
    });
    return false;
  }
}

function fullStatusResponse(
  status: OAuthFlowStatus,
  authority: OAuthFlowRouteAuthority,
): NextResponse {
  const result = response({ ok: true, ...status }, 200);
  setOAuthFlowRecoveryCookies(result, authority);
  return result;
}

function absentFlowResponse(flowId: string): NextResponse {
  return minimalFlowResponse({
    flowId,
    state: "absent",
    active: false,
  });
}

function minimalFlowResponse(
  minimal: OAuthFlowMinimalRecovery,
): NextResponse {
  const result = response({ ok: true, ...minimal }, 200);
  const flowId = minimal.flowId;
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

export async function POST(request: NextRequest) {
  if (!browserMutationOriginAllowed(request.url, request.headers)) {
    return response({ error: "forbidden_origin" }, 403);
  }
  const body = await readApiJsonObjectRequest(request);
  if (!body.ok) return response({ error: body.error }, body.status);
  const keys = Object.keys(body.value);
  const requestedFlowId = body.value.flowId;
  if (
    keys.length !== 1 ||
    keys[0] !== "flowId" ||
    (
      requestedFlowId !== null &&
      !isOAuthFlowId(requestedFlowId)
    )
  ) {
    return response({ error: "invalid_body" }, 400);
  }

  const header = request.headers.get("cookie");
  const cookieShape = discoverCookieShapeFlowId(header);
  if (cookieShape.kind === "invalid") {
    return response({ error: "oauth_flow_proof_invalid" }, 409);
  }
  const discoveredAuthority =
    requestedFlowId === null
      ? discoverOAuthFlowRouteAuthority({
          cookieHeader: header,
          recovery: true,
          secret: SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
        })
      : null;
  const flowId =
    requestedFlowId ??
    discoveredAuthority?.proof.flowId ??
    (cookieShape.kind === "flow"
      ? cookieShape.flowId
      : null);
  const raw = await readSupabaseSessionCookieHeader(
    header,
    PUBLIC_ENV.SUPABASE_URL,
  );
  const existing =
    flowId === null
      ? null
      : readOAuthFlowRouteAuthority({
          cookieHeader: header,
          flowId,
          recovery: true,
          secret: SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
        });

  if (flowId === null) {
    if (raw.kind === "invalid") {
      return response({ error: "auth_session_invalid" }, 409);
    }
    if (raw.kind === "absent") {
      return response(
        { ok: true, state: "absent", active: false },
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
      auth.kind === "valid" &&
      auth.user.id !== raw.session.userId
    ) {
      return response({ error: "auth_session_changed" }, 409);
    }
    let recoveredValue: unknown;
    try {
      recoveredValue = await recoverActiveByObservedSession({
        observedUserId: raw.session.userId,
        observedSessionId: raw.session.sessionId,
      });
    } catch (error) {
      log.error("auth.oauth_flow_active_discovery_fail", {
        ...errInfo(error),
      });
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }
    if (parseOAuthFlowDiscoveryAbsent(recoveredValue)) {
      return response(
        { ok: true, state: "absent", active: false },
        200,
      );
    }
    const recovered =
      parseOAuthFlowDiscoveredAuthority(recoveredValue);
    if (!recovered) {
      return response({ error: "oauth_flow_proof_invalid" }, 409);
    }
    const status = recovered.status;
    const observedIsSource =
      raw.session.userId === recovered.sourceUserId &&
      raw.session.sessionId === recovered.sourceSessionId;
    const observedIsTarget =
      raw.session.userId === status.targetUserId &&
      raw.session.sessionId === status.targetSessionId;
    if (!observedIsSource && !observedIsTarget) {
      return response({ error: "auth_session_changed" }, 409);
    }
    if (
      auth.kind === "valid" &&
      auth.user.is_anonymous !==
        (observedIsSource
          ? status.sourceIsAnonymous
          : false)
    ) {
      return response({ error: "auth_session_changed" }, 409);
    }
    if (auth.kind === "invalid") {
      let exactExpiredObserved = false;
      try {
        exactExpiredObserved =
          await expiredObservedEvidenceMatches({
            flowId: status.flowId,
            role: observedIsTarget ? "target" : "source",
            userId: raw.session.userId,
            sessionId: raw.session.sessionId,
            accessToken: raw.session.accessToken,
            refreshToken: raw.session.refreshToken,
          });
      } catch (error) {
        log.error(
          "auth.oauth_flow_active_discovery_evidence_fail",
          {
            flowId: status.flowId,
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
      if (!exactExpiredObserved) {
        return response({ error: "auth_session_changed" }, 409);
      }
    }
    const now = Date.now();
    const signed = signOAuthFlowRecoveryProof(
      {
        flowId: status.flowId,
        sourceUserId: recovered.sourceUserId,
        sourceSessionId: recovered.sourceSessionId,
        sourceIsAnonymous: status.sourceIsAnonymous,
        provider: status.provider,
      },
      SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
      now + OAUTH_FLOW_MAX_AGE_SECONDS * 1_000,
      now,
    );
    return fullStatusResponse(status, {
      markerPresent: true,
      proof: signed.proof,
      proofValue: signed.value,
    });
  }

  if (existing) {
    try {
      const status = await readOAuthFlowStatusStrict(
        existing.proof,
        AbortSignal.timeout(8_000),
      );
      let observedRole: "source" | "target" | null = null;
      if (raw.kind === "present") {
        const sourceMatches =
          raw.session.userId ===
            existing.proof.sourceUserId &&
          raw.session.sessionId ===
            existing.proof.sourceSessionId;
        const targetMatches =
          raw.session.userId === status.targetUserId &&
          raw.session.sessionId ===
            status.targetSessionId;
        observedRole = sourceMatches
          ? "source"
          : targetMatches
            ? "target"
            : null;
      }
      let refreshedAuthority = existing;
      if (
        observedRole !== null &&
        oauthFlowStatusNeedsRecoveryAuthority(status)
      ) {
        const proven =
          raw.kind === "present" &&
          await observedSessionProvesRecoveryAuthority({
            flowId,
            role: observedRole,
            userId: raw.session.userId,
            sessionId: raw.session.sessionId,
            accessToken: raw.session.accessToken,
            refreshToken: raw.session.refreshToken,
            expectedAnonymous:
              observedRole === "source"
                ? status.sourceIsAnonymous
                : false,
          });
        if (proven) {
          const now = Date.now();
          const signed = signOAuthFlowRecoveryProof(
            {
              flowId,
              sourceUserId:
                existing.proof.sourceUserId,
              sourceSessionId:
                existing.proof.sourceSessionId,
              sourceIsAnonymous:
                existing.proof.sourceIsAnonymous,
              provider: existing.proof.provider,
            },
            SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
            now + OAUTH_FLOW_MAX_AGE_SECONDS * 1_000,
            now,
          );
          refreshedAuthority = {
            markerPresent: true,
            proof: signed.proof,
            proofValue: signed.value,
          };
        }
      }
      return fullStatusResponse(status, refreshedAuthority);
    } catch (error) {
      if (error instanceof OAuthFlowStatusNotFoundError) {
        return absentFlowResponse(flowId);
      }
      log.error("auth.oauth_flow_status_fail", {
        flowId,
        ...errInfo(error),
      });
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }
  }

  if (raw.kind === "invalid") {
    return response({ error: "auth_session_invalid" }, 409);
  }

  if (!recoveryCookieShapeAllowed(header, flowId)) {
    return response({ error: "oauth_flow_proof_invalid" }, 409);
  }

  let recoveredValue: unknown;
  try {
    recoveredValue = await recoverByObservedSession({
      flowId,
      observedUserId:
        raw.kind === "present" ? raw.session.userId : null,
      observedSessionId:
        raw.kind === "present" ? raw.session.sessionId : null,
    });
  } catch (error) {
    log.error("auth.oauth_flow_authority_recover_fail", {
      flowId,
      ...errInfo(error),
    });
    const result = response({ error: "auth_unavailable" }, 503);
    result.headers.set("Retry-After", "60");
    return result;
  }

  const absent = parseOAuthFlowMinimalRecovery(
    recoveredValue,
    flowId,
  );
  if (absent?.state === "absent") {
    return absentFlowResponse(flowId);
  }
  if (absent !== null && !absent.active) {
    return minimalFlowResponse(absent);
  }

  if (raw.kind === "absent") {
    const parsed = absent;
    if (!parsed) {
      return response({ error: "oauth_flow_proof_invalid" }, 409);
    }
    let completed;
    try {
      completed = await finishMinimalRecovery(parsed);
    } catch (error) {
      log.error("auth.oauth_flow_minimal_recovery_fail", {
        flowId,
        ...errInfo(error),
      });
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }
    if (!completed) {
      return response({ error: "auth_unavailable" }, 503);
    }
    const result = response(
      {
        ok: true,
        flowId,
        state: completed.state,
        active: completed.active,
      },
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

  const recovered = parseOAuthFlowRecoveredAuthority(
    recoveredValue,
    flowId,
  );
  if (!recovered) {
    return response({ error: "oauth_flow_proof_invalid" }, 409);
  }
  const status = recovered.status;
  const observedIsSource =
    raw.session.userId === recovered.sourceUserId &&
    raw.session.sessionId === recovered.sourceSessionId;
  const observedIsBoundTarget =
    raw.session.userId === status.targetUserId &&
    raw.session.sessionId === status.targetSessionId;
  const observedIsTerminalTargetRecovery =
    raw.session.userId === status.targetUserId &&
    status.state === "completed" &&
    status.action === "continue" &&
    status.sourceIsAnonymous &&
    status.releasedAt !== null &&
    status.revokeConfirmedAt === null &&
    status.migrationConsumedAt !== null;
  const observedIsTarget =
    observedIsBoundTarget ||
    observedIsTerminalTargetRecovery;
  if (!observedIsSource && !observedIsTarget) {
    return response({ error: "auth_session_changed" }, 409);
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
    auth.kind === "valid" &&
    (auth.user.id !== raw.session.userId ||
      auth.user.is_anonymous !==
        (observedIsSource
          ? status.sourceIsAnonymous
          : false))
  ) {
    return response({ error: "auth_session_changed" }, 409);
  }
  if (auth.kind === "invalid") {
    let exactExpiredObserved = false;
    try {
      exactExpiredObserved =
        await expiredObservedEvidenceMatches({
        flowId,
        role: observedIsTarget ? "target" : "source",
        userId: raw.session.userId,
        sessionId: raw.session.sessionId,
        accessToken: raw.session.accessToken,
        refreshToken: raw.session.refreshToken,
      });
    } catch (error) {
      log.error("auth.oauth_flow_expired_target_recover_fail", {
        flowId,
        ...errInfo(error),
      });
      const result = response({ error: "auth_unavailable" }, 503);
      result.headers.set("Retry-After", "60");
      return result;
    }
    if (!exactExpiredObserved) {
      return response({ error: "auth_session_changed" }, 409);
    }
  }

  let signed;
  try {
    const now = Date.now();
    signed = signOAuthFlowRecoveryProof(
      {
        flowId,
        sourceUserId: recovered.sourceUserId,
        sourceSessionId: recovered.sourceSessionId,
        sourceIsAnonymous: status.sourceIsAnonymous,
        provider: status.provider,
      },
      SERVER_ENV.SUPABASE_SERVICE_ROLE_KEY,
      now + OAUTH_FLOW_MAX_AGE_SECONDS * 1_000,
      now,
    );
  } catch {
    return response({ error: "oauth_flow_proof_invalid" }, 409);
  }
  return fullStatusResponse(status, {
    markerPresent: true,
    proof: signed.proof,
    proofValue: signed.value,
  });
}
