export type ExpiringSharedRequestSnapshot = {
  generation: number;
  hasRequest: boolean;
  expiresAt: number | null;
};

export type ExpiringSharedRequestOptions<T> = {
  ttlMs: number;
  load: (signal: AbortSignal) => Promise<T>;
  /**
   * Optional value-derived absolute expiry on the same clock as `now`.
   * The cache always caps it at `settledAt + ttlMs`.
   */
  expiresAt?: (value: T, settledAt: number) => number;
  now?: () => number;
  schedule?: (callback: () => void, delayMs: number) => () => void;
};

export type ExpiringSharedRequest<T> = {
  load: () => Promise<T>;
  refresh: () => void;
  refreshIfExpired: () => boolean;
  subscribe: (listener: () => void) => () => void;
  snapshot: () => ExpiringSharedRequestSnapshot;
  dispose: () => void;
};

type Entry<T> = {
  generation: number;
  promise: Promise<T>;
  expiresAt: number;
  controller: AbortController;
  settled: boolean;
};

const defaultSchedule = (
  callback: () => void,
  delayMs: number,
): (() => void) => {
  const timer = setTimeout(callback, delayMs);
  return () => clearTimeout(timer);
};

/**
 * One in-flight request and one successful value lifetime shared by every
 * subscriber. Refreshing advances a generation before notifying listeners,
 * so an older promise may settle but can never replace or re-arm the current
 * entry.
 */
export function createExpiringSharedRequest<T>(
  options: ExpiringSharedRequestOptions<T>,
): ExpiringSharedRequest<T> {
  if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
    throw new Error("invalid_shared_request_ttl");
  }

  const now = options.now ?? Date.now;
  const schedule = options.schedule ?? defaultSchedule;
  const listeners = new Set<() => void>();
  let lastNow = Number.NEGATIVE_INFINITY;
  let generation = 0;
  let entry: Entry<T> | null = null;
  let cancelExpiry: (() => void) | null = null;
  let disposed = false;

  const readNow = () => {
    const current = now();
    if (!Number.isFinite(current)) {
      throw new Error("invalid_shared_request_clock");
    }
    // Wall clocks can move backwards. A cache lifetime must not lengthen when
    // that happens, so expose a monotonic view to every boundary comparison.
    lastNow = Math.max(lastNow, current);
    return lastNow;
  };

  const clearExpiry = () => {
    try {
      cancelExpiry?.();
    } catch {
      // A scheduler cancellation defect cannot preserve a stale generation;
      // entry identity below remains the authority for any late callback.
    }
    cancelExpiry = null;
  };

  const notify = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        // One consumer cannot prevent the remaining surfaces from observing
        // the generation change.
      }
    }
  };

  const invalidate = (shouldNotify: boolean) => {
    const invalidated = entry;
    generation += 1;
    entry = null;
    clearExpiry();
    if (invalidated && !invalidated.settled) {
      invalidated.controller.abort(
        new Error("shared_request_generation_invalidated"),
      );
    }
    if (shouldNotify && !disposed) notify();
  };

  const refresh = () => {
    if (disposed) return;
    invalidate(true);
  };

  const armExpiry = (expected: Entry<T>) => {
    clearExpiry();
    const waitMs = Math.max(1, expected.expiresAt - readNow());
    let scheduling = true;
    let firedSynchronously = false;
    const onExpiry = () => {
      if (scheduling) {
        firedSynchronously = true;
        return;
      }
      cancelExpiry = null;
      if (disposed || entry !== expected) return;
      let current: number;
      try {
        current = readNow();
      } catch {
        invalidate(true);
        return;
      }
      if (current < expected.expiresAt) {
        try {
          armExpiry(expected);
        } catch {
          invalidate(true);
        }
        return;
      }
      refresh();
    };
    let cancel: () => void;
    try {
      cancel = schedule(onExpiry, waitMs);
    } catch {
      scheduling = false;
      throw new Error("shared_request_scheduler_failed");
    }
    scheduling = false;
    if (typeof cancel !== "function" || firedSynchronously) {
      try {
        cancel?.();
      } catch {
        // Entry is rejected below, so a broken cancellation callback cannot
        // make its generation authoritative.
      }
      throw new Error("invalid_shared_request_scheduler");
    }
    cancelExpiry = cancel;
  };

  const load = (): Promise<T> => {
    if (disposed) {
      return Promise.reject(new Error("shared_request_disposed"));
    }
    if (entry) return entry.promise;

    const requestGeneration = generation;
    let initialNow: number;
    try {
      initialNow = readNow();
    } catch (error) {
      return Promise.reject(error);
    }
    const expected: Entry<T> = {
      generation: requestGeneration,
      // Assigned synchronously below before this entry is published.
      promise: undefined as unknown as Promise<T>,
      // Also bounds an indefinitely pending request. A successful response
      // gets a fresh full TTL below.
      expiresAt: initialNow + options.ttlMs,
      controller: new AbortController(),
      settled: false,
    };
    let resolvePromise!: (value: T) => void;
    let rejectPromise!: (error: unknown) => void;
    const promise = new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    expected.promise = promise;
    entry = expected;
    try {
      armExpiry(expected);
    } catch (error) {
      invalidate(false);
      expected.settled = true;
      rejectPromise(error);
      return promise;
    }

    // Start in a microtask after `entry` is published and its pending timeout
    // is armed. This also normalizes a synchronous loader throw.
    void Promise.resolve()
      .then(() => options.load(expected.controller.signal))
      .then(
        (value) => {
          if (
            !disposed &&
            entry === expected &&
            generation === requestGeneration
          ) {
            try {
              const settledAt = readNow();
              const ttlExpiry = settledAt + options.ttlMs;
              const valueExpiry = options.expiresAt
                ? options.expiresAt(value, settledAt)
                : ttlExpiry;
              if (!Number.isFinite(valueExpiry)) {
                throw new Error("invalid_shared_request_value_expiry");
              }
              // Never extend an authoritative value deadline merely to make
              // it schedulable. If less than one observable millisecond
              // remains at outer-promise settlement, reject it before any
              // subscriber can render the stale value.
              if (
                options.expiresAt &&
                valueExpiry - settledAt < 1
              ) {
                throw new Error("shared_request_value_already_expired");
              }
              expected.expiresAt = Math.min(ttlExpiry, valueExpiry);
              armExpiry(expected);
            } catch (error) {
              invalidate(false);
              expected.settled = true;
              rejectPromise(error);
              return;
            }
          }
          expected.settled = true;
          resolvePromise(value);
        },
        (error: unknown) => {
          expected.settled = true;
          if (
            !disposed &&
            entry === expected &&
            generation === requestGeneration
          ) {
            invalidate(false);
          }
          rejectPromise(error);
        },
      );
    return promise;
  };

  return {
    load,
    refresh,
    refreshIfExpired: () => {
      if (disposed) return false;
      let current: number;
      try {
        current = readNow();
      } catch {
        refresh();
        return true;
      }
      if (!entry || current >= entry.expiresAt) {
        refresh();
        return true;
      }
      return false;
    },
    subscribe: (listener) => {
      if (disposed) return () => {};
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    snapshot: () => ({
      generation,
      hasRequest: entry !== null,
      expiresAt: entry?.expiresAt ?? null,
    }),
    dispose: () => {
      if (disposed) return;
      const pending = entry;
      disposed = true;
      entry = null;
      clearExpiry();
      if (pending && !pending.settled) {
        pending.controller.abort(new Error("shared_request_disposed"));
      }
      listeners.clear();
    },
  };
}
