export const PORTONE_PAYMENT_WINDOW_TIMEOUT_MS = 10 * 60 * 1_000;

export type PortOnePaymentWaitResult<T> =
  | Readonly<{ kind: "completed"; value: T }>
  | Readonly<{ kind: "timeout" }>
  | Readonly<{ kind: "cancelled" }>;

/**
 * Bounds one already-started payment-window request without replaying it.
 * PortOne's SDK has no cancellation primitive, so a late settlement is
 * ignored after this gate resolves and the caller reconciles the durable
 * order through /credits/done.
 */
export function waitForPortOnePayment<T>(
  request: PromiseLike<T>,
  options: Readonly<{
    signal?: AbortSignal;
    timeoutMs?: number;
  }> = {},
): Promise<PortOnePaymentWaitResult<T>> {
  const timeoutMs =
    options.timeoutMs ?? PORTONE_PAYMENT_WINDOW_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return Promise.reject(new Error("invalid_portone_payment_timeout"));
  }
  if (options.signal?.aborted) {
    return Promise.resolve({ kind: "cancelled" });
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      result: PortOnePaymentWaitResult<T>,
      error?: unknown,
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      if (error !== undefined) {
        reject(error);
      } else {
        resolve(result);
      }
    };
    const onAbort = () => finish({ kind: "cancelled" });
    const timer = setTimeout(
      () => finish({ kind: "timeout" }),
      timeoutMs,
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    Promise.resolve(request).then(
      (value) => finish({ kind: "completed", value }),
      (error: unknown) => finish({ kind: "cancelled" }, error),
    );
  });
}
