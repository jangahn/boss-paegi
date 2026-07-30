const ORDER_STATUSES = new Set(["pending", "paid", "canceled", "failed"]);
const TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    TIMESTAMP_RE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function isUuid(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  );
}

function safeInteger(value: unknown): number | null {
  if (Number.isSafeInteger(value)) return value as number;
  if (typeof value === "string" && /^(?:0|[1-9]\d*)$/.test(value)) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

/**
 * `mark_paid_and_grant` has a scalar boolean contract. `false` is a valid
 * concurrency/idempotency acknowledgement; null and every truthy lookalike
 * are protocol failures.
 */
export function parseMarkPaidAndGrantResult(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

export type PaidOrderPostcondition = {
  status: "paid";
  paidAt: string;
  errorMessage: string | null;
};

export type PaidOrderHttpStatus = "paid" | "paid_review";

/**
 * `orders.status = paid` is provider settlement truth, not proof that live
 * credits were granted. The financial RPC deliberately records quarantined
 * late/deleted/cancel-intent payments as paid with an error marker. Any marker
 * therefore fails closed to a review state instead of claiming credit success.
 */
export function paidOrderHttpStatus(
  value: PaidOrderPostcondition,
): PaidOrderHttpStatus {
  return value.errorMessage === null ? "paid" : "paid_review";
}

/** Durable evidence required before any caller reports a PAID transition. */
export function parsePaidOrderPostcondition(
  value: unknown,
): PaidOrderPostcondition | null {
  if (!isRecord(value) || value.status !== "paid" || !isTimestamp(value.paid_at)) {
    return null;
  }
  if (
    value.error_message !== null &&
    (typeof value.error_message !== "string" ||
      value.error_message.length < 1 ||
      value.error_message.length > 500)
  ) {
    return null;
  }
  return {
    status: "paid",
    paidAt: value.paid_at,
    errorMessage: value.error_message,
  };
}

export type MarkOrderFailedResult =
  | { outcome: "failed" }
  | { outcome: "no_op" }
  | {
      outcome: "skipped";
      status: "pending" | "paid" | "canceled" | "failed";
    };

/** Exact JSON acknowledgement contract of `mark_order_failed`. */
export function parseMarkOrderFailedResult(
  value: unknown,
): MarkOrderFailedResult | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (value.outcome === "failed") return { outcome: "failed" };
  if (value.outcome === "no_op" && value.idempotent === true) {
    return { outcome: "no_op" };
  }
  if (
    value.outcome === "skipped" &&
    typeof value.status === "string" &&
    ORDER_STATUSES.has(value.status)
  ) {
    return {
      outcome: "skipped",
      status: value.status as "pending" | "paid" | "canceled" | "failed",
    };
  }
  return null;
}

export type MarkOrderCanceledUnpaidResult =
  | { outcome: "canceled" }
  | { outcome: "no_op" }
  | {
      outcome: "skipped";
      status: "pending" | "paid" | "canceled" | "failed";
    };

export function parseMarkOrderCanceledUnpaidResult(
  value: unknown,
): MarkOrderCanceledUnpaidResult | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (value.outcome === "canceled") return { outcome: "canceled" };
  if (value.outcome === "no_op" && value.idempotent === true) {
    return { outcome: "no_op" };
  }
  if (
    value.outcome === "skipped" &&
    typeof value.status === "string" &&
    ORDER_STATUSES.has(value.status)
  ) {
    return {
      outcome: "skipped",
      status: value.status as "pending" | "paid" | "canceled" | "failed",
    };
  }
  return null;
}

export function isCanceledUnpaidPostcondition(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.status === "canceled" &&
    isTimestamp(value.canceled_at) &&
    value.paid_at === null
  );
}

export type AutoFullCancellationResult =
  | { outcome: "ineligible" }
  | { outcome: "resolved_full"; batchId: string; events: number };

export function parseAutoFullCancellationResult(
  value: unknown,
): AutoFullCancellationResult | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (value.outcome === "ineligible") return { outcome: "ineligible" };
  if (
    value.outcome === "resolved_full" &&
    typeof value.batch_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value.batch_id,
    ) &&
    Number.isSafeInteger(value.events) &&
    (value.events as number) > 0
  ) {
    return {
      outcome: "resolved_full",
      batchId: value.batch_id,
      events: value.events as number,
    };
  }
  return null;
}

export function isResolvedFullCancellationPostcondition(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.status === "canceled" &&
    isTimestamp(value.canceled_at) &&
    isTimestamp(value.paid_at) &&
    Number.isSafeInteger(value.amount) &&
    (value.amount as number) >= 0 &&
    Number.isSafeInteger(value.credits) &&
    (value.credits as number) >= 0 &&
    value.refunded_amount === value.amount &&
    value.refunded_credits === value.credits
  );
}

export function parseCancelIntentBeginResult(
  value: unknown,
): "intent_recorded" | "no_op" | null {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    !Number.isSafeInteger(value.order_version) ||
    (value.order_version as number) <= 0
  ) {
    return null;
  }
  if (value.outcome === "intent_recorded") return "intent_recorded";
  if (value.outcome === "no_op" && value.idempotent === true) {
    return "no_op";
  }
  return null;
}

export function isCancelIntentPostcondition(
  value: unknown,
  expected: {
    orderUuid: string;
    customerRequestedAt: string;
    reason: string;
  },
): boolean {
  return (
    isRecord(value) &&
    value.order_uuid === expected.orderUuid &&
    isTimestamp(value.cancel_requested_at) &&
    isTimestamp(value.cancel_intent_created_at) &&
    Date.parse(value.cancel_requested_at) ===
      Date.parse(expected.customerRequestedAt) &&
    value.cancel_intent_reason === expected.reason
  );
}

export type CancelIntentResolveResult = {
  outcome: "prepared" | "no_op";
  requestId: string;
  attemptId: string;
  qty: number;
  amount: number;
};

export function parseCancelIntentResolveResult(
  value: unknown,
  expectedQty: number,
): CancelIntentResolveResult | null {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    (value.outcome !== "prepared" && value.outcome !== "no_op") ||
    (value.outcome === "no_op" && value.idempotent !== true) ||
    !isUuid(value.request_id) ||
    !isUuid(value.attempt_id) ||
    value.qty !== expectedQty ||
    !Number.isSafeInteger(expectedQty) ||
    expectedQty <= 0
  ) {
    return null;
  }
  const amount = safeInteger(value.amount);
  if (amount === null || amount <= 0) return null;
  return {
    outcome: value.outcome,
    requestId: value.request_id,
    attemptId: value.attempt_id,
    qty: expectedQty,
    amount,
  };
}

export function isCancelIntentResolvePostcondition(
  requestValue: unknown,
  attemptValue: unknown,
  expected: {
    orderUuid: string;
    requestId: string;
    attemptId: string;
    qty: number;
    amount: number;
  },
): boolean {
  if (!isRecord(requestValue) || !isRecord(attemptValue)) return false;
  const durableRequestStates = new Set([
    "prepared",
    "processing",
    "blocked",
    "completed",
    "partial",
    "failed",
    "cancelled",
  ]);
  const durableAttemptStates = new Set([
    "prepared",
    "pg_requested",
    "pg_pending",
    "pg_succeeded",
    "manual_pending",
    "manual_review",
    "committed",
    "released",
  ]);
  return (
    requestValue.id === expected.requestId &&
    requestValue.origin === "cancel_intent" &&
    requestValue.scope_order_uuid === expected.orderUuid &&
    requestValue.requested_qty === expected.qty &&
    safeInteger(requestValue.approved_amount) === expected.amount &&
    typeof requestValue.state === "string" &&
    durableRequestStates.has(requestValue.state) &&
    attemptValue.id === expected.attemptId &&
    attemptValue.request_id === expected.requestId &&
    attemptValue.order_uuid === expected.orderUuid &&
    attemptValue.sequence === 1 &&
    attemptValue.qty === expected.qty &&
    safeInteger(attemptValue.amount) === expected.amount &&
    typeof attemptValue.state === "string" &&
    durableAttemptStates.has(attemptValue.state)
  );
}

export function parseAdminCancelOrderResult(value: unknown): boolean {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    value.clawback !== 0 ||
    value.shortfall !== 0
  ) {
    return false;
  }
  const before = safeInteger(value.before);
  const after = safeInteger(value.after);
  return before !== null && before >= 0 && after === before;
}
