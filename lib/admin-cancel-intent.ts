import { runBoundedClientJsonFetch } from "./client-mutation.ts";

export type AdminCancelIntentStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type AdminCancelIntentInput = {
  orderUuid: string;
  reason: string;
  customerRequestedAt: string;
};

export type AdminCancelIntentOutcome = {
  ok: true;
  outcome:
    | "canceled"
    | "already_canceled"
    | "refund_prepared"
    | "resolved_full"
    | "ineligible"
    | "canceled_unpaid"
    | "observed";
  requestId?: string;
  attemptId?: string;
  qty?: number;
  amount?: number;
  batchId?: string;
};

export type CancelIntentExclusiveRunner = <T>(
  name: string,
  task: () => Promise<T>,
) => Promise<T>;

type SubmitOptions = {
  storage: AdminCancelIntentStorage;
  fetcher?: typeof fetch;
  runExclusive?: CancelIntentExclusiveRunner;
  onPending?: (pending: AdminCancelIntentInput) => void;
  signal?: AbortSignal;
  deadlineMs?: number;
  attemptMs?: number;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_PREFIX = "boss-paegi:admin-cancel-intent:";
const LOCK_PREFIX = "boss-paegi:admin-cancel-intent:";
const SIMPLE_OUTCOMES = new Set([
  "canceled",
  "already_canceled",
  "ineligible",
  "canceled_unpaid",
  "observed",
]);

export class AdminCancelIntentError extends Error {
  readonly status: number | null;

  constructor(code: string, status: number | null = null, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "AdminCancelIntentError";
    this.status = status;
  }
}

const browserExclusiveRunner: CancelIntentExclusiveRunner = async (
  name,
  task,
) => {
  const lockManager =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) {
    throw new AdminCancelIntentError("cancel_cross_tab_lock_unavailable");
  }
  return lockManager.request(
    name,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        throw new AdminCancelIntentError("cancel_already_in_progress");
      }
      return task();
    },
  );
};

function key(orderUuid: string): string {
  return `${STORAGE_PREFIX}${orderUuid}`;
}

function validInput(value: unknown): value is AdminCancelIntentInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.orderUuid === "string" &&
    UUID_RE.test(row.orderUuid) &&
    typeof row.reason === "string" &&
    row.reason === row.reason.trim() &&
    Array.from(row.reason).length >= 5 &&
    Array.from(row.reason).length <= 500 &&
    typeof row.customerRequestedAt === "string" &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(row.customerRequestedAt) &&
    Number.isFinite(Date.parse(row.customerRequestedAt))
  );
}

function sameInput(
  left: AdminCancelIntentInput,
  right: AdminCancelIntentInput,
): boolean {
  return (
    left.orderUuid === right.orderUuid &&
    left.reason === right.reason &&
    left.customerRequestedAt === right.customerRequestedAt
  );
}

function storageError(cause: unknown): AdminCancelIntentError {
  return new AdminCancelIntentError(
    "cancel_receipt_storage_unavailable",
    null,
    cause,
  );
}

export function readPendingAdminCancelIntent(
  orderUuid: string,
  storage: AdminCancelIntentStorage,
): AdminCancelIntentInput | null {
  if (!UUID_RE.test(orderUuid)) {
    throw new AdminCancelIntentError("invalid_cancel_intent");
  }
  let raw: string | null;
  try {
    raw = storage.getItem(key(orderUuid));
  } catch (error) {
    throw storageError(error);
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (validInput(parsed) && parsed.orderUuid === orderUuid) {
      return parsed;
    }
  } catch (error) {
    if (error instanceof AdminCancelIntentError) throw error;
  }
  // A malformed receipt may represent a mutation whose response was lost.
  // Never erase that evidence and issue a new financial request automatically.
  throw new AdminCancelIntentError("invalid_cancel_intent");
}

export function persistPendingAdminCancelIntent(
  input: AdminCancelIntentInput,
  storage: AdminCancelIntentStorage,
): void {
  if (!validInput(input)) {
    throw new AdminCancelIntentError("invalid_cancel_intent");
  }
  try {
    storage.setItem(key(input.orderUuid), JSON.stringify(input));
  } catch (error) {
    throw storageError(error);
  }
}

function clearPendingAdminCancelIntent(
  input: AdminCancelIntentInput,
  storage: AdminCancelIntentStorage,
): void {
  const pending = readPendingAdminCancelIntent(input.orderUuid, storage);
  if (pending && !sameInput(pending, input)) {
    throw new AdminCancelIntentError("cancel_receipt_correlation_mismatch");
  }
  try {
    storage.removeItem(key(input.orderUuid));
  } catch (error) {
    throw storageError(error);
  }
}

export function parseAdminCancelIntentOutcome(
  value: unknown,
): AdminCancelIntentOutcome | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true || typeof row.outcome !== "string") return null;
  if (SIMPLE_OUTCOMES.has(row.outcome)) {
    return { ok: true, outcome: row.outcome } as AdminCancelIntentOutcome;
  }
  if (row.outcome === "resolved_full") {
    return typeof row.batchId === "string" && UUID_RE.test(row.batchId)
      ? { ok: true, outcome: "resolved_full", batchId: row.batchId }
      : null;
  }
  if (
    row.outcome === "refund_prepared" &&
    typeof row.requestId === "string" &&
    UUID_RE.test(row.requestId) &&
    typeof row.attemptId === "string" &&
    UUID_RE.test(row.attemptId) &&
    Number.isSafeInteger(row.qty) &&
    (row.qty as number) > 0 &&
    Number.isSafeInteger(row.amount) &&
    (row.amount as number) > 0
  ) {
    return {
      ok: true,
      outcome: "refund_prepared",
      requestId: row.requestId,
      attemptId: row.attemptId,
      qty: row.qty as number,
      amount: row.amount as number,
    };
  }
  return null;
}

export async function submitAdminCancelIntent(
  input: AdminCancelIntentInput,
  options: SubmitOptions,
): Promise<AdminCancelIntentOutcome> {
  if (!validInput(input)) {
    throw new AdminCancelIntentError("invalid_cancel_intent");
  }
  const runner = options.runExclusive ?? browserExclusiveRunner;
  return runner(`${LOCK_PREFIX}${input.orderUuid}`, async () => {
    const existing = readPendingAdminCancelIntent(
      input.orderUuid,
      options.storage,
    );
    if (existing && !sameInput(existing, input)) {
      throw new AdminCancelIntentError("cancel_intent_conflict");
    }
    if (!existing) {
      persistPendingAdminCancelIntent(input, options.storage);
    }
    options.onPending?.(existing ?? input);

    const fetcher = options.fetcher ?? fetch;
    const delivery = await runBoundedClientJsonFetch({
      input: "/api/admin/cancel",
      fetcher,
      signal: options.signal,
      deadlineMs: options.deadlineMs,
      attemptMs: options.attemptMs,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      },
    });
    if (delivery.kind !== "confirmed") {
      throw new AdminCancelIntentError(
        "cancel_transport_failed",
        null,
        delivery.kind === "unconfirmed" ? delivery.error : undefined,
      );
    }
    const { response, body } = delivery.value;
    if (!response.ok) {
      const code =
        body &&
        typeof body === "object" &&
        typeof (body as { error?: unknown }).error === "string"
          ? (body as { error: string }).error
          : "cancel_failed";
      throw new AdminCancelIntentError(code, response.status);
    }
    const outcome = parseAdminCancelIntentOutcome(body);
    if (!outcome) {
      throw new AdminCancelIntentError("invalid_cancel_ack");
    }
    clearPendingAdminCancelIntent(input, options.storage);
    return outcome;
  });
}
