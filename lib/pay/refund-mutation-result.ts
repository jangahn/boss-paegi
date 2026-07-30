const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeInteger(value: unknown): number | null {
  if (Number.isSafeInteger(value)) return value as number;
  if (
    typeof value === "string" &&
    /^(?:0|[1-9]\d*)$/.test(value)
  ) {
    const parsed = Number(value);
    if (Number.isSafeInteger(parsed)) return parsed;
  }
  return null;
}

function exactStringArray(
  value: unknown,
  expected: readonly string[],
): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

function exactPayoutEvidence(
  value: unknown,
  evidenceObjectId: string,
): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    value.method === "bank_transfer" &&
    value.evidence_object_id === evidenceObjectId
  );
}

export type RefundPgRequestBody = {
  amount: number;
  reason: string;
  currentCancellableAmount: number;
};

function exactRequestBody(
  value: unknown,
  expected: RefundPgRequestBody,
): boolean {
  return (
    isRecord(value) &&
    Object.keys(value).length === 3 &&
    value.amount === expected.amount &&
    value.reason === expected.reason &&
    value.currentCancellableAmount === expected.currentCancellableAmount
  );
}

export function parseRefundMarkRequestedResult(
  value: unknown,
  attemptId: string,
): "pg_requested" | "no_op" | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (
    value.outcome === "pg_requested" &&
    value.attempt_id === attemptId &&
    UUID_RE.test(attemptId)
  ) {
    return "pg_requested";
  }
  if (value.outcome === "no_op" && value.idempotent === true) {
    return "no_op";
  }
  return null;
}

export function isRefundPgRequestedPostcondition(
  value: unknown,
  expected: {
    attemptId: string;
    totalBefore: number;
    cancelledBefore: number;
    cancellableBefore: number;
    cancellationIdsBefore: string[];
    requestBody: RefundPgRequestBody;
  },
): boolean {
  return (
    isRecord(value) &&
    value.id === expected.attemptId &&
    value.state === "pg_requested" &&
    value.pg_idempotency_key === expected.attemptId &&
    value.pg_total_before === expected.totalBefore &&
    value.pg_cancelled_before === expected.cancelledBefore &&
    value.pg_cancellable_before === expected.cancellableBefore &&
    Array.isArray(value.pg_cancellation_ids_before) &&
    value.pg_cancellation_ids_before.length ===
      expected.cancellationIdsBefore.length &&
    value.pg_cancellation_ids_before.every(
      (entry, index) => entry === expected.cancellationIdsBefore[index],
    ) &&
    exactRequestBody(value.pg_request_body, expected.requestBody) &&
    typeof value.pg_requested_at === "string" &&
    Number.isFinite(Date.parse(value.pg_requested_at))
  );
}

export function parseRefundRecordResult(
  value: unknown,
  expected:
    | { kind: "succeeded"; cancellationId: string }
    | { kind: "pending" }
    | { kind: "failed" },
): "recorded" | "no_op" | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (value.outcome === "no_op" && value.idempotent === true) {
    return expected.kind === "succeeded" ? "no_op" : null;
  }
  if (
    expected.kind === "succeeded" &&
    value.outcome === "pg_succeeded" &&
    value.cancellation_id === expected.cancellationId
  ) {
    return "recorded";
  }
  if (expected.kind === "pending" && value.outcome === "pending") {
    return "recorded";
  }
  if (expected.kind === "failed" && value.outcome === "manual_review") {
    return "recorded";
  }
  return null;
}

export function parseRefundCommitResult(
  value: unknown,
  attemptId: string,
): "committed" | "no_op" | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (
    value.outcome === "committed" &&
    value.attempt_id === attemptId &&
    UUID_RE.test(attemptId)
  ) {
    return "committed";
  }
  if (value.outcome === "no_op" && value.idempotent === true) {
    return "no_op";
  }
  return null;
}

export function isRefundAttemptStatePostcondition(
  value: unknown,
  expectedStates: readonly string[],
  cancellationId?: string,
): boolean {
  return (
    isRecord(value) &&
    typeof value.state === "string" &&
    expectedStates.includes(value.state) &&
    (cancellationId === undefined || value.pg_cancel_id === cancellationId)
  );
}

export type AdminRefundBeginResult =
  | {
      kind: "prepared";
      requestId: string;
      attemptId: string;
      qty: number;
      amount: number;
      rateBps: 9000 | 10000;
    }
  | {
      kind: "no_op";
      requestId: string;
    };

/**
 * admin_refund_begin is a financial mutation. A resolved SDK call is not an
 * acknowledgement unless every receipt field has the exact expected type and
 * correlation. In particular, `{ data:null, error:null }` is never success.
 */
export function parseAdminRefundBeginResult(
  value: unknown,
  expected: { requestId: string; qty: number },
): AdminRefundBeginResult | null {
  if (
    !UUID_RE.test(expected.requestId) ||
    !Number.isSafeInteger(expected.qty) ||
    expected.qty <= 0 ||
    !isRecord(value) ||
    value.ok !== true ||
    value.request_id !== expected.requestId
  ) {
    return null;
  }
  if (value.outcome === "no_op" && value.idempotent === true) {
    return { kind: "no_op", requestId: expected.requestId };
  }
  const amount = safeInteger(value.amount);
  const rateBps = safeInteger(value.rate_bps);
  if (
    value.outcome !== "prepared" ||
    typeof value.attempt_id !== "string" ||
    !UUID_RE.test(value.attempt_id) ||
    value.qty !== expected.qty ||
    amount === null ||
    amount <= 0 ||
    (rateBps !== 9000 && rateBps !== 10000)
  ) {
    return null;
  }
  return {
    kind: "prepared",
    requestId: expected.requestId,
    attemptId: value.attempt_id,
    qty: expected.qty,
    amount,
    rateBps,
  };
}

const REFUND_REQUEST_DURABLE_STATES = new Set([
  "prepared",
  "processing",
  "blocked",
  "completed",
  "partial",
  "failed",
  "cancelled",
]);
const REFUND_ATTEMPT_DURABLE_STATES = new Set([
  "prepared",
  "pg_requested",
  "pg_pending",
  "pg_succeeded",
  "manual_pending",
  "manual_review",
  "committed",
  "released",
]);

export type AdminRefundBeginProof = {
  ok: true;
  outcome: "prepared" | "no_op";
  idempotent?: true;
  request_id: string;
  attempt_id: string;
  qty: number;
  amount: number;
  rate_bps: 9000 | 10000;
};

/**
 * A begin acknowledgement is exposed only after the request and its first
 * attempt are durably correlated. The normalized proof also restores
 * `attempt_id` for an idempotent replay, which the legacy SQL receipt omits.
 */
export function proveAdminRefundBegin(
  receipt: AdminRefundBeginResult,
  requestValue: unknown,
  attemptValue: unknown,
  expected: {
    requestId: string;
    userId: string;
    orderUuid: string;
    qty: number;
  },
): AdminRefundBeginProof | null {
  if (
    !isRecord(requestValue) ||
    !isRecord(attemptValue) ||
    requestValue.id !== expected.requestId ||
    requestValue.user_id !== expected.userId ||
    requestValue.origin !== "admin_manual" ||
    requestValue.requested_qty !== expected.qty ||
    typeof requestValue.state !== "string" ||
    !REFUND_REQUEST_DURABLE_STATES.has(requestValue.state) ||
    attemptValue.request_id !== expected.requestId ||
    attemptValue.order_uuid !== expected.orderUuid ||
    attemptValue.user_id !== expected.userId ||
    attemptValue.sequence !== 1 ||
    attemptValue.qty !== expected.qty ||
    typeof attemptValue.id !== "string" ||
    !UUID_RE.test(attemptValue.id) ||
    typeof attemptValue.state !== "string" ||
    !REFUND_ATTEMPT_DURABLE_STATES.has(attemptValue.state)
  ) {
    return null;
  }
  const approvedAmount = safeInteger(requestValue.approved_amount);
  const amount = safeInteger(attemptValue.amount);
  const rateBps = safeInteger(attemptValue.rate_bps);
  if (
    approvedAmount === null ||
    approvedAmount <= 0 ||
    amount !== approvedAmount ||
    (rateBps !== 9000 && rateBps !== 10000)
  ) {
    return null;
  }
  if (
    receipt.kind === "prepared" &&
    (receipt.attemptId !== attemptValue.id ||
      receipt.qty !== expected.qty ||
      receipt.amount !== amount ||
      receipt.rateBps !== rateBps)
  ) {
    return null;
  }
  return {
    ok: true,
    outcome: receipt.kind,
    ...(receipt.kind === "no_op" ? { idempotent: true as const } : {}),
    request_id: expected.requestId,
    attempt_id: attemptValue.id,
    qty: expected.qty,
    amount,
    rate_bps: rateBps,
  };
}

export type AdminRefundAttemptAction =
  | "release"
  | "commit_manual"
  | "switch_to_manual"
  | "replan_pre_pg"
  | "replan_after_pg";

export function parseAdminRefundAttemptResult(
  value: unknown,
  expected: {
    action: AdminRefundAttemptAction;
    attemptId: string;
  },
): "applied" | "no_op" | null {
  if (
    !UUID_RE.test(expected.attemptId) ||
    !isRecord(value) ||
    value.ok !== true
  ) {
    return null;
  }
  if (value.outcome === "no_op" && value.idempotent === true) {
    return "no_op";
  }
  switch (expected.action) {
    case "release":
      return value.outcome === "released" &&
        value.attempt_id === expected.attemptId
        ? "applied"
        : null;
    case "commit_manual":
      return value.outcome === "committed" &&
        value.attempt_id === expected.attemptId
        ? "applied"
        : null;
    case "switch_to_manual":
      return value.outcome === "manual_pending" &&
        value.attempt_id === expected.attemptId
        ? "applied"
        : null;
    case "replan_pre_pg":
      return value.outcome === "released" &&
        value.release_reason === "replanned_before_pg"
        ? "applied"
        : null;
    case "replan_after_pg":
      return value.outcome === "released" &&
        value.release_reason === "replanned_after_pg_reconciliation"
        ? "applied"
        : null;
  }
}

export function isAdminRefundAttemptPostcondition(
  value: unknown,
  expected:
    | {
        action: "release";
        attemptId: string;
      }
    | {
        action: "commit_manual";
        attemptId: string;
        externalPayoutRef: string;
        evidenceObjectId: string;
      }
    | {
        action: "switch_to_manual";
        attemptId: string;
        observedCancelledAmount: number;
        observedCancellationIds: string[];
      }
    | {
        action: "replan_pre_pg";
        attemptId: string;
      }
    | {
        action: "replan_after_pg";
        attemptId: string;
        observedCancelledAmount: number;
        observedCancellationIds: string[];
      },
): boolean {
  if (!isRecord(value) || value.id !== expected.attemptId) return false;
  switch (expected.action) {
    case "release":
      return (
        value.state === "released" &&
        value.release_reason === "admin_cancelled_before_pg"
      );
    case "commit_manual":
      return (
        value.state === "committed" &&
        value.rail === "manual_transfer" &&
        value.external_payout_ref === expected.externalPayoutRef &&
        exactPayoutEvidence(value.payout_evidence, expected.evidenceObjectId)
      );
    case "switch_to_manual":
      return (
        (value.state === "manual_pending" || value.state === "committed") &&
        value.rail === "manual_transfer" &&
        value.reconciliation_result === "no_movement" &&
        safeInteger(value.observed_cancelled_amount) ===
          expected.observedCancelledAmount &&
        exactStringArray(
          value.observed_cancellation_ids,
          expected.observedCancellationIds,
        ) &&
        value.verification_source === "admin_reconcile"
      );
    case "replan_pre_pg":
      return (
        value.state === "released" &&
        value.release_reason === "replanned_before_pg"
      );
    case "replan_after_pg":
      return (
        value.state === "released" &&
        value.release_reason === "replanned_after_pg_reconciliation" &&
        value.reconciliation_result === "no_movement" &&
        safeInteger(value.observed_cancelled_amount) ===
          expected.observedCancelledAmount &&
        exactStringArray(
          value.observed_cancellation_ids,
          expected.observedCancellationIds,
        ) &&
        value.verification_source === "admin_reconcile"
      );
  }
}

export type ExternalCancellationResolutionResult =
  | {
      kind: "resolved";
      result: {
        economic_qty: number;
        immediate: number;
        shortfall: number;
        live_recovered: number;
      };
    }
  | { kind: "no_op" };

export function parseExternalCancellationResolutionResult(
  value: unknown,
  expectedEconomicQty: number | null,
): ExternalCancellationResolutionResult | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (value.outcome === "no_op" && value.idempotent === true) {
    return { kind: "no_op" };
  }
  if (value.outcome !== "resolved" || !isRecord(value.result)) return null;
  const economicQty = safeInteger(value.result.economic_qty);
  const immediate = safeInteger(value.result.immediate);
  const shortfall = safeInteger(value.result.shortfall);
  const liveRecovered = safeInteger(value.result.live_recovered);
  if (
    economicQty === null ||
    immediate === null ||
    shortfall === null ||
    liveRecovered === null ||
    economicQty < 0 ||
    immediate < 0 ||
    shortfall < 0 ||
    liveRecovered < 0 ||
    immediate + shortfall !== economicQty ||
    liveRecovered > immediate ||
    (expectedEconomicQty !== null && economicQty !== expectedEconomicQty)
  ) {
    return null;
  }
  return {
    kind: "resolved",
    result: {
      economic_qty: economicQty,
      immediate,
      shortfall,
      live_recovered: liveRecovered,
    },
  };
}

export function isExternalCancellationResolutionPostcondition(
  value: unknown,
  expected: {
    cancellationId: string;
    economicQty: number | null;
  },
): boolean {
  if (
    !isRecord(value) ||
    value.cancellation_id !== expected.cancellationId ||
    value.resolution_state !== "resolved" ||
    typeof value.resolved_at !== "string" ||
    !Number.isFinite(Date.parse(value.resolved_at))
  ) {
    return false;
  }
  const economicQty = safeInteger(value.resolved_economic_qty);
  return (
    economicQty !== null &&
    economicQty >= 0 &&
    (expected.economicQty === null || economicQty === expected.economicQty)
  );
}

export function parseReconciliationIssueResolutionResult(
  value: unknown,
  expectedState: "resolved" | "ignored",
): "applied" | "no_op" | null {
  if (!isRecord(value) || value.ok !== true) return null;
  if (value.outcome === "no_op" && value.idempotent === true) {
    return "no_op";
  }
  return value.outcome === expectedState ? "applied" : null;
}

export function isReconciliationIssueResolutionPostcondition(
  value: unknown,
  expected: {
    issueId: string;
    state: "resolved" | "ignored";
  },
): boolean {
  return (
    isRecord(value) &&
    value.id === expected.issueId &&
    value.state === expected.state &&
    typeof value.resolved_at === "string" &&
    Number.isFinite(Date.parse(value.resolved_at)) &&
    value.resolution_source === "admin"
  );
}
