import {
  parsePendingGenerationsResponse,
  type ParsedPendingGeneration,
} from "./pending-generations-response.ts";
import { runBoundedClientJsonFetch } from "./client-mutation.ts";

export const GALLERY_PENDING_POLL_INTERVAL_MS = 4_000;
export const GALLERY_PENDING_POLL_REQUEST_TIMEOUT_MS = 12_000;
export const GALLERY_PENDING_POLL_MAX_MS = 5 * 60_000;
export const GALLERY_PENDING_POLL_FAILURE_LIMIT = 3;

export type GalleryPendingPollOutcome =
  | "terminal"
  | "cancelled"
  | "timeout"
  | "unavailable";

export type GalleryPendingPollOptions = {
  signal: AbortSignal;
  onRows: (rows: ParsedPendingGeneration[]) => void;
  onError: (error: unknown) => void;
  fetcher?: typeof fetch;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  maxElapsedMs?: number;
  consecutiveFailureLimit?: number;
};

class GalleryPendingPollHttpError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`gallery_pending_http_${status}`);
    this.name = "GalleryPendingPollHttpError";
    this.status = status;
  }
}

function abortableWait(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function monotonicClock(rawNow: () => number): () => number {
  let last = rawNow();
  if (!Number.isFinite(last)) {
    throw new Error("invalid_gallery_pending_poll_clock");
  }
  return () => {
    const current = rawNow();
    if (!Number.isFinite(current)) {
      throw new Error("invalid_gallery_pending_poll_clock");
    }
    last = Math.max(last, current);
    return last;
  };
}

function browserMonotonicNow(): number {
  if (typeof performance === "undefined") {
    throw new Error("gallery_pending_monotonic_clock_unavailable");
  }
  const current = performance.now();
  if (!Number.isFinite(current)) {
    throw new Error("gallery_pending_monotonic_clock_unavailable");
  }
  return current;
}

async function fetchPendingRows(
  fetcher: typeof fetch,
  lifecycleSignal: AbortSignal,
  requestTimeoutMs: number,
): Promise<ParsedPendingGeneration[]> {
  const delivery = await runBoundedClientJsonFetch({
    input: "/api/generations",
    init: {
      cache: "no-store",
    },
    fetcher,
    signal: lifecycleSignal,
    deadlineMs: requestTimeoutMs + 1,
    attemptMs: requestTimeoutMs,
  });
  if (delivery.kind === "aborted") {
    throw lifecycleSignal.reason ?? new Error("gallery_pending_cancelled");
  }
  if (delivery.kind !== "confirmed") {
    throw new Error("gallery_pending_response_unconfirmed");
  }
  const { response, body } = delivery.value;
  if (!response.ok) throw new GalleryPendingPollHttpError(response.status);
  return parsePendingGenerationsResponse(body);
}

/**
 * Gallery pending-generation polling with one request in flight at a time.
 * The next request is scheduled only after the previous request and delay have
 * both completed. Terminal rows, cancellation, a bounded failure streak, and
 * an overall elapsed deadline all stop the loop deterministically.
 */
export async function pollGalleryPendingGenerations(
  options: GalleryPendingPollOptions,
): Promise<GalleryPendingPollOutcome> {
  const fetcher = options.fetcher ?? fetch;
  const wait = options.wait ?? abortableWait;
  const rawNow = options.now ?? browserMonotonicNow;
  const now = monotonicClock(rawNow);
  const intervalMs =
    options.intervalMs ?? GALLERY_PENDING_POLL_INTERVAL_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? GALLERY_PENDING_POLL_REQUEST_TIMEOUT_MS;
  const maxElapsedMs =
    options.maxElapsedMs ?? GALLERY_PENDING_POLL_MAX_MS;
  const failureLimit =
    options.consecutiveFailureLimit ?? GALLERY_PENDING_POLL_FAILURE_LIMIT;
  if (
    !Number.isFinite(intervalMs) ||
    intervalMs < 0 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    requestTimeoutMs >= Number.MAX_SAFE_INTEGER ||
    !Number.isFinite(maxElapsedMs) ||
    maxElapsedMs < 0 ||
    !Number.isSafeInteger(failureLimit) ||
    failureLimit < 1
  ) {
    throw new Error("invalid_gallery_pending_poll_options");
  }

  const startedAt = now();
  const maxAttempts = Math.max(
    1,
    Math.ceil(maxElapsedMs / Math.max(1, intervalMs)) + 1,
  );
  let attempts = 0;
  let consecutiveFailures = 0;
  while (!options.signal.aborted) {
    if (
      attempts > 0 &&
      (attempts >= maxAttempts ||
        Math.max(0, now() - startedAt) >= maxElapsedMs)
    ) {
      return "timeout";
    }
    attempts += 1;
    try {
      const rows = await fetchPendingRows(
        fetcher,
        options.signal,
        requestTimeoutMs,
      );
      if (options.signal.aborted) return "cancelled";
      consecutiveFailures = 0;
      options.onRows(rows);
      if (!rows.some((row) => row.kind === "generating")) return "terminal";
    } catch (error) {
      if (options.signal.aborted) return "cancelled";
      consecutiveFailures += 1;
      options.onError(error);
      if (consecutiveFailures >= failureLimit) return "unavailable";
    }

    if (Math.max(0, now() - startedAt) >= maxElapsedMs) return "timeout";
    try {
      await wait(intervalMs, options.signal);
    } catch {
      return options.signal.aborted ? "cancelled" : "unavailable";
    }
  }
  return "cancelled";
}
