const MAX_OPERATION_POLL_MS = 10 * 60 * 1000;
const MAX_RETRY_AFTER_SECONDS = 10;

export type ClientPollDirective = {
  deadlineMs: number;
  monotonicDeadlineMs: number;
  retryAfterMs: number;
};

export function parseClientPollDirective(args: {
  retryAfter: string | null;
  pollUntil: unknown;
  startedAtMs: number;
  startedAtMonotonicMs: number;
  priorDeadlineMs: number | null;
  priorMonotonicDeadlineMs: number | null;
  nowMs?: number;
  nowMonotonicMs?: number;
}): ClientPollDirective | null {
  const nowMs = args.nowMs ?? Date.now();
  const nowMonotonicMs = args.nowMonotonicMs ?? performance.now();
  if (
    !Number.isFinite(args.startedAtMs) ||
    args.startedAtMs > nowMs ||
    !Number.isFinite(args.startedAtMonotonicMs) ||
    args.startedAtMonotonicMs < 0 ||
    args.startedAtMonotonicMs > nowMonotonicMs ||
    typeof args.pollUntil !== "string" ||
    args.pollUntil !== args.pollUntil.trim() ||
    !/^\d{4}-\d{2}-\d{2}T/.test(args.pollUntil) ||
    args.retryAfter === null ||
    !/^[1-9]\d*$/.test(args.retryAfter)
  ) {
    return null;
  }
  const retryAfterSeconds = Number(args.retryAfter);
  const serverDeadlineMs = Date.parse(args.pollUntil);
  const hardDeadlineMs = args.startedAtMs + MAX_OPERATION_POLL_MS;
  const hardMonotonicDeadlineMs =
    args.startedAtMonotonicMs + MAX_OPERATION_POLL_MS;
  if (
    !Number.isSafeInteger(retryAfterSeconds) ||
    retryAfterSeconds > MAX_RETRY_AFTER_SECONDS ||
    !Number.isFinite(serverDeadlineMs) ||
    serverDeadlineMs <= nowMs
  ) {
    return null;
  }
  const deadlineMs = Math.min(
    serverDeadlineMs,
    hardDeadlineMs,
    args.priorDeadlineMs ?? Number.POSITIVE_INFINITY,
  );
  const monotonicDeadlineMs = Math.min(
    nowMonotonicMs + (serverDeadlineMs - nowMs),
    hardMonotonicDeadlineMs,
    args.priorMonotonicDeadlineMs ?? Number.POSITIVE_INFINITY,
  );
  const retryAfterMs = retryAfterSeconds * 1000;
  if (
    deadlineMs <= nowMs ||
    monotonicDeadlineMs <= nowMonotonicMs ||
    nowMs + retryAfterMs > deadlineMs ||
    nowMonotonicMs + retryAfterMs > monotonicDeadlineMs
  ) {
    return null;
  }
  return { deadlineMs, monotonicDeadlineMs, retryAfterMs };
}

function abortError(): DOMException {
  return new DOMException("operation_aborted", "AbortError");
}

function remainingPollBudgetMs(directive: ClientPollDirective): number {
  return Math.min(
    directive.deadlineMs - Date.now(),
    directive.monotonicDeadlineMs - performance.now(),
  );
}

function waitForDelay(delayMs: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(abortError());
      return;
    }
    const timer = window.setTimeout(done, delayMs);
    function done() {
      signal.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      window.clearTimeout(timer);
      signal.removeEventListener("abort", aborted);
      reject(abortError());
    }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/**
 * Hidden tabs do not spend retry traffic. Visibility waiting and the eventual
 * Retry-After delay are both fenced by the immutable first-response deadline.
 */
export async function waitForClientPoll(
  directive: ClientPollDirective,
  signal: AbortSignal,
): Promise<void> {
  while (document.visibilityState === "hidden") {
    const remaining = remainingPollBudgetMs(directive);
    if (remaining <= 0) throw new Error("operation_poll_deadline");
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortError());
        return;
      }
      const timer = window.setTimeout(expired, remaining);
      function cleanup() {
        window.clearTimeout(timer);
        document.removeEventListener("visibilitychange", visible);
        signal.removeEventListener("abort", aborted);
      }
      function visible() {
        if (document.visibilityState === "hidden") return;
        cleanup();
        resolve();
      }
      function expired() {
        cleanup();
        reject(new Error("operation_poll_deadline"));
      }
      function aborted() {
        cleanup();
        reject(abortError());
      }
      document.addEventListener("visibilitychange", visible);
      signal.addEventListener("abort", aborted, { once: true });
    });
  }
  const remaining = remainingPollBudgetMs(directive);
  if (remaining < directive.retryAfterMs) {
    throw new Error("operation_poll_deadline");
  }
  await waitForDelay(directive.retryAfterMs, signal);
  if (remainingPollBudgetMs(directive) <= 0) {
    throw new Error("operation_poll_deadline");
  }
}
