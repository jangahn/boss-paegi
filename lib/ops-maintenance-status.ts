export type OpsMaintenanceStatus = 200 | 429 | 503;
export type OpsMaintenanceHttpStatus = OpsMaintenanceStatus | 401 | 500;

export const OPS_MAINTENANCE_RETRY_AFTER_SECONDS = 60;
export const OPS_MAINTENANCE_ROUTE_BUDGET_MS = 20_000;

export type OpsMaintenanceDeadline = Readonly<{
  expiresAt: number;
  now: () => number;
  signal: AbortSignal;
  abort: () => void;
}>;

/** One monotonic wall-clock budget shared by every stage in one route run. */
export function createOpsMaintenanceDeadline(
  budgetMs = OPS_MAINTENANCE_ROUTE_BUDGET_MS,
  now: () => number = () => performance.now(),
): OpsMaintenanceDeadline {
  if (!Number.isSafeInteger(budgetMs) || budgetMs < 1) {
    throw new Error("invalid_ops_maintenance_budget");
  }
  const controller = new AbortController();
  return {
    expiresAt: now() + budgetMs,
    now,
    signal: controller.signal,
    abort: () => controller.abort("ops_maintenance_deadline"),
  };
}

export function opsMaintenanceTimeRemaining(
  deadline: OpsMaintenanceDeadline,
): number {
  if (deadline.signal.aborted) return 0;
  return Math.max(0, deadline.expiresAt - deadline.now());
}

export function opsMaintenanceDeadlineReached(
  deadline: OpsMaintenanceDeadline,
  reserveMs = 0,
): boolean {
  if (!Number.isSafeInteger(reserveMs) || reserveMs < 0) return true;
  return opsMaintenanceTimeRemaining(deadline) <= reserveMs;
}

/**
 * Return a scheduler-visible timeout response before the platform/caller hard
 * timeout. The abort signal cancels signal-aware in-flight I/O; every route
 * must also fence later stages and success reporting with the same deadline.
 * Durable/idempotent work that committed before cancellation is converged by a
 * later run from its receipts.
 */
export async function runOpsMaintenanceWithDeadline<T>(
  deadline: OpsMaintenanceDeadline,
  work: () => Promise<T>,
  onTimeout: () => T | Promise<T>,
): Promise<T> {
  const remaining = opsMaintenanceTimeRemaining(deadline);
  if (remaining <= 0) {
    deadline.abort();
    return onTimeout();
  }

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      // Claim the result before aborting. Signal-aware work can resolve
      // synchronously from the abort event, but it must never beat the
      // scheduler-visible timeout result.
      settled = true;
      deadline.abort();
      Promise.resolve()
        .then(onTimeout)
        .then(resolve, reject);
    }, remaining);

    Promise.resolve()
      .then(work)
      .then(
        (value) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error);
        },
      );
  });
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

/**
 * A bounded worker cannot prove its queue is empty when it consumes the whole
 * batch. Treat that boundary as retryable work instead of a green scheduler
 * signal; an exact-boundary false red clears on the next run.
 */
export function boundedBatchMayHaveMore(
  processed: number,
  limit: number,
): boolean {
  if (!isNonNegativeSafeInteger(processed)) return true;
  if (!Number.isSafeInteger(limit) || limit < 1) return true;
  return processed >= limit;
}

/** Fail closed for malformed counters, systemic errors, or durable backlog. */
export function opsMaintenanceStatus(args: {
  systemErrors: number;
  retryPending: number;
  boundedBacklogs?: number;
  operatorPending?: number;
}): OpsMaintenanceStatus {
  const boundedBacklogs = args.boundedBacklogs ?? 0;
  const operatorPending = args.operatorPending ?? 0;
  if (
    !isNonNegativeSafeInteger(args.systemErrors) ||
    !isNonNegativeSafeInteger(args.retryPending) ||
    !isNonNegativeSafeInteger(boundedBacklogs) ||
    !isNonNegativeSafeInteger(operatorPending)
  ) {
    return 503;
  }
  if (args.systemErrors > 0) return 503;
  if (args.retryPending > 0 || boundedBacklogs > 0 || operatorPending > 0) {
    // cron-job.org treats every 2xx response (including 207) as success. A
    // retryable queue edge must therefore remain non-2xx so scheduler failure
    // alerts and retries cannot be false-green.
    return 429;
  }
  return 200;
}

/** Common scheduler-visible HTTP contract for every aggregate ops route. */
export function opsMaintenanceResponseInit(
  status: OpsMaintenanceHttpStatus,
): ResponseInit {
  return {
    status,
    headers: {
      "Cache-Control": "no-store",
      ...(status === 429 || status >= 500
        ? {
            "Retry-After": String(OPS_MAINTENANCE_RETRY_AFTER_SECONDS),
          }
        : {}),
    },
  };
}
