import type { PortonePaymentSnapshot } from "@/lib/portone";

export type PortoneOrderEvidence = {
  payment_id: string | null;
  amount: number;
  is_test: boolean;
  expected_store_id: string | null;
  expected_currency: string | null;
  expected_channel_key: string | null;
};

export type PortoneEvidenceMismatch =
  | "payment_id"
  | "amount"
  | "store_id"
  | "currency"
  | "channel_key"
  | "channel_mode";

export type PortoneEvidenceDisposition =
  | { kind: "exact" }
  | { kind: "legacy_deferred" }
  | { kind: "mismatch"; reason: PortoneEvidenceMismatch };

export type PortoneNonMoneyEvidenceDisposition =
  | { kind: "exact" }
  | { kind: "legacy_deferred" }
  | { kind: "incomplete" }
  | { kind: "mismatch"; reason: PortoneEvidenceMismatch };

export type ExactPortoneEvidenceFailure =
  | PortoneEvidenceMismatch
  | "legacy_snapshot";

/**
 * Automatic money mutations require the exact immutable checkout projection.
 * A missing legacy snapshot is deliberately a mismatch: it must be reconciled
 * manually instead of being inferred from mutable deployment environment.
 */
export function portoneEvidenceMismatch(
  snapshot: PortonePaymentSnapshot,
  order: PortoneOrderEvidence,
): PortoneEvidenceMismatch | null {
  if (
    typeof order.payment_id !== "string" ||
    snapshot.paymentId !== order.payment_id
  ) {
    return "payment_id";
  }
  if (snapshot.totalAmount !== order.amount) return "amount";
  if (
    typeof order.expected_store_id !== "string" ||
    snapshot.storeId !== order.expected_store_id
  ) {
    return "store_id";
  }
  if (
    typeof order.expected_currency !== "string" ||
    snapshot.currency !== order.expected_currency
  ) {
    return "currency";
  }
  if (
    typeof order.expected_channel_key !== "string" ||
    snapshot.channelKey !== order.expected_channel_key
  ) {
    return "channel_key";
  }
  if (snapshot.channelType !== (order.is_test ? "TEST" : "LIVE")) {
    return "channel_mode";
  }
  return null;
}

/**
 * Rolling-deploy classifier.
 *
 * Orders created by the old checkout RPC have all three immutable checkout
 * evidence columns NULL. During the bounded 0087 expand window this
 * classifier distinguishes that backlog from an active mismatch so callers
 * can retry after backfill. `legacy_deferred` never authorizes a money grant:
 * every grant boundary must return incomplete before invoking its RPC. We
 * still prove payment id, amount, KRW, and exact TEST/LIVE mode here so the
 * deferred state itself cannot hide a cross-payment or cross-mode collision.
 * A partial snapshot is never legacy-compatible.
 *
 * 0092 refuses to apply while any unpaid legacy order remains and disables
 * the database flag, so the deferred backlog cannot enter the contract stage.
 */
export function classifyPortoneEvidenceForRollout(
  snapshot: PortonePaymentSnapshot,
  order: PortoneOrderEvidence,
): PortoneEvidenceDisposition {
  if (
    typeof order.payment_id !== "string" ||
    snapshot.paymentId !== order.payment_id
  ) {
    return { kind: "mismatch", reason: "payment_id" };
  }
  if (snapshot.totalAmount !== order.amount) {
    return { kind: "mismatch", reason: "amount" };
  }
  if (snapshot.currency !== "KRW") {
    return { kind: "mismatch", reason: "currency" };
  }
  if (snapshot.channelType !== (order.is_test ? "TEST" : "LIVE")) {
    return { kind: "mismatch", reason: "channel_mode" };
  }

  const legacySnapshotMissing =
    order.expected_store_id === null &&
    order.expected_currency === null &&
    order.expected_channel_key === null;
  if (legacySnapshotMissing) {
    return { kind: "legacy_deferred" };
  }

  const mismatch = portoneEvidenceMismatch(snapshot, order);
  return mismatch
    ? { kind: "mismatch", reason: mismatch }
    : { kind: "exact" };
}

/**
 * Refund and cancellation mutations never need the rolling checkout grant
 * exception. They must wait until the one-time legacy evidence backfill has
 * completed, because a wrong provider object must not create cancellation
 * observations, debit credits, or issue an external refund.
 */
export function exactPortoneEvidenceFailure(
  snapshot: PortonePaymentSnapshot,
  order: PortoneOrderEvidence,
): ExactPortoneEvidenceFailure | null {
  const disposition = classifyPortoneEvidenceForRollout(snapshot, order);
  if (disposition.kind === "exact") return null;
  return disposition.kind === "legacy_deferred"
    ? "legacy_snapshot"
    : disposition.reason;
}

/**
 * FAILED and stale non-terminal transitions do not move money, but they still
 * must not attach a payment from another PortOne store to this order.
 *
 * PortOne may omit `channel` when a request fails before channel selection, so
 * channel fields are checked whenever present rather than required. The
 * provider/store/currency/amount identity is always required. Legacy rows stay
 * unchanged until the one-time provider backfill freezes their tuple.
 */
export function classifyPortoneNonMoneyEvidence(
  snapshot: PortonePaymentSnapshot,
  order: PortoneOrderEvidence,
): PortoneNonMoneyEvidenceDisposition {
  if (
    typeof order.payment_id !== "string" ||
    snapshot.paymentId !== order.payment_id
  ) {
    return { kind: "mismatch", reason: "payment_id" };
  }
  if (
    snapshot.totalAmount === null ||
    snapshot.storeId === null ||
    snapshot.currency === null
  ) {
    return { kind: "incomplete" };
  }
  if (snapshot.totalAmount !== order.amount) {
    return { kind: "mismatch", reason: "amount" };
  }

  const allLegacy =
    order.expected_store_id === null &&
    order.expected_currency === null &&
    order.expected_channel_key === null;
  if (allLegacy) return { kind: "legacy_deferred" };

  if (order.expected_store_id === null) {
    return { kind: "mismatch", reason: "store_id" };
  }
  if (order.expected_currency === null) {
    return { kind: "mismatch", reason: "currency" };
  }
  if (order.expected_channel_key === null) {
    return { kind: "mismatch", reason: "channel_key" };
  }
  if (snapshot.storeId !== order.expected_store_id) {
    return { kind: "mismatch", reason: "store_id" };
  }
  if (snapshot.currency !== order.expected_currency) {
    return { kind: "mismatch", reason: "currency" };
  }
  if (
    snapshot.channelKey !== null &&
    snapshot.channelKey !== order.expected_channel_key
  ) {
    return { kind: "mismatch", reason: "channel_key" };
  }
  if (
    snapshot.channelType !== null &&
    snapshot.channelType !== (order.is_test ? "TEST" : "LIVE")
  ) {
    return { kind: "mismatch", reason: "channel_mode" };
  }
  return { kind: "exact" };
}
