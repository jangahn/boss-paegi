const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAYMENT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_WIRE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export type AtomicCheckoutExpectation = {
  candidateOrderUuid: string;
  userId: string;
  productId: string;
  amount: number;
  credits: number;
  isTest: boolean;
  payChannel: string;
  expectedStoreId: string;
  expectedCurrency: string;
  expectedChannelKey: string;
  checkoutRequestId: string;
  productName: string;
  payMode: "test" | "live";
  offerEvidenceId: string;
  offerSnapshotSha256: string;
  withdrawalCopyVersion: string;
  withdrawalCopy: string;
};

export type AtomicCheckoutReceipt = {
  orderUuid: string;
  paymentId: string;
  amount: number;
  credits: number;
  status: "pending" | "failed";
  reused: boolean;
  expectedStoreId: string;
  expectedCurrency: "KRW";
  expectedChannelKey: string;
  withdrawalEvidenceId: string;
  checkoutRequestId: string;
  withdrawalAcceptedAt: string;
};

function safeWireText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    SAFE_WIRE_TEXT_RE.test(value)
  );
}

/**
 * The atomic RPC may return either the caller's candidate or a recent durable
 * order. A fresh order must freeze exactly the current server configuration.
 * A reused order—or an exact same-candidate transport replay—keeps its
 * already-immutable prior price, credits, and provider configuration. This is
 * deliberate: once any browser has received a charge-capable payment id, a
 * newer config must not mint a second one while the first can still become
 * PAID. Failed PortOne attempts are retryable with the same id, so a reused
 * receipt may remain `failed`. Every outcome still requires a complete
 * bounded snapshot and the exact orderUuid→paymentId derivation.
 */
export function parseAtomicCheckoutReceipt(
  value: unknown,
  expected: AtomicCheckoutExpectation,
): AtomicCheckoutReceipt | null {
  if (
    !isRecord(value) ||
    value.ok !== true ||
    (value.outcome !== "ready" &&
      value.outcome !== "reused" &&
      value.outcome !== "replayed") ||
    typeof value.order_uuid !== "string" ||
    !UUID_RE.test(value.order_uuid) ||
    typeof value.payment_id !== "string" ||
    !PAYMENT_ID_RE.test(value.payment_id) ||
    value.payment_id !== value.order_uuid.replaceAll("-", "") ||
    value.user_id !== expected.userId ||
    value.product_id !== expected.productId ||
    typeof value.amount !== "number" ||
    !Number.isSafeInteger(value.amount) ||
    value.amount <= 0 ||
    typeof value.credits !== "number" ||
    !Number.isSafeInteger(value.credits) ||
    value.credits <= 0 ||
    (value.status !== "pending" && value.status !== "failed") ||
    value.provider !== "portone" ||
    value.is_test !== expected.isTest ||
    value.pay_channel !== expected.payChannel ||
    !safeWireText(value.expected_store_id, 128) ||
    value.expected_currency !== "KRW" ||
    !safeWireText(value.expected_channel_key, 256) ||
    typeof value.withdrawal_evidence_id !== "string" ||
    !UUID_RE.test(value.withdrawal_evidence_id) ||
    value.checkout_request_id !== expected.checkoutRequestId ||
    value.withdrawal_product_name !== expected.productName ||
    value.withdrawal_pay_mode !== expected.payMode ||
    value.withdrawal_offer_evidence_id !== expected.offerEvidenceId ||
    value.withdrawal_offer_snapshot_sha256 !==
      expected.offerSnapshotSha256 ||
    value.withdrawal_copy_version !== expected.withdrawalCopyVersion ||
    value.withdrawal_confirmation_copy !== expected.withdrawalCopy ||
    value.withdrawal_confirmed !== true ||
    typeof value.withdrawal_accepted_at !== "string" ||
    !Number.isFinite(Date.parse(value.withdrawal_accepted_at)) ||
    value.paid_at !== null ||
    value.canceled_at !== null ||
    (value.outcome === "ready" &&
      (value.order_uuid !== expected.candidateOrderUuid ||
        value.amount !== expected.amount ||
        value.credits !== expected.credits ||
        value.status !== "pending" ||
        value.expected_store_id !== expected.expectedStoreId ||
        value.expected_currency !== expected.expectedCurrency ||
        value.expected_channel_key !== expected.expectedChannelKey)) ||
    (value.outcome === "reused" &&
      value.order_uuid === expected.candidateOrderUuid) ||
    (value.outcome === "replayed" &&
      value.order_uuid !== expected.candidateOrderUuid)
  ) {
    return null;
  }
  return {
    orderUuid: value.order_uuid,
    paymentId: value.payment_id,
    amount: value.amount,
    credits: value.credits,
    status: value.status,
    reused: value.outcome !== "ready",
    expectedStoreId: value.expected_store_id,
    expectedCurrency: value.expected_currency,
    expectedChannelKey: value.expected_channel_key,
    withdrawalEvidenceId: value.withdrawal_evidence_id,
    checkoutRequestId: value.checkout_request_id,
    withdrawalAcceptedAt: value.withdrawal_accepted_at,
  };
}

export type CheckoutOrderExpectation = {
  orderUuid: string;
  userId: string;
  productId: string;
  amount: number;
  credits: number;
  paymentId: string;
  isTest: boolean;
  payChannel: string;
  expectedStoreId: string;
  expectedCurrency: string;
  expectedChannelKey: string;
  status: "pending" | "failed";
};

/** Full durable order evidence required before returning real PG parameters. */
export function matchesCheckoutOrderPostcondition(
  value: unknown,
  expected: CheckoutOrderExpectation,
): boolean {
  return (
    isRecord(value) &&
    value.order_uuid === expected.orderUuid &&
    value.user_id === expected.userId &&
    value.product_id === expected.productId &&
    value.amount === expected.amount &&
    value.credits === expected.credits &&
    value.status === expected.status &&
    value.provider === "portone" &&
    value.payment_id === expected.paymentId &&
    value.is_test === expected.isTest &&
    value.pay_channel === expected.payChannel &&
    value.expected_store_id === expected.expectedStoreId &&
    value.expected_currency === expected.expectedCurrency &&
    value.expected_channel_key === expected.expectedChannelKey &&
    value.paid_at === null &&
    value.canceled_at === null
  );
}
