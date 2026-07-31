export type SynchronousFetchScope = {
  fetch: typeof fetch;
  start<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T>;
  startExclusive<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T>;
  runExclusive<T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T>;
  updateFetcher(fetcher: typeof fetch): void;
};

/**
 * Binds requests started synchronously by an SDK operation to that operation's
 * lifetime without creating a second SDK client.
 *
 * The scope is deliberately restored before the returned promise settles.
 * `fetch()` captures the owner signal during the operation's synchronous
 * prefix, so overlapping requests retain independent signals and unrelated
 * background requests cannot inherit a stale operation signal.
 */
export function createSynchronousFetchScope(
  fetcher: typeof fetch = fetch,
): SynchronousFetchScope {
  type ActiveScope = {
    controller: AbortController;
    bind: (signal: AbortSignal) => void;
    dispose: () => void;
  };
  let activeScope: ActiveScope | null = null;
  let exclusiveTail: Promise<void> = Promise.resolve();
  let currentFetcher = fetcher;

  const scopedFetch = ((
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const scope = activeScope;
    if (!scope) return currentFetcher(input, init);
    if (init?.signal) scope.bind(init.signal);
    return currentFetcher(input, {
      ...init,
      signal: scope.controller.signal,
    });
  }) as typeof fetch;

  const start = <T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> => {
    if (signal.aborted) {
      return Promise.reject(
        signal.reason ?? new Error("fetch_scope_aborted"),
      );
    }
    const controller = new AbortController();
    const listeners = new Map<AbortSignal, () => void>();
    const bind = (source: AbortSignal) => {
      if (listeners.has(source)) return;
      const forwardAbort = () => {
        if (!controller.signal.aborted) {
          controller.abort(source.reason);
        }
      };
      if (source.aborted) {
        forwardAbort();
        return;
      }
      source.addEventListener("abort", forwardAbort, { once: true });
      listeners.set(source, forwardAbort);
      // AbortSignal does not replay an abort that raced with addEventListener.
      if (source.aborted) forwardAbort();
    };
    const dispose = () => {
      for (const [source, listener] of listeners) {
        source.removeEventListener("abort", listener);
      }
      listeners.clear();
    };
    bind(signal);

    const previousScope = activeScope;
    activeScope = { controller, bind, dispose };
    let operationPromise: Promise<T>;
    try {
      operationPromise = Promise.resolve(operation());
    } catch (error) {
      dispose();
      return Promise.reject(error);
    } finally {
      activeScope = previousScope;
    }
    return operationPromise.finally(dispose);
  };

  const runExclusive = <T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> => {
    const scheduled = exclusiveTail.then(
      () => {
        if (signal.aborted) {
          return Promise.reject(
            signal.reason ?? new Error("fetch_scope_aborted"),
          );
        }
        return operation();
      },
    );
    exclusiveTail = scheduled.then(
      () => undefined,
      () => undefined,
    );
    return scheduled;
  };

  const startExclusive = <T>(
    signal: AbortSignal,
    operation: () => Promise<T>,
  ): Promise<T> =>
    runExclusive(signal, () => start(signal, operation));

  return {
    fetch: scopedFetch,
    start,
    startExclusive,
    runExclusive,
    updateFetcher: (nextFetcher) => {
      currentFetcher = nextFetcher;
    },
  };
}

export function getOrCreateSynchronousFetchScope(
  registry: Record<symbol, unknown>,
  key: symbol,
  fetcher: typeof fetch = fetch,
): SynchronousFetchScope {
  const existing = registry[key];
  if (
    existing &&
    typeof existing === "object" &&
    "fetch" in existing &&
    typeof existing.fetch === "function" &&
    "start" in existing &&
    typeof existing.start === "function" &&
    "startExclusive" in existing &&
    typeof existing.startExclusive === "function" &&
    "runExclusive" in existing &&
    typeof existing.runExclusive === "function" &&
    "updateFetcher" in existing &&
    typeof existing.updateFetcher === "function"
  ) {
    const scope = existing as SynchronousFetchScope;
    scope.updateFetcher(fetcher);
    return scope;
  }
  const created = createSynchronousFetchScope(fetcher);
  registry[key] = created;
  return created;
}
