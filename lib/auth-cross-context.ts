import {
  NavigatorLockAcquireTimeoutError,
  type LockFunc,
} from "@supabase/supabase-js";

export const AUTH_SESSION_LOCK_NAME =
  "boss-paegi:auth-session-establishment:v1";

export class AuthCrossContextError extends Error {
  readonly code:
    | "auth_cross_context_lock_unavailable"
    | "auth_cross_context_lock_lost";

  constructor(
    code:
      | "auth_cross_context_lock_unavailable"
      | "auth_cross_context_lock_lost",
  ) {
    super(code);
    this.name = "AuthCrossContextError";
    this.code = code;
  }
}

export type AuthLockManager = {
  request<T>(
    name: string,
    options: {
      mode: "exclusive";
      signal: AbortSignal;
    },
    callback: (lock: Lock | null) => Promise<T>,
  ): Promise<T>;
};

/**
 * Runs a session-establishing operation under an origin-wide Web Lock.
 *
 * Identity mutations must fail closed when a browser cannot provide the lock:
 * a tab-local fallback would recreate the anonymous-account and PKCE races
 * this boundary exists to prevent. Non-browser execution is allowed only so
 * server pre-rendering and isolated unit tests do not touch browser globals.
 */
export async function runAuthCrossContextExclusive<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
  lockManager: AuthLockManager | null | undefined =
    typeof window === "undefined"
      ? undefined
      : (navigator.locks as AuthLockManager | undefined),
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason ?? new Error("auth_cross_context_aborted");
  }
  if (typeof window === "undefined") return operation();
  if (!lockManager) {
    throw new AuthCrossContextError(
      "auth_cross_context_lock_unavailable",
    );
  }
  return lockManager.request(
    AUTH_SESSION_LOCK_NAME,
    { mode: "exclusive", signal },
    async (lock) => {
      if (!lock) {
        throw new AuthCrossContextError(
          "auth_cross_context_lock_lost",
        );
      }
      if (signal.aborted) {
        throw signal.reason ?? new Error("auth_cross_context_aborted");
      }
      return operation();
    },
  );
}

/**
 * Acquires the exact Supabase SDK storage lock with the caller's AbortSignal.
 * The legacy LockFunc only accepts a numeric timeout, so H-held recovery/start
 * flows use this adapter to ensure cancellation also stops while queued for S.
 * Once acquired, Web Locks ignores later signal aborts and the real operation
 * is still drained before release.
 */
export async function runSignalAwareSupabaseAuthLock<T>(
  name: string,
  signal: AbortSignal,
  operation: () => Promise<T>,
  lockManager: AuthLockManager | null | undefined =
    typeof window === "undefined"
      ? undefined
      : (navigator.locks as AuthLockManager | undefined),
): Promise<T> {
  if (signal.aborted) {
    throw signal.reason ?? new Error("auth_storage_lock_aborted");
  }
  if (typeof window === "undefined") return operation();
  if (!lockManager) {
    throw new AuthCrossContextError(
      "auth_cross_context_lock_unavailable",
    );
  }
  return lockManager.request(
    name,
    { mode: "exclusive", signal },
    async (lock) => {
      if (!lock) {
        throw new AuthCrossContextError(
          "auth_cross_context_lock_lost",
        );
      }
      if (signal.aborted) {
        throw signal.reason ?? new Error("auth_storage_lock_aborted");
      }
      return operation();
    },
  );
}

/**
 * Legacy v2 auth-js lock adapter, retained intentionally while the installed
 * SDK still exposes `auth.lock`. Unlike the upstream helper, this adapter
 * never steals a held lock and never runs work after a null-lock callback.
 *
 * This lock covers hidden refreshes initiated by PostgREST/Storage token
 * reads, singleton initialization, visibility recovery, and public Auth calls.
 * Removing it is an explicit auth-js v3 migration blocker.
 */
export const failClosedSupabaseAuthLock: LockFunc = async (
  name,
  acquireTimeout,
  operation,
) => {
  if (
    typeof window === "undefined" ||
    !globalThis.navigator?.locks
  ) {
    throw new AuthCrossContextError(
      "auth_cross_context_lock_unavailable",
    );
  }

  if (acquireTimeout === 0) {
    return navigator.locks.request(
      name,
      { mode: "exclusive", ifAvailable: true },
      async (lock) => {
        if (!lock) {
          throw new NavigatorLockAcquireTimeoutError(
            `Auth lock "${name}" is busy`,
          );
        }
        return operation();
      },
    );
  }

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  if (acquireTimeout > 0) {
    timer = setTimeout(() => {
      controller.abort();
    }, acquireTimeout);
  }
  try {
    return await navigator.locks.request(
      name,
      {
        mode: "exclusive",
        ...(acquireTimeout > 0
          ? { signal: controller.signal }
          : {}),
      },
      async (lock) => {
        if (!lock) {
          throw new AuthCrossContextError(
            "auth_cross_context_lock_lost",
          );
        }
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        // Deliberately drain the real SDK task before releasing the lock.
        return operation();
      },
    );
  } catch (error) {
    if (
      acquireTimeout > 0 &&
      controller.signal.aborted &&
      error !== null &&
      typeof error === "object" &&
      "name" in error &&
      error.name === "AbortError"
    ) {
      throw new NavigatorLockAcquireTimeoutError(
        `Timed out acquiring auth lock "${name}"`,
      );
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
};
