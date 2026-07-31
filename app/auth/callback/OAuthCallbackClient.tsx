"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  assertBrowserSupabaseOAuthVerifierStorageCleared,
  assertBrowserSupabaseSessionCleared,
  clearBrowserSupabaseAuthStorage,
  clearBrowserSupabaseOAuthVerifierStorage,
  OAuthCallbackExchangeAmbiguousError,
  resumeOAuthCallbackTerminalCleanup,
  runOAuthCallbackAuthLifecycle,
  type OAuthCallbackAuthClient,
  type OAuthCallbackExchangeEvidence,
} from "@/lib/supabase/client";
import {
  readBoundedClientJsonResponse,
} from "@/lib/client-mutation";
import {
  isDefinitiveHttpRejectionStatus,
} from "@/lib/http/definitive-http-rejection";
import {
  clearProfileCache,
} from "@/lib/profile";
import {
  clearSentryIdentity,
} from "@/lib/sentry-context";
import {
  isOAuthFlowId,
  OAuthFlowLeaseError,
} from "@/lib/oauth-flow-lease";
import { safeNext } from "@/lib/oauth-metadata";
import {
  clearOAuthFlowBrowserBarrier,
  readOAuthFlowBrowserBarrier,
} from "@/lib/oauth-flow-browser-barrier";
import {
  browserHasVisibleOAuthFlowMarker,
  readExactVisibleOAuthCallbackFlow,
} from "@/lib/http/auth-transport-fetch";

type Provider = "kakao" | "google";
type FailureCode =
  | "identity_already_exists"
  | "provider_error"
  | "missing_code"
  | "exchange_error";
type ExchangeDecision =
  | {
      exchangeOutcome: "completed";
      failureCode: null;
      evidence: OAuthCallbackExchangeEvidence;
    }
  | {
      exchangeOutcome: "failed";
      failureCode: FailureCode;
      evidence: null;
    };
type FinalizeReceipt = {
  flowId: string;
  outcome: "completed" | "failed";
  destination: string;
  action: "continue" | "signout";
  targetUserId: string | null;
  targetSessionId: string | null;
};
type CallbackMemory = {
  fingerprint: string;
  decision: ExchangeDecision | null;
  receipt: FinalizeReceipt | null;
  terminalDestination: string | null;
  destination: string | null;
  running: Promise<void> | null;
  finished: boolean;
  recoveryRequired: boolean;
};
type CallbackInput = {
  code: string | null;
  errorCode:
    | "identity_already_exists"
    | "provider_error"
    | null;
  flowId: string | null;
  next: string;
  provider: Provider | null;
};

const CALLBACK_MEMORY_KEY = Symbol.for(
  "boss-paegi.oauth-callback-runner.v3",
);
const CALLBACK_BOOTSTRAP_QUERY_KEY = Symbol.for(
  "boss-paegi.oauth-callback-bootstrap-query.v1",
);
const CALLBACK_DEADLINE_MS = 80_000;
const CALLBACK_ATTEMPT_MS = 12_000;
const CALLBACK_MAX_RESPONSE_BYTES = 64 * 1024;
const callbackGlobals =
  globalThis as unknown as Record<symbol, unknown>;

class OAuthCallbackDefinitiveHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`oauth_callback_http_${status}`);
    this.name = "OAuthCallbackDefinitiveHttpError";
    this.status = status;
  }
}

function invalidCallbackInput(): CallbackInput {
  return {
    code: null,
    errorCode: null,
    flowId: null,
    next: "/",
    provider: null,
  };
}

function captureCallbackInput(): CallbackInput {
  if (typeof window === "undefined") {
    return invalidCallbackInput();
  }
  const retained =
    callbackGlobals[CALLBACK_BOOTSTRAP_QUERY_KEY];
  delete callbackGlobals[CALLBACK_BOOTSTRAP_QUERY_KEY];
  const rawQuery =
    typeof retained === "string"
      ? retained
      : null;
  try {
    if (
      window.location.search !== "" ||
      window.location.hash !== ""
    ) {
      // Bypass Next's patched instance method: the already-loaded callback
      // payload owns this query and must not trigger a second code-less RSC.
      History.prototype.replaceState.call(
        window.history,
        null,
        "",
        window.location.pathname,
      );
    }
  } catch {
    return invalidCallbackInput();
  }
  if (
    rawQuery === null ||
    rawQuery.length === 0 ||
    rawQuery.length > 16_384 ||
    !rawQuery.startsWith("?") ||
    /[\u0000-\u001f\u007f]/u.test(rawQuery) ||
    /%(?![0-9a-f]{2})/iu.test(rawQuery)
  ) {
    return invalidCallbackInput();
  }
  const params = new URLSearchParams(rawQuery.slice(1));
  const single = (key: string): string | null => {
    const values = params.getAll(key);
    return values.length === 1 ? values[0] : null;
  };
  const rawProvider = single("p");
  const provider =
    rawProvider === "kakao" || rawProvider === "google"
      ? rawProvider
      : null;
  const rawFlowId = single("flow");
  const flowId =
    rawFlowId !== null && isOAuthFlowId(rawFlowId)
      ? rawFlowId
      : null;
  const rawCode = single("code");
  const code =
    rawCode !== null &&
    /^[A-Za-z0-9._~-]{1,2048}$/u.test(rawCode)
      ? rawCode
      : null;
  const errorValues = params.getAll("error_code");
  const errorCode =
    errorValues.length === 0
      ? null
      : errorValues.length === 1 &&
          errorValues[0] === "identity_already_exists"
        ? "identity_already_exists"
        : "provider_error";
  return {
    code,
    errorCode,
    flowId,
    next: safeNext(single("next")),
    provider,
  };
}

const callbackInput = captureCallbackInput();

function callbackMemory(): Map<string, CallbackMemory> {
  const retained = callbackGlobals[CALLBACK_MEMORY_KEY];
  if (retained instanceof Map) {
    return retained as Map<string, CallbackMemory>;
  }
  const created = new Map<string, CallbackMemory>();
  callbackGlobals[CALLBACK_MEMORY_KEY] = created;
  return created;
}

async function opaqueFingerprint(
  value: string | null,
): Promise<string | null> {
  if (value === null) return null;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

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

function exactInternalDestination(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  try {
    const target = new URL(value, window.location.origin);
    return (
      target.origin === window.location.origin &&
      target.username === "" &&
      target.password === "" &&
      target.hash === "" &&
      target.pathname + target.search === value
    );
  } catch {
    return false;
  }
}

function parseFlowAck(
  value: unknown,
  flowId: string,
): string | null {
  return exactRecord(value, ["ok", "flowId"]) &&
    value.ok === true &&
    value.flowId === flowId
    ? flowId
    : null;
}

function parsePreflightAck(
  value: unknown,
  flowId: string,
): { userId: string; sessionId: string } | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "sourceUserId",
      "sourceSessionId",
    ]) ||
    value.ok !== true ||
    value.flowId !== flowId ||
    !isOAuthFlowId(value.sourceUserId) ||
    !isOAuthFlowId(value.sourceSessionId)
  ) {
    return null;
  }
  return {
    userId: value.sourceUserId,
    sessionId: value.sourceSessionId,
  };
}

function parseBindTargetAck(
  value: unknown,
  flowId: string,
  evidence: OAuthCallbackExchangeEvidence,
): boolean {
  return (
    exactRecord(value, [
      "ok",
      "flowId",
      "targetUserId",
      "targetSessionId",
    ]) &&
    value.ok === true &&
    value.flowId === flowId &&
    value.targetUserId === evidence.userId &&
    value.targetSessionId === evidence.sessionId
  );
}

function parseFinalizeReceipt(
  value: unknown,
  flowId: string,
  decision: ExchangeDecision,
): FinalizeReceipt | null {
  if (
    !exactRecord(value, [
      "ok",
      "flowId",
      "outcome",
      "targetUserId",
      "targetSessionId",
      "destination",
      "action",
    ]) ||
    value.ok !== true ||
    value.flowId !== flowId ||
    value.outcome !== decision.exchangeOutcome ||
    !exactInternalDestination(value.destination) ||
    (value.action !== "continue" &&
      value.action !== "signout") ||
    (decision.exchangeOutcome === "completed"
      ? value.targetUserId !== decision.evidence.userId ||
        value.targetSessionId !== decision.evidence.sessionId
      : value.targetUserId !== null ||
        value.targetSessionId !== null) ||
    (value.action === "signout" &&
      (typeof value.targetUserId !== "string" ||
        typeof value.targetSessionId !== "string"))
  ) {
    return null;
  }
  return {
    flowId,
    outcome: value.outcome as "completed" | "failed",
    destination: value.destination,
    action: value.action,
    targetUserId: value.targetUserId as string | null,
    targetSessionId: value.targetSessionId as string | null,
  };
}

function parseSignOutAck(
  value: unknown,
  receipt: FinalizeReceipt,
): boolean {
  return (
    exactRecord(value, [
      "ok",
      "flowId",
      "userId",
      "sessionId",
    ]) &&
    value.ok === true &&
    value.flowId === receipt.flowId &&
    value.userId === receipt.targetUserId &&
    value.sessionId === receipt.targetSessionId
  );
}

function parseCompleteSignOutAck(
  value: unknown,
  expected: FinalizeReceipt,
): string | null {
  return exactRecord(value, [
    "ok",
    "flowId",
    "destination",
  ]) &&
    value.ok === true &&
    value.flowId === expected.flowId &&
    value.destination === expected.destination &&
    exactInternalDestination(value.destination)
    ? value.destination
    : null;
}

function retryableResponse(response: Response): boolean {
  return (
    response.ok ||
    response.status === 408 ||
    response.status === 425 ||
    response.status === 429 ||
    response.status >= 500
  );
}

async function replayExactJson<T>(options: {
  path: string;
  body?: string;
  signal: AbortSignal;
  parse: (value: unknown) => T | null;
}): Promise<T> {
  let lastError: unknown = new Error(
    "oauth_callback_request_unconfirmed",
  );
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (options.signal.aborted) {
      throw (
        options.signal.reason ??
        new Error("oauth_callback_aborted")
      );
    }
    const signal = AbortSignal.any([
      options.signal,
      AbortSignal.timeout(CALLBACK_ATTEMPT_MS),
    ]);
    let mayRetry = true;
    try {
      // Await the actual fetch and bounded body drain. H is never released
      // merely because a timer fired while the browser still owns a response.
      const response = await fetch(options.path, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        headers: {
          accept: "application/json",
          ...(options.body === undefined
            ? {}
            : { "content-type": "application/json" }),
        },
        ...(options.body === undefined
          ? {}
          : { body: options.body }),
        signal,
      });
      const contentType = response.headers
        .get("content-type")
        ?.split(";", 1)[0]
        .trim()
        .toLowerCase();
      const parsed = await readBoundedClientJsonResponse(
        response,
        CALLBACK_MAX_RESPONSE_BYTES,
        signal,
      );
      const receipt =
        response.status === 200 &&
        contentType === "application/json" &&
        parsed.ok
          ? options.parse(parsed.value)
          : null;
      if (receipt !== null) return receipt;
      mayRetry = retryableResponse(response);
      lastError =
        isDefinitiveHttpRejectionStatus(
          response.status,
        )
          ? new OAuthCallbackDefinitiveHttpError(
              response.status,
            )
          : new Error(
              `oauth_callback_http_${response.status}`,
            );
      if (!mayRetry) throw lastError;
    } catch (error) {
      lastError = error;
      if (options.signal.aborted) throw error;
      if (!mayRetry) throw error;
    }
  }
  throw lastError;
}

async function executeSignOut(
  receipt: FinalizeReceipt,
  auth: OAuthCallbackAuthClient,
  signal: AbortSignal,
): Promise<string> {
  if (
    receipt.targetUserId === null ||
    receipt.targetSessionId === null
  ) {
    throw new Error("oauth_callback_signout_target_missing");
  }
  await replayExactJson({
    path: "/api/auth/oauth-flow/signout",
    body: JSON.stringify({
      flowId: receipt.flowId,
      expectedUserId: receipt.targetUserId,
      expectedSessionId: receipt.targetSessionId,
    }),
    signal,
    parse: (value) =>
      parseSignOutAck(value, receipt) ? true : null,
  });

  // The authoritative server response has already revoked this exact session
  // without writing delayed Set-Cookie tombstones. Browser-owned deterministic
  // clearing happens under the still-held H→S, and is proven before local
  // scope can inspect storage or issue an unexpected /logout.
  clearBrowserSupabaseAuthStorage();
  const local = await auth.signOut({ scope: "local" });
  if (
    !exactRecord(local, ["error"]) ||
    local.error !== null
  ) {
    throw new Error("oauth_callback_local_signout_failed");
  }
  const after = await auth.getSession();
  if (after.error !== null || after.data.session !== null) {
    throw new Error(
      "oauth_callback_local_signout_unconfirmed",
    );
  }
  assertBrowserSupabaseSessionCleared();
  clearProfileCache();
  clearSentryIdentity();

  return replayExactJson({
    path: "/api/auth/oauth-flow/complete-signout",
    body: JSON.stringify({ flowId: receipt.flowId }),
    signal,
    parse: (value) =>
      parseCompleteSignOutAck(value, receipt),
  });
}

async function releaseCompletedFlow(
  receipt: FinalizeReceipt,
  signal: AbortSignal,
): Promise<string> {
  await replayExactJson({
    path: "/api/auth/oauth-flow/release",
    body: JSON.stringify({ flowId: receipt.flowId }),
    signal,
    parse: (value) =>
      parseFlowAck(value, receipt.flowId),
  });
  return receipt.destination;
}

function terminalBrowserBarrierRelease(flowId: string): void {
  // The exact terminal ACK is resolved only after the browser has applied its
  // Set-Cookie fields. A still-visible marker therefore means the terminal
  // response was incomplete or contradictory and must remain fail-closed.
  if (browserHasVisibleOAuthFlowMarker()) {
    throw new Error("oauth_callback_marker_not_released");
  }
  clearOAuthFlowBrowserBarrier(flowId);
  if (readOAuthFlowBrowserBarrier() !== null) {
    throw new Error("oauth_callback_barrier_not_released");
  }
}

function terminalCleanupCanRetryInProcess(
  flowId: string,
): boolean {
  try {
    return (
      readExactVisibleOAuthCallbackFlow() === null &&
      readOAuthFlowBrowserBarrier() === flowId
    );
  } catch {
    return false;
  }
}

function completeTerminalBrowserState(
  flowId: string,
  clearAuthSession: boolean,
): void {
  if (clearAuthSession) {
    // complete-signout already revoked the exact remote session. Repeat the
    // browser clear to defeat any late local SDK write before releasing H.
    clearBrowserSupabaseAuthStorage();
    assertBrowserSupabaseSessionCleared();
  }
  // Success normally consumes the verifier through auth-js; provider errors,
  // missing codes, and pre-transport failures do not. Every terminal outcome
  // therefore clears and proves this physical cookie unconditionally.
  clearBrowserSupabaseOAuthVerifierStorage();
  assertBrowserSupabaseOAuthVerifierStorageCleared();
  terminalBrowserBarrierRelease(flowId);
}

function pendingRecoveryDestination(
  queryFlowId: string | null,
): string {
  try {
    const durable = readOAuthFlowBrowserBarrier();
    const visible = readExactVisibleOAuthCallbackFlow();
    if (
      durable !== null &&
      visible !== null &&
      durable !== visible
    ) {
      throw new Error("oauth_callback_barrier_mismatch");
    }
    const recoverable = durable ?? visible ?? queryFlowId;
    return recoverable === null
      ? "/auth/flow-pending"
      : `/auth/flow-pending?flow=${encodeURIComponent(recoverable)}`;
  } catch {
    // Malformed, contradictory, or unreadable barrier evidence must never be
    // abandoned at /login. The pending page keeps the origin fenced and can
    // surface explicit recovery rather than starting a second identity flow.
    return queryFlowId === null
      ? "/auth/flow-pending"
      : `/auth/flow-pending?flow=${encodeURIComponent(queryFlowId)}`;
  }
}

export function OAuthCallbackClient() {
  const {
    code,
    errorCode,
    flowId,
    next,
    provider,
  } = callbackInput;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const codeRef = useRef(code);
  const fingerprintPromiseRef =
    useRef<Promise<string> | null>(null);

  const run = useCallback(async () => {
    if (!flowId || !provider) {
      window.location.replace(
        pendingRecoveryDestination(flowId),
      );
      return;
    }
    fingerprintPromiseRef.current ??= (async () =>
      JSON.stringify({
        codeFingerprint:
          await opaqueFingerprint(codeRef.current),
        errorCode,
        flowId,
        next,
        provider,
      }))();
    const fingerprint =
      await fingerprintPromiseRef.current;
    const registry = callbackMemory();
    const existing = registry.get(flowId);
    const memory =
      existing ??
      {
        fingerprint,
        decision:
          errorCode !== null
            ? {
                exchangeOutcome: "failed" as const,
                failureCode: errorCode,
                evidence: null,
              }
            : codeRef.current === null
              ? {
                  exchangeOutcome: "failed" as const,
                  failureCode: "missing_code" as const,
                  evidence: null,
                }
              : null,
        receipt: null,
        terminalDestination: null,
        destination: null,
        running: null,
        finished: false,
        recoveryRequired: false,
      };
    if (memory.fingerprint !== fingerprint) {
      throw new Error("oauth_callback_query_changed");
    }
    if (!existing) registry.set(flowId, memory);
    if (memory.destination !== null) {
      window.location.replace(memory.destination);
      return;
    }
    if (memory.finished) return;
    if (memory.running) return memory.running;

    const operation = (async () => {
      const signal = AbortSignal.timeout(
        CALLBACK_DEADLINE_MS,
      );
      if (memory.terminalDestination !== null) {
        const destination = memory.terminalDestination;
        const receipt = memory.receipt;
        if (receipt === null) {
          memory.recoveryRequired = true;
          throw new Error(
            "oauth_callback_terminal_receipt_missing",
          );
        }
        try {
          await resumeOAuthCallbackTerminalCleanup({
            signal,
            flowId,
            cleanup: () =>
              completeTerminalBrowserState(
                flowId,
                receipt.action === "signout",
              ),
          });
        } catch (error) {
          if (!terminalCleanupCanRetryInProcess(flowId)) {
            memory.recoveryRequired = true;
          }
          throw error;
        }
        memory.destination = destination;
        memory.finished = true;
        window.location.replace(destination);
        return;
      }
      const exchangeCode = codeRef.current;
      try {
        await runOAuthCallbackAuthLifecycle({
          signal,
          flowId,
          code:
            memory.decision === null && errorCode === null
              ? exchangeCode
              : null,
          preflight: async (requestSignal) => {
            if (memory.receipt !== null) return null;
            return replayExactJson({
              path: "/api/auth/oauth-flow/preflight",
              body: JSON.stringify({ flowId, provider }),
              signal: requestSignal,
              parse: (value) =>
                parsePreflightAck(value, flowId),
            });
          },
          bindTarget: async (
            binding,
            requestSignal,
          ) => {
            const body = JSON.stringify({
              flowId,
              provider,
              accessToken: binding.accessToken,
              refreshToken: binding.refreshToken,
            });
            await replayExactJson({
              path: "/api/auth/oauth-flow/bind-target",
              body,
              signal: requestSignal,
              parse: (value) =>
                parseBindTargetAck(
                  value,
                  flowId,
                  binding,
                )
                  ? true
                  : null,
            });
          },
          finish: async (
            lifecycle,
            getAuth,
            requestSignal,
          ) => {
            if (memory.decision === null) {
              memory.decision =
                lifecycle.outcome === "completed"
                  ? {
                      exchangeOutcome: "completed",
                      failureCode: null,
                      evidence: lifecycle.evidence,
                    }
                  : {
                      exchangeOutcome: "failed",
                      failureCode: "exchange_error",
                      evidence: null,
                    };
            }
            // The PKCE decision is now irreversible. Remove the only mutable
            // raw-code retry reference before any finalize network wait.
            codeRef.current = null;
            callbackInput.code = null;
            const decision = memory.decision;
            let receipt = memory.receipt;
            if (receipt === null) {
              const body = JSON.stringify({
                flowId,
                provider,
                next,
                exchangeOutcome: decision.exchangeOutcome,
                failureCode: decision.failureCode,
                expectedTargetUserId:
                  decision.evidence?.userId ?? null,
                expectedTargetSessionId:
                  decision.evidence?.sessionId ?? null,
                expectedAccessTokenDigest:
                  decision.evidence?.accessTokenDigest ?? null,
                expectedRefreshTokenDigest:
                  decision.evidence?.refreshTokenDigest ?? null,
              });
              try {
                receipt = await replayExactJson({
                  path: "/api/auth/oauth-flow/finalize",
                  body,
                  signal: requestSignal,
                  parse: (value) =>
                    parseFinalizeReceipt(
                      value,
                      flowId,
                      decision,
                    ),
                });
              } catch (error) {
                // The server may have committed even when both bounded ACK
                // attempts were lost. Never re-exchange; hand process-loss
                // recovery to the proof-bound status route.
                memory.recoveryRequired = true;
                throw error;
              }
              memory.receipt = receipt;
            }
            let destination: string;
            try {
              destination =
                receipt.action === "signout"
                  ? await executeSignOut(
                      receipt,
                      getAuth(),
                      requestSignal,
                    )
                  : await releaseCompletedFlow(
                      receipt,
                      requestSignal,
                    );
            } catch (error) {
              memory.recoveryRequired = true;
              throw error;
            }
            // Persist the exact terminal ACK result before local cleanup. If
            // cookie/localStorage cleanup fails after the marker disappeared,
            // a same-process retry can re-enter H→S without re-finalizing or
            // requiring the now-absent visible marker.
            memory.terminalDestination = destination;
            try {
              completeTerminalBrowserState(
                flowId,
                receipt.action === "signout",
              );
            } catch (error) {
              if (!terminalCleanupCanRetryInProcess(flowId)) {
                memory.recoveryRequired = true;
              }
              throw error;
            }
            memory.destination = destination;
            // Navigation is part of the H callback. A later tab cannot start
            // an identity writer between the receipt and this replace.
            window.location.replace(destination);
          },
        });
      } catch (error) {
        if (
          error instanceof
            OAuthCallbackExchangeAmbiguousError ||
          error instanceof OAuthCallbackDefinitiveHttpError ||
          error instanceof OAuthFlowLeaseError
        ) {
          memory.recoveryRequired = true;
        }
        throw error;
      } finally {
        if (
          memory.decision !== null ||
          memory.recoveryRequired
        ) {
          // JavaScript strings cannot be overwritten in place, but no raw
          // code remains in our long-lived callback registry or retry state.
          codeRef.current = null;
          callbackInput.code = null;
        }
      }
      memory.finished = true;
    })();
    memory.running = operation;
    try {
      await operation;
    } finally {
      if (memory.running === operation) {
        memory.running = null;
      }
    }
  }, [errorCode, flowId, next, provider]);

  useEffect(() => {
    let observing = true;
    void run().catch(() => {
      if (observing) {
        setFailed(true);
      }
    });
    return () => {
      // Never abort a callback on Strict Mode's effect replay or HMR. The
      // global flow single-flight continues to its bounded durable receipt.
      observing = false;
    };
  }, [attempt, run]);

  return (
    <main className="mx-auto flex min-h-[80vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
      {!failed && (
        <span
          aria-hidden="true"
          className="h-9 w-9 animate-spin rounded-full border-[3px] border-foreground/15 border-t-foreground"
        />
      )}
      <h1 className="text-base font-semibold">
        로그인 정보를 안전하게 확인하고 있어요
      </h1>
      <p className="text-xs text-zinc-500">
        잠시만 기다려주세요. 이 화면을 닫지 마세요.
      </p>
      {failed && (
        <>
          <p role="alert" className="text-sm text-red-500">
            로그인을 마무리하지 못했어요. 상태를 보존했으니 다시
            확인할 수 있어요.
          </p>
          <button
            type="button"
            className="rounded-md border px-4 py-2 text-sm"
            onClick={() => {
              if (
                flowId &&
                callbackMemory().get(flowId)
                  ?.recoveryRequired
              ) {
                window.location.replace(
                  pendingRecoveryDestination(flowId),
                );
                return;
              }
              setFailed(false);
              setAttempt((value) => value + 1);
            }}
          >
            다시 확인
          </button>
        </>
      )}
    </main>
  );
}
