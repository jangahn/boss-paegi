import { runBoundedClientJsonFetch } from "./client-mutation.ts";

export type RefundIntentStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;

export type AdminRefundBeginInput = {
  orderUuid: string;
  userId: string;
  qty: number;
  customerRequestedAt: string;
  reason: string;
};

export type PendingAdminRefundIntent = AdminRefundBeginInput & {
  requestId: string;
  attemptId: string | null;
};

export type AdminRefundBeginAck = {
  ok: true;
  outcome: "prepared" | "no_op";
  request_id: string;
  attempt_id: string;
  qty: number;
  amount: number;
  rate_bps: 9000 | 10000;
  idempotent?: true;
};

export type RefundIntentExclusiveRunner = <T>(
  name: string,
  task: () => Promise<T>,
) => Promise<T>;

type BeginOptions = {
  storage: RefundIntentStorage;
  fetcher?: typeof fetch;
  mintRequestId?: () => string;
  runExclusive?: RefundIntentExclusiveRunner;
  signal?: AbortSignal;
  deadlineMs?: number;
  attemptMs?: number;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const STORAGE_PREFIX = "boss-paegi:admin-refund:";
const LOCK_PREFIX = "boss-paegi:admin-refund:";

export class AdminRefundIntentError extends Error {
  readonly status: number | null;

  constructor(code: string, status: number | null = null, cause?: unknown) {
    super(code, cause === undefined ? undefined : { cause });
    this.name = "AdminRefundIntentError";
    this.status = status;
  }
}

const browserExclusiveRunner: RefundIntentExclusiveRunner = async (
  name,
  task,
) => {
  const lockManager =
    typeof navigator === "undefined" ? undefined : navigator.locks;
  if (!lockManager) {
    throw new AdminRefundIntentError("refund_cross_tab_lock_unavailable");
  }
  return lockManager.request(
    name,
    { mode: "exclusive", ifAvailable: true },
    async (lock) => {
      if (!lock) {
        throw new AdminRefundIntentError("refund_already_in_progress");
      }
      return task();
    },
  );
};

function key(orderUuid: string): string {
  return `${STORAGE_PREFIX}${orderUuid}`;
}

function validTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    Number.isFinite(Date.parse(value)) &&
    /(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  );
}

function validInput(value: unknown): value is AdminRefundBeginInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.orderUuid === "string" &&
    UUID_RE.test(row.orderUuid) &&
    typeof row.userId === "string" &&
    UUID_RE.test(row.userId) &&
    Number.isSafeInteger(row.qty) &&
    (row.qty as number) > 0 &&
    validTimestamp(row.customerRequestedAt) &&
    typeof row.reason === "string" &&
    row.reason === row.reason.trim() &&
    Array.from(row.reason).length >= 5 &&
    Array.from(row.reason).length <= 500
  );
}

function validPending(
  value: unknown,
  orderUuid: string,
): value is PendingAdminRefundIntent {
  if (!validInput(value)) return false;
  const row = value as unknown as Record<string, unknown>;
  return (
    row.orderUuid === orderUuid &&
    typeof row.requestId === "string" &&
    UUID_RE.test(row.requestId) &&
    (row.attemptId === null ||
      (typeof row.attemptId === "string" && UUID_RE.test(row.attemptId)))
  );
}

function sameInput(
  pending: PendingAdminRefundIntent,
  input: AdminRefundBeginInput,
): boolean {
  return (
    pending.orderUuid === input.orderUuid &&
    pending.userId === input.userId &&
    pending.qty === input.qty &&
    pending.customerRequestedAt === input.customerRequestedAt &&
    pending.reason === input.reason
  );
}

function storageFailure(cause: unknown): AdminRefundIntentError {
  return new AdminRefundIntentError(
    "refund_receipt_storage_unavailable",
    null,
    cause,
  );
}

export function readPendingAdminRefundIntent(
  orderUuid: string,
  storage: RefundIntentStorage,
): PendingAdminRefundIntent | null {
  let raw: string | null;
  try {
    raw = storage.getItem(key(orderUuid));
  } catch (error) {
    throw storageFailure(error);
  }
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (validPending(parsed, orderUuid)) return parsed;
  } catch {
    // A malformed local receipt is removed only if durable storage allows it.
  }
  try {
    storage.removeItem(key(orderUuid));
  } catch (error) {
    throw storageFailure(error);
  }
  return null;
}

export function persistPendingAdminRefundIntent(
  pending: PendingAdminRefundIntent,
  storage: RefundIntentStorage,
): void {
  if (!validPending(pending, pending.orderUuid)) {
    throw new AdminRefundIntentError("invalid_refund_intent");
  }
  try {
    storage.setItem(key(pending.orderUuid), JSON.stringify(pending));
  } catch (error) {
    throw storageFailure(error);
  }
}

export function clearPendingAdminRefundIntent(
  orderUuid: string,
  attemptId: string,
  storage: RefundIntentStorage,
): void {
  const pending = readPendingAdminRefundIntent(orderUuid, storage);
  if (!pending) return;
  if (pending.attemptId !== attemptId) {
    throw new AdminRefundIntentError("refund_receipt_correlation_mismatch");
  }
  try {
    storage.removeItem(key(orderUuid));
  } catch (error) {
    throw storageFailure(error);
  }
}

export function parseAdminRefundBeginAck(
  value: unknown,
  expected: {
    requestId: string;
    qty: number;
  },
): AdminRefundBeginAck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true ||
    (row.outcome !== "prepared" && row.outcome !== "no_op") ||
    row.request_id !== expected.requestId ||
    typeof row.attempt_id !== "string" ||
    !UUID_RE.test(row.attempt_id) ||
    row.qty !== expected.qty ||
    !Number.isSafeInteger(row.amount) ||
    (row.amount as number) <= 0 ||
    (row.rate_bps !== 9000 && row.rate_bps !== 10000) ||
    (row.outcome === "no_op" && row.idempotent !== true)
  ) {
    return null;
  }
  return row as AdminRefundBeginAck;
}

/**
 * The exact begin intent is durably stored before the request. A valid server
 * proof is then stored with its attempt id before the caller can invoke the PG
 * process step. Any ambiguous outcome leaves the same UUID/payload recoverable.
 */
export async function beginOrRecoverAdminRefund(
  input: AdminRefundBeginInput,
  options: BeginOptions,
): Promise<{
  pending: PendingAdminRefundIntent;
  ack: AdminRefundBeginAck | null;
}> {
  if (!validInput(input)) {
    throw new AdminRefundIntentError("invalid_refund_intent");
  }
  const runner = options.runExclusive ?? browserExclusiveRunner;
  return runner(`${LOCK_PREFIX}${input.orderUuid}`, async () => {
    const existing = readPendingAdminRefundIntent(
      input.orderUuid,
      options.storage,
    );
    if (existing && !sameInput(existing, input)) {
      throw new AdminRefundIntentError("refund_intent_conflict");
    }
    if (existing?.attemptId) {
      return { pending: existing, ack: null };
    }
    const pending =
      existing ??
      ({
        ...input,
        requestId: (
          options.mintRequestId ?? (() => crypto.randomUUID())
        )(),
        attemptId: null,
      } satisfies PendingAdminRefundIntent);
    if (!existing) {
      persistPendingAdminRefundIntent(pending, options.storage);
    }

    const fetcher = options.fetcher ?? fetch;
    const delivery = await runBoundedClientJsonFetch({
      input: "/api/admin/refund-credits",
      fetcher,
      signal: options.signal,
      deadlineMs: options.deadlineMs,
      attemptMs: options.attemptMs,
      init: {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "begin",
          requestId: pending.requestId,
          userId: pending.userId,
          orderUuid: pending.orderUuid,
          qty: pending.qty,
          customerRequestedAt: pending.customerRequestedAt,
          reason: pending.reason,
        }),
      },
    });
    if (delivery.kind !== "confirmed") {
      throw new AdminRefundIntentError(
        "refund_begin_transport_failed",
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
          : "refund_begin_failed";
      throw new AdminRefundIntentError(code, response.status);
    }
    const ack = parseAdminRefundBeginAck(body, {
      requestId: pending.requestId,
      qty: pending.qty,
    });
    if (!ack) {
      throw new AdminRefundIntentError("invalid_refund_begin_ack");
    }
    const advanced = { ...pending, attemptId: ack.attempt_id };
    persistPendingAdminRefundIntent(advanced, options.storage);
    return { pending: advanced, ack };
  });
}

export async function recoverPendingAdminRefund(
  orderUuid: string,
  options: BeginOptions,
): Promise<
  | { kind: "none" }
  | {
      kind: "ready";
      pending: PendingAdminRefundIntent;
      ack: AdminRefundBeginAck | null;
    }
> {
  const pending = readPendingAdminRefundIntent(orderUuid, options.storage);
  if (!pending) return { kind: "none" };
  const recovered = await beginOrRecoverAdminRefund(pending, options);
  return { kind: "ready", ...recovered };
}
