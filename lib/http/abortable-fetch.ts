/**
 * Bind every request made by an SDK client to the lifetime of the operation
 * that created it. SDKs may add their own signal, so both signals are
 * forwarded and listeners are always removed after settlement.
 */
export function createAbortableFetch(
  ownerSignal: AbortSignal,
  fetcher: typeof fetch = fetch,
): typeof fetch {
  return (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const controller = new AbortController();
    const signals = new Set<AbortSignal>([ownerSignal]);
    if (init?.signal) signals.add(init.signal);

    const forwardAbort = (signal: AbortSignal) => {
      if (!controller.signal.aborted) {
        controller.abort(signal.reason);
      }
    };
    const listeners: Array<{
      signal: AbortSignal;
      listener: () => void;
    }> = [];

    for (const signal of signals) {
      if (signal.aborted) {
        forwardAbort(signal);
        break;
      }
      const listener = () => forwardAbort(signal);
      signal.addEventListener("abort", listener, { once: true });
      listeners.push({ signal, listener });
    }

    try {
      return await fetcher(input, {
        ...init,
        signal: controller.signal,
      });
    } finally {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    }
  }) as typeof fetch;
}
