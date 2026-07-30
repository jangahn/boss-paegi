/**
 * Applies one route-wide deadline to dependencies that do not expose an
 * AbortSignal. The underlying operation is never replayed, and its eventual
 * rejection remains observed after the caller has already failed closed.
 */
export function waitForCheckoutDependency<T>(
  dependency: PromiseLike<T>,
  signal: AbortSignal,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (
      outcome: Readonly<
        | { ok: true; value: T }
        | { ok: false; error: unknown }
      >,
    ) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      if (outcome.ok) {
        resolve(outcome.value);
      } else {
        reject(outcome.error);
      }
    };
    const onAbort = () =>
      finish({
        ok: false,
        error:
          signal.reason ??
          new DOMException("Checkout dependency timed out", "TimeoutError"),
      });

    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(dependency).then(
      (value) => finish({ ok: true, value }),
      (error: unknown) => finish({ ok: false, error }),
    );
    if (signal.aborted) onAbort();
  });
}
