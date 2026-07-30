import { readBoundedResponseBytes } from "./http/bounded-response.ts";

export const CLIENT_MUTATION_DEADLINE_MS = 20_000;
export const CLIENT_MUTATION_ATTEMPT_MS = 12_000;
export const CLIENT_MUTATION_MAX_RESPONSE_BYTES = 64 * 1024;

export type ClientMutationEvidence<T> =
  | { kind: "confirmed"; value: T }
  | { kind: "rejected"; error: unknown }
  | { kind: "unconfirmed"; reason: string; error?: unknown };

export type ClientMutationOutcome<T> =
  | { kind: "confirmed"; value: T; source: "response" | "reconciled" }
  | { kind: "rejected"; error: unknown }
  | {
      kind: "unconfirmed";
      reason:
        | "deadline"
        | "transport"
        | "response_unconfirmed"
        | "reconciliation_unconfirmed";
      error?: unknown;
    }
  | { kind: "aborted" };

type PhaseResult<T> =
  | { kind: "evidence"; evidence: ClientMutationEvidence<T> }
  | { kind: "transport"; error: unknown }
  | { kind: "timeout" }
  | { kind: "aborted" };

export type ClientMutationOptions<T> = {
  attempt: (signal: AbortSignal) => Promise<ClientMutationEvidence<T>>;
  /**
   * Read/replay the same durable operation after a lost or malformed response.
   * The callback must keep the original operation ID and exact payload.
   */
  reconcile?: (signal: AbortSignal) => Promise<ClientMutationEvidence<T>>;
  signal?: AbortSignal;
  deadlineMs?: number;
  attemptMs?: number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
};

export type ReplayedJsonMutationOptions<T> = Omit<
  ClientMutationOptions<T>,
  "attempt" | "reconcile"
> & {
  input: RequestInfo | URL;
  init: Omit<RequestInit, "signal">;
  classify: (
    response: Response,
    body: unknown,
  ) => ClientMutationEvidence<T>;
  fetcher?: typeof fetch;
};

export type BoundedClientFetchOptions = {
  input: RequestInfo | URL;
  init?: Omit<RequestInit, "signal">;
  fetcher?: typeof fetch;
  signal?: AbortSignal;
  deadlineMs?: number;
  attemptMs?: number;
};

export type BoundedClientJsonFetchResult = {
  response: Response;
  body: unknown;
  bodyError: Exclude<
    BoundedClientJsonResult,
    { ok: true }
  >["error"] | null;
};

export type BoundedClientJsonResult =
  | { ok: true; value: unknown }
  | {
      ok: false;
      error:
        | "too_large"
        | "read_failed"
        | "invalid_utf8"
        | "invalid_json";
    };

const defaultSchedule = (
  callback: () => void,
  delayMs: number,
): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

const defaultNow = (): number =>
  typeof performance !== "undefined" &&
  typeof performance.now === "function"
    ? performance.now()
    : Date.now();

function isPositiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

/**
 * These statuses do not prove that a server-side mutation did not commit.
 * Reconcile the original operation/payload instead of presenting a definitive
 * rejection. Ordinary 4xx domain/auth conflicts remain definitive.
 */
export function clientMutationResponseNeedsReconciliation(
  status: number,
  responseOk: boolean,
): boolean {
  return (
    responseOk ||
    status === 408 ||
    status === 425 ||
    status === 429 ||
    status >= 500
  );
}

async function runPhase<T>(args: {
  work: (signal: AbortSignal) => Promise<ClientMutationEvidence<T>>;
  lifecycleSignal?: AbortSignal;
  timeoutMs: number;
  schedule: (callback: () => void, delayMs: number) => () => void;
}): Promise<PhaseResult<T>> {
  if (args.lifecycleSignal?.aborted) return { kind: "aborted" };

  const controller = new AbortController();
  return new Promise((resolve) => {
    let settled = false;
    let cancelTimeout = () => {};
    let listenerAttached = false;
    const safelyCancelTimeout = () => {
      try {
        cancelTimeout();
      } catch {
        // Timer cleanup must never prevent lifecycle cleanup or settlement.
      }
    };
    const finish = (result: PhaseResult<T>) => {
      if (settled) return;
      settled = true;
      safelyCancelTimeout();
      if (listenerAttached) {
        args.lifecycleSignal?.removeEventListener(
          "abort",
          onLifecycleAbort,
        );
        listenerAttached = false;
      }
      resolve(result);
    };
    const onLifecycleAbort = () => {
      controller.abort(args.lifecycleSignal?.reason);
      finish({ kind: "aborted" });
    };
    try {
      const scheduledCancellation = args.schedule(() => {
        controller.abort(new Error("client_mutation_phase_timeout"));
        finish({ kind: "timeout" });
      }, args.timeoutMs);
      if (typeof scheduledCancellation !== "function") {
        finish({
          kind: "transport",
          error: new Error("invalid_client_mutation_scheduler"),
        });
        return;
      }
      cancelTimeout = scheduledCancellation;
    } catch (error) {
      finish({ kind: "transport", error });
      return;
    }
    // A custom/fake scheduler is allowed to fire synchronously. In that case
    // finish ran while cancelTimeout was still the no-op placeholder, so
    // cancel the returned handle now and never attach/start late work.
    if (settled) {
      safelyCancelTimeout();
      return;
    }
    try {
      args.lifecycleSignal?.addEventListener(
        "abort",
        onLifecycleAbort,
        { once: true },
      );
      listenerAttached = args.lifecycleSignal !== undefined;
    } catch (error) {
      finish({ kind: "transport", error });
      return;
    }
    // Close the check/add race: AbortSignal does not replay an abort event to
    // a listener attached after the signal became aborted.
    if (args.lifecycleSignal?.aborted) {
      onLifecycleAbort();
      return;
    }

    let work: Promise<ClientMutationEvidence<T>>;
    try {
      // Start the phase synchronously after both cancellation mechanisms are
      // armed. This also makes a lifecycle abort between phases observable by
      // the reconciliation signal without an extra scheduling turn.
      work = args.work(controller.signal);
    } catch (error) {
      finish(
        args.lifecycleSignal?.aborted
          ? { kind: "aborted" }
          : { kind: "transport", error },
      );
      return;
    }
    void work.then(
      (evidence) => finish({ kind: "evidence", evidence }),
      (error: unknown) => {
        if (args.lifecycleSignal?.aborted) {
          finish({ kind: "aborted" });
        } else {
          finish({ kind: "transport", error });
        }
      },
    );
  });
}

/**
 * Reads a mutation acknowledgement without trusting Content-Length and
 * without ever buffering beyond the fixed client acknowledgement ceiling.
 * UTF-8 decoding is fatal so replacement characters cannot turn corrupt wire
 * bytes into a different, apparently valid JSON receipt.
 */
export async function readBoundedClientJsonResponse(
  response: Pick<Response, "headers" | "body">,
  maxBytesOrSignal: number | AbortSignal =
    CLIENT_MUTATION_MAX_RESPONSE_BYTES,
  explicitSignal?: AbortSignal,
): Promise<BoundedClientJsonResult> {
  const maxBytes =
    typeof maxBytesOrSignal === "number"
      ? maxBytesOrSignal
      : CLIENT_MUTATION_MAX_RESPONSE_BYTES;
  const signal =
    typeof maxBytesOrSignal === "number"
      ? explicitSignal
      : maxBytesOrSignal;
  const bounded = await readBoundedResponseBytes(
    response,
    maxBytes,
    signal,
  );
  if (!bounded.ok) return bounded;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(
      bounded.bytes,
    );
  } catch {
    return { ok: false, error: "invalid_utf8" };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}

function unconfirmedFromAttempt<T>(
  result: PhaseResult<T>,
): Extract<ClientMutationOutcome<T>, { kind: "unconfirmed" }> {
  if (result.kind === "timeout") {
    return { kind: "unconfirmed", reason: "deadline" };
  }
  if (result.kind === "transport") {
    return {
      kind: "unconfirmed",
      reason: "transport",
      error: result.error,
    };
  }
  if (
    result.kind === "evidence" &&
    result.evidence.kind === "unconfirmed"
  ) {
    return {
      kind: "unconfirmed",
      reason: "response_unconfirmed",
      error: result.evidence.error,
    };
  }
  return { kind: "unconfirmed", reason: "response_unconfirmed" };
}

/**
 * Executes one client mutation under a hard end-to-end deadline. A transport
 * failure, timed-out delivery, or malformed acknowledgement is never treated
 * as success. When supplied, reconciliation gets only the remaining deadline
 * and may confirm success solely from an exact durable receipt/replay.
 */
export async function runClientMutation<T>(
  options: ClientMutationOptions<T>,
): Promise<ClientMutationOutcome<T>> {
  const deadlineMs = options.deadlineMs ?? CLIENT_MUTATION_DEADLINE_MS;
  const attemptMs = options.attemptMs ?? CLIENT_MUTATION_ATTEMPT_MS;
  if (
    !isPositiveSafeInteger(deadlineMs) ||
    !isPositiveSafeInteger(attemptMs) ||
    attemptMs >= deadlineMs
  ) {
    throw new Error("invalid_client_mutation_deadline");
  }

  if (options.signal?.aborted) return { kind: "aborted" };
  const now = options.now ?? defaultNow;
  const schedule = options.schedule ?? defaultSchedule;
  const deadlineAt = now() + deadlineMs;

  const attempt = await runPhase({
    work: options.attempt,
    lifecycleSignal: options.signal,
    timeoutMs: Math.min(attemptMs, Math.max(1, deadlineAt - now())),
    schedule,
  });
  if (attempt.kind === "aborted") return { kind: "aborted" };
  if (attempt.kind === "evidence") {
    if (attempt.evidence.kind === "confirmed") {
      return {
        kind: "confirmed",
        value: attempt.evidence.value,
        source: "response",
      };
    }
    if (attempt.evidence.kind === "rejected") {
      return { kind: "rejected", error: attempt.evidence.error };
    }
  }

  if (!options.reconcile) return unconfirmedFromAttempt(attempt);
  if (options.signal?.aborted) return { kind: "aborted" };
  const remainingMs = deadlineAt - now();
  if (remainingMs <= 0) {
    return { kind: "unconfirmed", reason: "deadline" };
  }

  const reconciliation = await runPhase({
    work: options.reconcile,
    lifecycleSignal: options.signal,
    timeoutMs: remainingMs,
    schedule,
  });
  if (reconciliation.kind === "aborted") return { kind: "aborted" };
  if (reconciliation.kind === "evidence") {
    if (reconciliation.evidence.kind === "confirmed") {
      return {
        kind: "confirmed",
        value: reconciliation.evidence.value,
        source: "reconciled",
      };
    }
    if (reconciliation.evidence.kind === "rejected") {
      return {
        kind: "rejected",
        error: reconciliation.evidence.error,
      };
    }
    return {
      kind: "unconfirmed",
      reason: "reconciliation_unconfirmed",
      error: reconciliation.evidence.error,
    };
  }
  if (reconciliation.kind === "transport") {
    return {
      kind: "unconfirmed",
      reason: "reconciliation_unconfirmed",
      error: reconciliation.error,
    };
  }
  return { kind: "unconfirmed", reason: "deadline" };
}

/**
 * JSON convenience for receipt-bearing mutations. The URL, method, headers,
 * and already-serialized body are captured once and reused byte-for-byte for
 * reconciliation; callers still own exact response parsing.
 */
export function runReplayedJsonMutation<T>(
  options: ReplayedJsonMutationOptions<T>,
): Promise<ClientMutationOutcome<T>> {
  const fetcher = options.fetcher ?? fetch;
  const deliver = async (
    signal: AbortSignal,
  ): Promise<ClientMutationEvidence<T>> => {
    const response = await fetcher(options.input, {
      ...options.init,
      signal,
    });
    const body = await readBoundedClientJsonResponse(
      response,
      CLIENT_MUTATION_MAX_RESPONSE_BYTES,
      signal,
    );
    return options.classify(
      response,
      body.ok ? body.value : null,
    );
  };
  return runClientMutation({
    attempt: deliver,
    reconcile: deliver,
    signal: options.signal,
    deadlineMs: options.deadlineMs,
    attemptMs: options.attemptMs,
    now: options.now,
    schedule: options.schedule,
  });
}

/**
 * Bounds a transport whose durable domain already owns explicit later
 * recovery. It never auto-replays: callers retain their persisted receipt and
 * decide when the original operation may be recovered.
 */
export function runBoundedClientFetch(
  options: BoundedClientFetchOptions,
): Promise<ClientMutationOutcome<Response>> {
  const fetcher = options.fetcher ?? fetch;
  return runClientMutation({
    attempt: async (signal) => ({
      kind: "confirmed",
      value: await fetcher(options.input, {
        ...options.init,
        signal,
      }),
    }),
    signal: options.signal,
    deadlineMs: options.deadlineMs,
    attemptMs: options.attemptMs,
  });
}

/**
 * Bounds both response headers and the complete, size-limited JSON body for a
 * durable domain that owns later recovery. Like runBoundedClientFetch it does
 * not auto-replay; an invalid body is returned as null so the domain keeps its
 * original persisted operation receipt and fails closed.
 */
export function runBoundedClientJsonFetch(
  options: BoundedClientFetchOptions,
): Promise<ClientMutationOutcome<BoundedClientJsonFetchResult>> {
  const fetcher = options.fetcher ?? fetch;
  return runClientMutation({
    attempt: async (signal) => {
      const response = await fetcher(options.input, {
        ...options.init,
        signal,
      });
      const parsed = await readBoundedClientJsonResponse(
        response,
        CLIENT_MUTATION_MAX_RESPONSE_BYTES,
        signal,
      );
      return {
        kind: "confirmed",
        value: {
          response,
          body: parsed.ok ? parsed.value : null,
          bodyError: parsed.ok ? null : parsed.error,
        },
      };
    },
    signal: options.signal,
    deadlineMs: options.deadlineMs,
    attemptMs: options.attemptMs,
  });
}
