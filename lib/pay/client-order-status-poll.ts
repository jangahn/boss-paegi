import {
  parseOrderStatusHttpResponse,
  type OrderStatusHttpResponse,
} from "./http-contract.ts";
import { readBoundedClientJsonResponse } from "../client-mutation.ts";

const ORDER_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export const ORDER_STATUS_POLL_INTERVAL_MS = 2_000;
export const ORDER_STATUS_POLL_REQUEST_TIMEOUT_MS = 7_000;
export const ORDER_STATUS_POLL_MAX_ELAPSED_MS = 35_000;
export const ORDER_STATUS_POLL_MAX_ATTEMPTS = 15;
export const ORDER_STATUS_POLL_MAX_RESPONSE_BYTES = 64 * 1024;

export type ClientOrderPollOutcome =
  | { status: "paid"; credits: number }
  | { status: "review" }
  | { status: "error" }
  | { status: "pending" }
  | { status: "cancelled" };

export type ClientOrderPollOptions = {
  signal: AbortSignal;
  fetcher?: (input: string, init: RequestInit) => Promise<Response>;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  intervalMs?: number;
  requestTimeoutMs?: number;
  maxElapsedMs?: number;
  maxAttempts?: number;
};

function browserMonotonicNow(): number {
  if (typeof performance === "undefined") {
    throw new Error("order_poll_monotonic_clock_unavailable");
  }
  const current = performance.now();
  if (!Number.isFinite(current)) {
    throw new Error("order_poll_monotonic_clock_unavailable");
  }
  return current;
}

function monotonicClock(rawNow: () => number): () => number {
  let last = rawNow();
  if (!Number.isFinite(last)) throw new Error("invalid_order_poll_clock");
  return () => {
    const current = rawNow();
    if (!Number.isFinite(current)) throw new Error("invalid_order_poll_clock");
    last = Math.max(last, current);
    return last;
  };
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

async function fetchOrderStatus(
  order: string,
  fetcher: (input: string, init: RequestInit) => Promise<Response>,
  lifecycleSignal: AbortSignal,
  requestTimeoutMs: number,
): Promise<
  | { kind: "snapshot"; value: OrderStatusHttpResponse | null }
  | { kind: "terminal_http_error" }
  | { kind: "transient_http_error" }
> {
  const requestAbort = new AbortController();
  const abortRequest = () => requestAbort.abort(lifecycleSignal.reason);
  lifecycleSignal.addEventListener("abort", abortRequest, { once: true });
  if (lifecycleSignal.aborted) abortRequest();
  const deadline = setTimeout(
    () => requestAbort.abort(new DOMException("Request timed out", "TimeoutError")),
    requestTimeoutMs,
  );
  try {
    const response = await fetcher(
      `/api/pay/order-status?order=${encodeURIComponent(order)}`,
      {
        cache: "no-store",
        signal: requestAbort.signal,
      },
    );
    if (!response.ok) {
      return [400, 401, 403, 404].includes(response.status)
        ? { kind: "terminal_http_error" }
        : { kind: "transient_http_error" };
    }
    const body = await readBoundedClientJsonResponse(
      response,
      ORDER_STATUS_POLL_MAX_RESPONSE_BYTES,
      requestAbort.signal,
    );
    return {
      kind: "snapshot",
      value: body.ok ? parseOrderStatusHttpResponse(body.value) : null,
    };
  } finally {
    clearTimeout(deadline);
    lifecycleSignal.removeEventListener("abort", abortRequest);
  }
}

/**
 * Redirect-return order convergence polling. Exactly one request is in flight;
 * each request has a deadline, the inter-request timer is abortable, and both
 * attempt and monotonic elapsed caps make every nonterminal path finite.
 */
export async function pollClientOrderStatus(
  order: string,
  options: ClientOrderPollOptions,
): Promise<ClientOrderPollOutcome> {
  if (!ORDER_UUID_RE.test(order)) return { status: "error" };
  const intervalMs = options.intervalMs ?? ORDER_STATUS_POLL_INTERVAL_MS;
  const requestTimeoutMs =
    options.requestTimeoutMs ?? ORDER_STATUS_POLL_REQUEST_TIMEOUT_MS;
  const maxElapsedMs =
    options.maxElapsedMs ?? ORDER_STATUS_POLL_MAX_ELAPSED_MS;
  const maxAttempts =
    options.maxAttempts ?? ORDER_STATUS_POLL_MAX_ATTEMPTS;
  if (
    !Number.isSafeInteger(intervalMs) ||
    intervalMs < 0 ||
    !Number.isSafeInteger(requestTimeoutMs) ||
    requestTimeoutMs < 1 ||
    !Number.isSafeInteger(maxElapsedMs) ||
    maxElapsedMs < 0 ||
    !Number.isSafeInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new Error("invalid_order_poll_options");
  }

  const fetcher = options.fetcher ?? ((input, init) => fetch(input, init));
  const wait = options.wait ?? abortableWait;
  const now = monotonicClock(options.now ?? browserMonotonicNow);
  const startedAt = now();

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (options.signal.aborted) return { status: "cancelled" };
    if (
      attempt > 1 &&
      Math.max(0, now() - startedAt) >= maxElapsedMs
    ) {
      return { status: "pending" };
    }
    try {
      const result = await fetchOrderStatus(
        order,
        fetcher,
        options.signal,
        requestTimeoutMs,
      );
      if (options.signal.aborted) return { status: "cancelled" };
      if (result.kind === "terminal_http_error") return { status: "error" };
      if (result.kind === "snapshot" && result.value) {
        if (result.value.status === "paid") {
          return { status: "paid", credits: result.value.credits };
        }
        if (result.value.status === "paid_review") {
          return { status: "review" };
        }
        if (
          result.value.status === "canceled" ||
          result.value.status === "failed"
        ) {
          return { status: "error" };
        }
      }
    } catch {
      if (options.signal.aborted) return { status: "cancelled" };
      // Request timeout/transport failure is retried within both hard caps.
    }

    if (
      attempt >= maxAttempts ||
      Math.max(0, now() - startedAt) >= maxElapsedMs
    ) {
      return { status: "pending" };
    }
    try {
      await wait(intervalMs, options.signal);
    } catch {
      return options.signal.aborted
        ? { status: "cancelled" }
        : { status: "pending" };
    }
  }
  return { status: "pending" };
}
