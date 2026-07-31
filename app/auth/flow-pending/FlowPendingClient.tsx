"use client";

import { useEffect, useState } from "react";
import {
  clearBrowserSupabaseAuthStorage,
  clearBrowserSupabaseOAuthVerifierStorage,
  assertBrowserSupabaseOAuthVerifierStorageCleared,
  assertBrowserSupabaseSessionCleared,
  OAuthRecoveryRefreshAmbiguousError,
  OAuthRecoveryRefreshRejectedError,
  BrowserSupabaseSessionCorruptError,
  parseOAuthRecoveryRefreshAuthority,
  readBrowserSupabaseSessionSnapshot,
  refreshBrowserSupabaseSessionForOAuthRecovery,
  startSupabaseUnlockedSessionWriter,
  type BrowserSupabaseSessionSnapshot,
} from "@/lib/supabase/client";
import {
  reconcileOAuthFlowBrowserBarrier,
  readOAuthFlowBrowserBarrier,
} from "@/lib/oauth-flow-browser-barrier";
import {
  forgetOAuthFlowLease,
  isOAuthFlowId,
} from "@/lib/oauth-flow-lease";
import {
  readExactVisibleOAuthCallbackFlow,
} from "@/lib/http/auth-transport-fetch";
import {
  parseOAuthFlowDiscoveryAbsent,
  parseOAuthFlowDiscoveredStatus,
  parseOAuthFlowFinalizeReceipt,
  parseOAuthFlowMinimalRecovery,
  parseOAuthFlowRevokeBoundTargetReceipt,
  parseOAuthFlowStatus,
  type OAuthFlowRevokeBoundTargetReceipt,
  type OAuthFlowFinalizeReceipt,
  type OAuthFlowStatus,
} from "@/lib/oauth-flow-status";
import {
  readBoundedClientJsonResponse,
} from "@/lib/client-mutation";
import {
  runAuthCrossContextExclusive,
} from "@/lib/auth-cross-context";
import { clearProfileCache } from "@/lib/profile";
import { clearSentryIdentity } from "@/lib/sentry-context";

const ATTEMPT_TIMEOUT_MS = 12_000;
const RECOVERY_TIMEOUT_MS = 70_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

type JsonHttpResult = {
  response: Response;
  value: unknown;
};

function exactRecord(
  value: unknown,
  keys: readonly string[],
): value is Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const actual = Object.keys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => keys.includes(key))
  );
}

function retryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

function isRecoveryRefreshTerminalError(
  error: unknown,
): error is
  | OAuthRecoveryRefreshRejectedError
  | OAuthRecoveryRefreshAmbiguousError {
  return (
    error instanceof OAuthRecoveryRefreshRejectedError ||
    error instanceof OAuthRecoveryRefreshAmbiguousError
  );
}

async function postJson(
  path: string,
  body: Record<string, unknown>,
  outerSignal: AbortSignal,
): Promise<JsonHttpResult> {
  let lastError: unknown = new Error(
    "oauth_recovery_response_unconfirmed",
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const signal = AbortSignal.any([
      outerSignal,
      AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    ]);
    try {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal,
      });
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      const parsed = await readBoundedClientJsonResponse(
        response,
        MAX_RESPONSE_BYTES,
        signal,
      );
      if (contentType !== "application/json" || !parsed.ok) {
        throw new Error("oauth_recovery_response_invalid");
      }
      if (
        attempt === 0 &&
        retryableStatus(response.status)
      ) {
        lastError = new Error(
          `oauth_recovery_http_${response.status}`,
        );
        continue;
      }
      return { response, value: parsed.value };
    } catch (error) {
      lastError = error;
      if (outerSignal.aborted) throw error;
    }
  }
  throw lastError;
}

function exactFlowAck(
  value: unknown,
  flowId: string,
): boolean {
  return (
    exactRecord(value, ["ok", "flowId"]) &&
    value.ok === true &&
    value.flowId === flowId
  );
}

function exactTerminalOutcomeAck(
  value: unknown,
  flowId: string,
  outcome: "cancelled" | "expired" | "absent" | "abandoned",
): boolean {
  return (
    exactRecord(value, ["ok", "flowId", "outcome"]) &&
    value.ok === true &&
    value.flowId === flowId &&
    value.outcome === outcome
  );
}

function exactRotateAck(
  value: unknown,
  expected: {
    flowId: string;
    targetUserId: string;
    targetSessionId: string;
  },
): boolean {
  return (
    exactRecord(value, [
      "ok",
      "flowId",
      "targetUserId",
      "targetSessionId",
    ]) &&
    value.ok === true &&
    value.flowId === expected.flowId &&
    value.targetUserId === expected.targetUserId &&
    value.targetSessionId === expected.targetSessionId
  );
}

function exactSignoutAck(
  value: unknown,
  expected: {
    flowId: string;
    targetUserId: string;
    targetSessionId: string;
  },
): boolean {
  return (
    exactRecord(value, [
      "ok",
      "flowId",
      "userId",
      "sessionId",
    ]) &&
    value.ok === true &&
    value.flowId === expected.flowId &&
    value.userId === expected.targetUserId &&
    value.sessionId === expected.targetSessionId
  );
}

function exactCompleteSignoutAck(
  value: unknown,
  flowId: string,
  destination: string,
): boolean {
  return (
    exactRecord(value, ["ok", "flowId", "destination"]) &&
    value.ok === true &&
    value.flowId === flowId &&
    value.destination === destination
  );
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function snapshotDigests(
  snapshot: BrowserSupabaseSessionSnapshot,
): Promise<{
  accessTokenDigest: string;
  refreshTokenDigest: string;
}> {
  const [accessTokenDigest, refreshTokenDigest] =
    await Promise.all([
      sha256Hex(snapshot.evidence.accessToken),
      sha256Hex(snapshot.evidence.refreshToken),
    ]);
  return { accessTokenDigest, refreshTokenDigest };
}

function resolveRecoveryFlow(
  requestedFlowId: string | null,
  queryInvalid: boolean,
): string | null {
  if (queryInvalid) {
    throw new Error("oauth_recovery_query_invalid");
  }
  let durable: string | null = null;
  try {
    durable = readOAuthFlowBrowserBarrier();
  } catch {
    // A malformed record can be repaired only after status authenticates the
    // requested/visible flow. Do not discard those independent flow IDs.
  }
  const visible = readExactVisibleOAuthCallbackFlow();
  const candidates = [
    requestedFlowId,
    durable,
    visible,
  ].filter((value): value is string => value !== null);
  if (
    !candidates.every(
      (candidate) => candidate === candidates[0],
    ) ||
    (
      candidates.length > 0 &&
      !isOAuthFlowId(candidates[0])
    )
  ) {
    throw new Error("oauth_recovery_flow_ambiguous");
  }
  return candidates[0] ?? null;
}

function ensureDurableBarrier(flowId: string): void {
  reconcileOAuthFlowBrowserBarrier(flowId, true);
  if (readOAuthFlowBrowserBarrier() !== flowId) {
    throw new Error("oauth_recovery_barrier_unavailable");
  }
}

function terminalNavigate(
  flowId: string,
  destination: string,
): void {
  if (readExactVisibleOAuthCallbackFlow() !== null) {
    throw new Error("oauth_recovery_marker_not_released");
  }
  clearBrowserSupabaseOAuthVerifierStorage();
  assertBrowserSupabaseOAuthVerifierStorageCleared();
  try {
    forgetOAuthFlowLease(flowId);
  } catch {
    // Same-tab owner bookkeeping is not callback authority. Its document ID
    // intentionally makes cloned/old realms non-removable.
  }
  reconcileOAuthFlowBrowserBarrier(flowId, false);
  if (readOAuthFlowBrowserBarrier() !== null) {
    throw new Error("oauth_recovery_barrier_not_released");
  }
  window.location.replace(destination);
}

function terminalNavigateAfterDiscoveryAbsent(): void {
  if (readExactVisibleOAuthCallbackFlow() !== null) {
    throw new Error("oauth_recovery_marker_not_released");
  }
  // A malformed or unreadable durable record could be the only surviving
  // identifier of a fenced DB flow. Queryless/sessionless absence cannot
  // prove that flow does not exist, so it must never authorize deleting that
  // record. Only an exactly readable null barrier may resume ordinary Auth.
  if (readOAuthFlowBrowserBarrier() !== null) {
    throw new Error("oauth_recovery_barrier_not_released");
  }
  clearBrowserSupabaseOAuthVerifierStorage();
  assertBrowserSupabaseOAuthVerifierStorageCleared();
  window.location.replace("/");
}

function clearExactTargetSession(): void {
  clearBrowserSupabaseAuthStorage();
  assertBrowserSupabaseSessionCleared();
  clearProfileCache();
  clearSentryIdentity();
}

async function validateOrRotateTarget(options: {
  flowId: string;
  targetUserId: string;
  targetSessionId: string;
  signal: AbortSignal;
}): Promise<{
  snapshot: BrowserSupabaseSessionSnapshot;
  accessTokenDigest: string;
  refreshTokenDigest: string;
}> {
  let snapshot = await readBrowserSupabaseSessionSnapshot();
  if (
    !snapshot ||
    snapshot.evidence.userId !== options.targetUserId ||
    snapshot.evidence.sessionId !== options.targetSessionId
  ) {
    throw new Error("oauth_recovery_target_changed");
  }
  let digests = await snapshotDigests(snapshot);
  let result = await postJson(
    "/api/auth/oauth-flow/rotate-target",
    {
      flowId: options.flowId,
      targetUserId: options.targetUserId,
      targetSessionId: options.targetSessionId,
      ...digests,
    },
    options.signal,
  );
  if (
    result.response.status === 409
  ) {
    const refreshAuthority =
      parseOAuthRecoveryRefreshAuthority(
        result.response,
        result.value,
      );
    if (!refreshAuthority) {
      throw new Error("oauth_recovery_target_conflict");
    }
    const refreshed =
      await refreshBrowserSupabaseSessionForOAuthRecovery(
        {
          userId: options.targetUserId,
          sessionId: options.targetSessionId,
        },
        refreshAuthority,
        options.signal,
      );
    snapshot = await readBrowserSupabaseSessionSnapshot();
    if (
      !snapshot ||
      snapshot.evidence.userId !== options.targetUserId ||
      snapshot.evidence.sessionId !==
        options.targetSessionId
    ) {
      throw new Error("oauth_recovery_refresh_commit_changed");
    }
    digests = await snapshotDigests(snapshot);
    if (
      refreshed.accessTokenSha256 !==
        digests.accessTokenDigest ||
      refreshed.refreshTokenSha256 !==
        digests.refreshTokenDigest
    ) {
      throw new Error("oauth_recovery_refresh_digest_changed");
    }
    result = await postJson(
      "/api/auth/oauth-flow/rotate-target",
      {
        flowId: options.flowId,
        targetUserId: options.targetUserId,
        targetSessionId: options.targetSessionId,
        ...digests,
      },
      options.signal,
    );
  }
  if (
    result.response.status !== 200 ||
    !exactRotateAck(result.value, options)
  ) {
    throw new Error("oauth_recovery_target_unconfirmed");
  }
  return { snapshot, ...digests };
}

async function releaseFlow(
  flowId: string,
  signal: AbortSignal,
  target?: {
    targetUserId: string;
    targetSessionId: string;
  },
): Promise<void> {
  let result = await postJson(
    "/api/auth/oauth-flow/release",
    { flowId },
    signal,
  );
  if (result.response.status === 409 && target) {
    const refreshAuthority =
      parseOAuthRecoveryRefreshAuthority(
        result.response,
        result.value,
      );
    if (refreshAuthority) {
      await refreshBrowserSupabaseSessionForOAuthRecovery(
        {
          userId: target.targetUserId,
          sessionId: target.targetSessionId,
        },
        refreshAuthority,
        signal,
      );
      await validateOrRotateTarget({
        flowId,
        ...target,
        signal,
      });
      result = await postJson(
        "/api/auth/oauth-flow/release",
        { flowId },
        signal,
      );
    }
  }
  if (
    result.response.status !== 200 ||
    !exactFlowAck(result.value, flowId)
  ) {
    throw new Error("oauth_recovery_release_unconfirmed");
  }
}

async function revokeBoundTarget(
  flowId: string,
  signal: AbortSignal,
): Promise<OAuthFlowRevokeBoundTargetReceipt> {
  const result = await postJson(
    "/api/auth/oauth-flow/revoke-bound-target",
    { flowId },
    signal,
  );
  const receipt = parseOAuthFlowRevokeBoundTargetReceipt(
    result.value,
    flowId,
  );
  if (result.response.status !== 200 || !receipt) {
    throw new Error(
      "oauth_recovery_bound_target_revoke_unconfirmed",
    );
  }
  return receipt;
}

async function signoutAndComplete(options: {
  flowId: string;
  targetUserId: string;
  targetSessionId: string;
  destination: string;
  signal: AbortSignal;
}): Promise<void> {
  const signout = await postJson(
    "/api/auth/oauth-flow/signout",
    {
      flowId: options.flowId,
      expectedUserId: options.targetUserId,
      expectedSessionId: options.targetSessionId,
    },
    options.signal,
  );
  if (
    signout.response.status !== 200 ||
    !exactSignoutAck(signout.value, options)
  ) {
    throw new Error("oauth_recovery_signout_unconfirmed");
  }
  clearExactTargetSession();
  const complete = await postJson(
    "/api/auth/oauth-flow/complete-signout",
    { flowId: options.flowId },
    options.signal,
  );
  if (
    complete.response.status !== 200 ||
    !exactCompleteSignoutAck(
      complete.value,
      options.flowId,
      options.destination,
    )
  ) {
    throw new Error(
      "oauth_recovery_signout_complete_unconfirmed",
    );
  }
}

async function finalizeClaimed(options: {
  status: OAuthFlowStatus;
  target: Awaited<
    ReturnType<typeof validateOrRotateTarget>
  >;
  signal: AbortSignal;
}): Promise<OAuthFlowFinalizeReceipt> {
  const result = await postJson(
    "/api/auth/oauth-flow/finalize",
    {
      flowId: options.status.flowId,
      provider: options.status.provider,
      next: options.status.requestedNext,
      exchangeOutcome: "completed",
      failureCode: null,
      expectedTargetUserId:
        options.target.snapshot.evidence.userId,
      expectedTargetSessionId:
        options.target.snapshot.evidence.sessionId,
      expectedAccessTokenDigest:
        options.target.accessTokenDigest,
      expectedRefreshTokenDigest:
        options.target.refreshTokenDigest,
    },
    options.signal,
  );
  const receipt = parseOAuthFlowFinalizeReceipt(
    result.value,
    options.status.flowId,
  );
  if (result.response.status !== 200 || !receipt) {
    throw new Error("oauth_recovery_finalize_unconfirmed");
  }
  return receipt;
}

function snapshotMatchesStatusTarget(
  snapshot: BrowserSupabaseSessionSnapshot | null,
  status: OAuthFlowStatus,
): snapshot is BrowserSupabaseSessionSnapshot {
  return (
    snapshot !== null &&
    status.targetUserId !== null &&
    status.targetSessionId !== null &&
    snapshot.evidence.userId === status.targetUserId &&
    snapshot.evidence.sessionId === status.targetSessionId
  );
}

async function revokeBoundTargetAndFinish(
  status: OAuthFlowStatus,
  snapshot: BrowserSupabaseSessionSnapshot | null,
  signal: AbortSignal,
): Promise<void> {
  if (
    status.targetUserId === null ||
    status.targetSessionId === null
  ) {
    // Auth may have committed an external target before the application ever
    // learned its identity. A flow ID/proof cannot identify that session, so
    // automatic abandonment or broad revocation would be unsafe. Keep the
    // durable fence for manual review and alerting.
    throw new Error("oauth_recovery_claimed_target_unbound");
  }
  const receipt = await revokeBoundTarget(
    status.flowId,
    signal,
  );
  if (snapshotMatchesStatusTarget(snapshot, status)) {
    clearExactTargetSession();
  }
  terminalNavigate(status.flowId, receipt.destination);
}

async function validateTargetOrRevoke(
  status: OAuthFlowStatus,
  snapshot: BrowserSupabaseSessionSnapshot,
  signal: AbortSignal,
): Promise<
  Awaited<ReturnType<typeof validateOrRotateTarget>> | null
> {
  if (
    status.targetUserId === null ||
    status.targetSessionId === null
  ) {
    throw new Error("oauth_recovery_target_unbound");
  }
  try {
    return await validateOrRotateTarget({
      flowId: status.flowId,
      targetUserId: status.targetUserId,
      targetSessionId: status.targetSessionId,
      signal,
    });
  } catch (error) {
    if (!isRecoveryRefreshTerminalError(error)) {
      throw error;
    }
    await revokeBoundTargetAndFinish(status, snapshot, signal);
    return null;
  }
}

async function recoverFullStatus(
  status: OAuthFlowStatus,
  signal: AbortSignal,
): Promise<void> {
  const flowId = status.flowId;
  let snapshot: BrowserSupabaseSessionSnapshot | null;
  try {
    snapshot = await readBrowserSupabaseSessionSnapshot();
  } catch (error) {
    if (!(error instanceof BrowserSupabaseSessionCorruptError)) {
      throw error;
    }
    // An exact proof-bound full receipt authorizes repair of structurally
    // unusable Auth storage. Browser IO/SecurityError remains fail-closed.
    clearExactTargetSession();
    snapshot = null;
  }
  const targetMatches = snapshotMatchesStatusTarget(
    snapshot,
    status,
  );

  if (status.state === "pending") {
    // Cancellation is proof/source/provider-bound in the ledger and never
    // touches the current Auth session, so absent and unrelated sessions are
    // equivalent here.
    const cancelled = await postJson(
      "/api/auth/oauth-flow/cancel",
      { flowId, provider: status.provider },
      signal,
    );
    if (
      cancelled.response.status !== 200 ||
      !(
        exactTerminalOutcomeAck(
          cancelled.value,
          flowId,
          "cancelled",
        ) ||
        exactTerminalOutcomeAck(
          cancelled.value,
          flowId,
          "expired",
        ) ||
        exactTerminalOutcomeAck(
          cancelled.value,
          flowId,
          "absent",
        )
      )
    ) {
      throw new Error("oauth_recovery_cancel_unconfirmed");
    }
    terminalNavigate(flowId, status.requestedNext);
    return;
  }

  if (status.state === "claimed") {
    if (
      status.targetUserId === null ||
      status.targetSessionId === null
    ) {
      throw new Error("oauth_recovery_claimed_target_unbound");
    }
    if (!snapshotMatchesStatusTarget(snapshot, status)) {
      await revokeBoundTargetAndFinish(status, snapshot, signal);
      return;
    }
    const target = await validateTargetOrRevoke(
      status,
      snapshot,
      signal,
    );
    if (target === null) return;
    const receipt = await finalizeClaimed({
      status,
      target,
      signal,
    });
    if (
      receipt.targetUserId === null ||
      receipt.targetSessionId === null
    ) {
      throw new Error("oauth_recovery_finalize_target_missing");
    }
    if (receipt.action === "signout") {
      await signoutAndComplete({
        flowId,
        targetUserId: receipt.targetUserId,
        targetSessionId: receipt.targetSessionId,
        destination: receipt.destination,
        signal,
      });
    } else {
      try {
        await releaseFlow(flowId, signal, {
          targetUserId: receipt.targetUserId,
          targetSessionId: receipt.targetSessionId,
        });
      } catch (error) {
        if (!isRecoveryRefreshTerminalError(error)) {
          throw error;
        }
        await revokeBoundTargetAndFinish(
          status,
          snapshot,
          signal,
        );
        return;
      }
    }
    terminalNavigate(flowId, receipt.destination);
    return;
  }

  if (status.state === "signout_required") {
    if (
      status.targetUserId === null ||
      status.targetSessionId === null ||
      status.destination === null
    ) {
      throw new Error("oauth_recovery_signout_target_missing");
    }
    if (!snapshotMatchesStatusTarget(snapshot, status)) {
      await revokeBoundTargetAndFinish(status, snapshot, signal);
      return;
    }
    const target = await validateTargetOrRevoke(
      status,
      snapshot,
      signal,
    );
    if (target === null) return;
    await signoutAndComplete({
      flowId,
      targetUserId: status.targetUserId,
      targetSessionId: status.targetSessionId,
      destination: status.destination,
      signal,
    });
    terminalNavigate(flowId, status.destination);
    return;
  }

  if (
    status.state === "signout_revoked" ||
    (
      status.state === "completed" &&
      status.action === "signout"
    )
  ) {
    if (
      status.targetUserId === null ||
      status.targetSessionId === null ||
      status.destination === null
    ) {
      throw new Error("oauth_recovery_signout_target_missing");
    }
    if (targetMatches) clearExactTargetSession();
    const complete = await postJson(
      "/api/auth/oauth-flow/complete-signout",
      { flowId },
      signal,
    );
    if (
      complete.response.status !== 200 ||
      !exactCompleteSignoutAck(
        complete.value,
        flowId,
        status.destination,
      )
    ) {
      throw new Error(
        "oauth_recovery_signout_complete_unconfirmed",
      );
    }
    terminalNavigate(flowId, status.destination);
    return;
  }

  if (
    status.state === "completed" &&
    status.action === "continue"
  ) {
    if (
      status.targetUserId === null ||
      status.targetSessionId === null ||
      status.destination === null
    ) {
      throw new Error("oauth_recovery_completed_target_missing");
    }
    if (status.releasedAt !== null) {
      // Normal released continue preserves the installed target. A
      // cleanup-revoked continue clears only that exact stale target; an
      // absent or unrelated current session is preserved.
      if (status.revokeConfirmedAt !== null) {
        const receipt = await revokeBoundTarget(
          flowId,
          signal,
        );
        if (targetMatches) clearExactTargetSession();
        terminalNavigate(flowId, receipt.destination);
        return;
      }
      await releaseFlow(flowId, signal);
      terminalNavigate(flowId, status.destination);
      return;
    }
    if (!snapshotMatchesStatusTarget(snapshot, status)) {
      await revokeBoundTargetAndFinish(status, snapshot, signal);
      return;
    }
    const target = await validateTargetOrRevoke(
      status,
      snapshot,
      signal,
    );
    if (target === null) return;
    try {
      await releaseFlow(flowId, signal, {
        targetUserId: status.targetUserId,
        targetSessionId: status.targetSessionId,
      });
    } catch (error) {
      if (!isRecoveryRefreshTerminalError(error)) {
        throw error;
      }
      await revokeBoundTargetAndFinish(
        status,
        snapshot,
        signal,
      );
      return;
    }
    terminalNavigate(flowId, status.destination);
    return;
  }

  if (
    ["failed", "cancelled", "abandoned", "expired"].includes(
      status.state,
    )
  ) {
    await releaseFlow(flowId, signal);
    terminalNavigate(
      flowId,
      status.destination ?? status.requestedNext,
    );
    return;
  }

  throw new Error("oauth_recovery_state_unhandled");
}

async function runRecovery(options: {
  requestedFlowId: string | null;
  queryInvalid: boolean;
  signal: AbortSignal;
}): Promise<void> {
  const flowId = resolveRecoveryFlow(
    options.requestedFlowId,
    options.queryInvalid,
  );
  await runAuthCrossContextExclusive(
    options.signal,
    () =>
      startSupabaseUnlockedSessionWriter(
        options.signal,
        async () => {
          const statusResult = await postJson(
            "/api/auth/oauth-flow/status",
            { flowId },
            options.signal,
          );
          if (statusResult.response.status !== 200) {
            throw new Error(
              `oauth_recovery_status_${statusResult.response.status}`,
            );
          }
          if (
            flowId === null &&
            parseOAuthFlowDiscoveryAbsent(statusResult.value)
          ) {
            terminalNavigateAfterDiscoveryAbsent();
            return;
          }
          const discoveredStatus =
            flowId === null
              ? parseOAuthFlowDiscoveredStatus(
                  statusResult.value,
                )
              : null;
          const recoveredFlowId =
            flowId ?? discoveredStatus?.flowId ?? null;
          if (recoveredFlowId === null) {
            throw new Error(
              "oauth_recovery_discovery_response_invalid",
            );
          }
          const minimal = parseOAuthFlowMinimalRecovery(
            statusResult.value,
            recoveredFlowId,
          );
          if (minimal) {
            try {
              await readBrowserSupabaseSessionSnapshot();
            } catch (error) {
              if (
                !(
                  error instanceof
                  BrowserSupabaseSessionCorruptError
                )
              ) {
                throw error;
              }
              // Only this exact terminal/minimal server receipt authorizes
              // deleting an unparseable local Supabase session.
              clearExactTargetSession();
            }
            if (
              minimal.active ||
              readExactVisibleOAuthCallbackFlow() !== null
            ) {
              throw new Error(
                "oauth_recovery_minimal_postcondition_failed",
              );
            }
            let durable: string | null = null;
            try {
              durable = readOAuthFlowBrowserBarrier();
            } catch {
              // The exact terminal receipt authorizes targeted repair below.
            }
            if (
              durable !== null &&
              durable !== recoveredFlowId
            ) {
              throw new Error(
                "oauth_recovery_barrier_changed",
              );
            }
            terminalNavigate(recoveredFlowId, "/");
            return;
          }
          const status =
            discoveredStatus ??
            parseOAuthFlowStatus(
              statusResult.value,
              recoveredFlowId,
            );
          if (!status) {
            throw new Error("oauth_recovery_status_invalid");
          }
          if (
            readExactVisibleOAuthCallbackFlow() !==
              recoveredFlowId
          ) {
            throw new Error(
              "oauth_recovery_marker_not_confirmed",
            );
          }
          ensureDurableBarrier(recoveredFlowId);
          await recoverFullStatus(status, options.signal);
        },
      ),
  );
}

export function FlowPendingClient({
  requestedFlowId,
  queryInvalid,
}: {
  requestedFlowId: string | null;
  queryInvalid: boolean;
}) {
  const [waiting, setWaiting] = useState(true);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    const deadline = AbortSignal.timeout(RECOVERY_TIMEOUT_MS);
    const signal = AbortSignal.any([
      controller.signal,
      deadline,
    ]);
    let retry: ReturnType<typeof setTimeout> | null = null;
    void runRecovery({
      requestedFlowId,
      queryInvalid,
      signal,
    }).catch(() => {
      if (controller.signal.aborted) return;
      setWaiting(false);
      setFailed(true);
      retry = setTimeout(() => {
        setWaiting(true);
        setFailed(false);
        setAttempt((value) => value + 1);
      }, 5_000);
    });
    return () => {
      controller.abort(new Error("oauth_recovery_unmounted"));
      if (retry) clearTimeout(retry);
    };
  }, [attempt, queryInvalid, requestedFlowId]);

  return (
    <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      <h1 className="text-xl font-semibold">
        로그인 마무리 중
      </h1>
      <p className="text-sm text-neutral-600">
        이전 로그인 응답을 원장과 대조하고 있어요. 이 화면을 닫지
        않으면 자동으로 계속 확인합니다.
      </p>
      {failed && (
        <p role="alert" className="text-sm text-red-500">
          아직 안전한 완료 상태를 확인하지 못했어요. 보존된 상태로
          다시 확인합니다.
        </p>
      )}
      <button
        type="button"
        className="rounded-md border px-4 py-2 text-sm"
        disabled={waiting}
        onClick={() => {
          setWaiting(true);
          setFailed(false);
          setAttempt((value) => value + 1);
        }}
      >
        {waiting ? "확인 중…" : "지금 다시 확인"}
      </button>
    </main>
  );
}
