import { runBoundedClientJsonFetch } from "./client-mutation.ts";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

export type PendingCreditAdjustment = {
  requestId: string;
  targetUserId: string;
};

export type CreditAdjustmentResult = {
  ok: true;
  before: number;
  after: number;
  applied: number;
  requested: number;
  idempotent: boolean;
};

export type CreditAdjustmentInput = {
  targetUserId: string;
  delta: number;
  reason: string;
};

type RequestOptions = {
  storage: StorageLike;
  fetcher?: typeof fetch;
  mintRequestId?: () => string;
  onPending?: (pending: PendingCreditAdjustment) => void;
  runExclusive?: CreditAdjustmentExclusiveRunner;
  signal?: AbortSignal;
  deadlineMs?: number;
  attemptMs?: number;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_PREFIX = "boss-paegi:admin-credit-adjust:";
const LOCK_PREFIX = "boss-paegi:admin-credit-adjust:";

export type CreditAdjustmentExclusiveRunner = <T>(
  name: string,
  task: () => Promise<T>,
) => Promise<T>;

export class CreditAdjustmentHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.name = "CreditAdjustmentHttpError";
    this.status = status;
    this.code = code;
  }
}

export class CreditAdjustmentStorageError extends Error {
  constructor(cause: unknown) {
    super("credit_adjustment_storage_unavailable", { cause });
    this.name = "CreditAdjustmentStorageError";
  }
}

export class CreditAdjustmentConcurrencyError extends Error {
  constructor(code = "credit_adjustment_already_in_progress") {
    super(code);
    this.name = "CreditAdjustmentConcurrencyError";
  }
}

const browserExclusiveRunner: CreditAdjustmentExclusiveRunner = async (
  name,
  task,
) => {
  const lockManager =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) {
    throw new CreditAdjustmentConcurrencyError(
      "credit_adjustment_cross_tab_lock_unavailable",
    );
  }
  return lockManager.request(
    name,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) throw new CreditAdjustmentConcurrencyError();
      return task();
    },
  );
};

function withAdjustmentLock<T>(
  targetUserId: string,
  runner: CreditAdjustmentExclusiveRunner | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return (runner ?? browserExclusiveRunner)(
    `${LOCK_PREFIX}${targetUserId}`,
    task,
  );
}

function storageKey(targetUserId: string): string {
  return `${STORAGE_PREFIX}${targetUserId}`;
}

function isPending(value: unknown, targetUserId: string): value is PendingCreditAdjustment {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.requestId === "string" &&
    UUID_RE.test(v.requestId) &&
    v.targetUserId === targetUserId
  );
}

export function readPendingCreditAdjustment(
  targetUserId: string,
  storage: StorageLike,
): PendingCreditAdjustment | null {
  const key = storageKey(targetUserId);
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch (error) {
    throw new CreditAdjustmentStorageError(error);
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (isPending(parsed, targetUserId)) return parsed;
  } catch {
    // A corrupt record is safe to discard only when durable removal succeeds.
  }
  try {
    storage.removeItem(key);
  } catch (error) {
    throw new CreditAdjustmentStorageError(error);
  }
  return null;
}

export function persistPendingCreditAdjustment(
  pending: PendingCreditAdjustment,
  storage: StorageLike,
): void {
  if (!isPending(pending, pending.targetUserId)) {
    throw new Error("invalid_credit_adjustment_request");
  }
  try {
    storage.setItem(storageKey(pending.targetUserId), JSON.stringify(pending));
  } catch (error) {
    throw new CreditAdjustmentStorageError(error);
  }
}

export function clearPendingCreditAdjustment(
  targetUserId: string,
  storage: StorageLike,
): void {
  try {
    storage.removeItem(storageKey(targetUserId));
  } catch (error) {
    throw new CreditAdjustmentStorageError(error);
  }
}

export function parseCreditAdjustmentResult(value: unknown): CreditAdjustmentResult | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (
    v.ok !== true ||
    !Number.isSafeInteger(v.before) ||
    !Number.isSafeInteger(v.after) ||
    !Number.isSafeInteger(v.applied) ||
    !Number.isSafeInteger(v.requested) ||
    typeof v.idempotent !== "boolean"
  ) {
    return null;
  }
  const result = v as CreditAdjustmentResult;
  if (
    result.before < 0 ||
    result.after < 0 ||
    result.applied !== result.after - result.before ||
    result.requested < -100 ||
    result.requested > 100 ||
    result.requested === 0
  ) {
    return null;
  }
  const expectedAfter =
    result.requested > 0
      ? result.before + result.requested
      : Math.max(0, result.before + result.requested);
  return result.after === expectedAfter ? result : null;
}

function responseBody(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

/**
 * Durable write precedes the network call. Any non-acknowledged outcome keeps
 * the request UUID so a retry cannot become a second financial mutation.
 */
export async function submitCreditAdjustment(
  input: CreditAdjustmentInput,
  options: RequestOptions,
): Promise<CreditAdjustmentResult> {
  return withAdjustmentLock(
    input.targetUserId,
    options.runExclusive,
    async () => {
      const fetcher = options.fetcher ?? fetch;
      const existing = readPendingCreditAdjustment(
        input.targetUserId,
        options.storage,
      );
      const pending =
        existing ??
        ({
          requestId: (options.mintRequestId ?? (() => crypto.randomUUID()))(),
          targetUserId: input.targetUserId,
        } satisfies PendingCreditAdjustment);
      if (!existing) {
        persistPendingCreditAdjustment(pending, options.storage);
      }
      options.onPending?.(pending);

      const delivery = await runBoundedClientJsonFetch({
        input: "/api/admin/adjust",
        fetcher,
        signal: options.signal,
        deadlineMs: options.deadlineMs,
        attemptMs: options.attemptMs,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
          action: "apply",
          requestId: pending.requestId,
          targetUserId: input.targetUserId,
          delta: input.delta,
          reason: input.reason,
          }),
        },
      });
      if (delivery.kind !== "confirmed") {
        if (
          delivery.kind === "unconfirmed" &&
          delivery.error instanceof Error
        ) {
          throw delivery.error;
        }
        throw new CreditAdjustmentHttpError(
          0,
          delivery.kind === "aborted"
            ? "adjustment_aborted"
            : "adjustment_response_unconfirmed",
        );
      }
      const { response } = delivery.value;
      const body = responseBody(delivery.value.body);
      if (!response.ok) {
        const code =
          typeof body.error === "string" ? body.error : "adjustment_failed";
        if (code === "request_aborted") {
          clearPendingCreditAdjustment(input.targetUserId, options.storage);
        }
        throw new CreditAdjustmentHttpError(response.status, code);
      }
      const result = parseCreditAdjustmentResult(body);
      if (!result || result.requested !== input.delta) {
        throw new Error("invalid_credit_adjustment_ack");
      }
      clearPendingCreditAdjustment(input.targetUserId, options.storage);
      return result;
    },
  );
}

export async function recoverCreditAdjustment(
  targetUserId: string,
  options: Pick<
    RequestOptions,
    | "storage"
    | "fetcher"
    | "runExclusive"
    | "signal"
    | "deadlineMs"
    | "attemptMs"
  >,
): Promise<
  | { kind: "none" }
  | { kind: "completed"; result: CreditAdjustmentResult }
  | { kind: "aborted" }
> {
  return withAdjustmentLock(targetUserId, options.runExclusive, async () => {
    const pending = readPendingCreditAdjustment(targetUserId, options.storage);
    if (!pending) return { kind: "none" };
    const fetcher = options.fetcher ?? fetch;
    const delivery = await runBoundedClientJsonFetch({
      input: "/api/admin/adjust",
      fetcher,
      signal: options.signal,
      deadlineMs: options.deadlineMs,
      attemptMs: options.attemptMs,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "recover",
          requestId: pending.requestId,
          targetUserId,
        }),
      },
    });
    if (delivery.kind !== "confirmed") {
      if (
        delivery.kind === "unconfirmed" &&
        delivery.error instanceof Error
      ) {
        throw delivery.error;
      }
      throw new CreditAdjustmentHttpError(
        0,
        delivery.kind === "aborted"
          ? "recovery_aborted"
          : "recovery_response_unconfirmed",
      );
    }
    const { response } = delivery.value;
    const body = responseBody(delivery.value.body);
    if (!response.ok) {
      const code =
        typeof body.error === "string" ? body.error : "recovery_failed";
      throw new CreditAdjustmentHttpError(response.status, code);
    }
    if (body.found === true && body.aborted === false) {
      const result = parseCreditAdjustmentResult(body.result);
      if (!result) throw new Error("invalid_credit_adjustment_recovery");
      clearPendingCreditAdjustment(targetUserId, options.storage);
      return { kind: "completed", result };
    }
    if (body.found === false && body.aborted === true) {
      clearPendingCreditAdjustment(targetUserId, options.storage);
      return { kind: "aborted" };
    }
    throw new Error("invalid_credit_adjustment_recovery");
  });
}
