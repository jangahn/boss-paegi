import type { CreditProduct } from "@/lib/credit-products";
import type { PayChannelMethod, PayMode } from "@/lib/pay-channels";

export const CHECKOUT_WITHDRAWAL_CONFIRMATION = Object.freeze({
  schemaVersion: 1,
  copyVersion: "checkout-withdrawal-limit-2026-07-30-v1",
  statement:
    "구매할 생성권 중 이미 사용한 생성권은 디지털콘텐츠 제공이 개시된 것으로 청약철회가 제한된다는 점을 확인합니다.",
});

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ISO_INSTANT_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    keys.length === wanted.length &&
    keys.every((key, index) => key === wanted[index])
  );
}

function isCreditProduct(value: unknown): value is CreditProduct {
  if (!isRecord(value)) return false;
  return (
    hasExactKeys(value, ["credits", "goodname", "price", "productId"]) &&
    typeof value.productId === "string" &&
    value.productId.length >= 1 &&
    value.productId.length <= 100 &&
    value.productId === value.productId.trim() &&
    typeof value.goodname === "string" &&
    value.goodname.length >= 1 &&
    value.goodname.length <= 200 &&
    value.goodname === value.goodname.trim() &&
    Number.isSafeInteger(value.price) &&
    (value.price as number) > 0 &&
    Number.isSafeInteger(value.credits) &&
    (value.credits as number) > 0
  );
}

export type CheckoutRequestBody = Readonly<{
  checkoutRequestId: string;
  productId: string;
  method: PayChannelMethod;
  expectedMode: PayMode;
  expectedProduct: CreditProduct;
  offerEvidenceId: string;
  offerSnapshotSha256: string;
  withdrawalConfirmation: Readonly<{
    confirmed: true;
    copyVersion: typeof CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion;
    statement: typeof CHECKOUT_WITHDRAWAL_CONFIRMATION.statement;
  }>;
}>;

/**
 * Checkout is a money/consent boundary. Reject unknown keys as well as wrong
 * types so an old or widened client cannot silently omit or reinterpret the
 * separated withdrawal-limit acknowledgement.
 */
export function parseCheckoutRequestBody(
  value: unknown,
): CheckoutRequestBody | null {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "checkoutRequestId",
      "expectedMode",
      "expectedProduct",
      "method",
      "offerEvidenceId",
      "offerSnapshotSha256",
      "productId",
      "withdrawalConfirmation",
    ]) ||
    typeof value.checkoutRequestId !== "string" ||
    !UUID_RE.test(value.checkoutRequestId) ||
    typeof value.productId !== "string" ||
    value.productId.length < 1 ||
    value.productId.length > 100 ||
    value.productId !== value.productId.trim() ||
    (value.method !== "card" &&
      value.method !== "tosspay" &&
      value.method !== "kakaopay") ||
    (value.expectedMode !== "test" && value.expectedMode !== "live") ||
    !isCreditProduct(value.expectedProduct) ||
    typeof value.offerEvidenceId !== "string" ||
    !UUID_RE.test(value.offerEvidenceId) ||
    typeof value.offerSnapshotSha256 !== "string" ||
    !SHA256_RE.test(value.offerSnapshotSha256) ||
    !isRecord(value.withdrawalConfirmation) ||
    !hasExactKeys(value.withdrawalConfirmation, [
      "confirmed",
      "copyVersion",
      "statement",
    ]) ||
    value.withdrawalConfirmation.confirmed !== true ||
    value.withdrawalConfirmation.copyVersion !==
      CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion ||
    value.withdrawalConfirmation.statement !==
      CHECKOUT_WITHDRAWAL_CONFIRMATION.statement
  ) {
    return null;
  }
  return value as CheckoutRequestBody;
}

export type CheckoutWithdrawalEvidenceExpectation = Readonly<{
  evidenceId?: string;
  requestId: string;
  orderUuid: string;
  userId: string;
  product: CreditProduct;
  payMode: PayMode;
  payChannel: PayChannelMethod;
  offerEvidenceId: string;
  offerSnapshotSha256: string;
}>;

/** Exact persisted evidence postcondition checked before exposing PG secrets. */
export function matchesCheckoutWithdrawalEvidence(
  value: unknown,
  expected: CheckoutWithdrawalEvidenceExpectation,
): boolean {
  if (!isRecord(value)) return false;
  const acceptedAt =
    typeof value.accepted_at === "string" ? value.accepted_at : "";
  return (
    (expected.evidenceId === undefined ||
      value.id === expected.evidenceId) &&
    typeof value.id === "string" &&
    UUID_RE.test(value.id) &&
    value.request_id === expected.requestId &&
    value.order_uuid === expected.orderUuid &&
    value.user_id === expected.userId &&
    value.product_id === expected.product.productId &&
    value.product_name === expected.product.goodname &&
    value.amount === expected.product.price &&
    value.credits === expected.product.credits &&
    value.pay_mode === expected.payMode &&
    value.pay_channel === expected.payChannel &&
    value.offer_evidence_id === expected.offerEvidenceId &&
    value.offer_snapshot_sha256 === expected.offerSnapshotSha256 &&
    value.copy_version === CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion &&
    value.confirmation_copy ===
      CHECKOUT_WITHDRAWAL_CONFIRMATION.statement &&
    value.confirmed === true &&
    ISO_INSTANT_RE.test(acceptedAt) &&
    Number.isFinite(Date.parse(acceptedAt))
  );
}
