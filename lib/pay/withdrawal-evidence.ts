import type { CreditProduct } from "@/lib/credit-products";
import type { PayChannelMethod, PayMode } from "@/lib/pay-channels";

export const CHECKOUT_WITHDRAWAL_CONFIRMATION = Object.freeze({
  schemaVersion: 1,
  // v2(2026-08-19): 문구 축약 — §17⑥ 요건(제공 개시 시 청약철회 제한의 사전 고지)은 유지.
  copyVersion: "checkout-withdrawal-limit-2026-08-19-v2",
  statement:
    "이미 사용한 생성권은 디지털콘텐츠 제공이 개시되어 청약철회가 제한돼요.",
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

export type CheckoutRequestBody = Readonly<{
  checkoutRequestId: string;
  productId: string;
  method: PayChannelMethod;
  /**
   * 심사·테스트 계정 전용 실결제 opt-in(`?live=1` 화면의 서버 판정값 전달) —
   * 일반 계정은 서버가 항상 live 로 판정하므로 효력이 없다. 대조 fence 가 아니라
   * reviewer 입력이다.
   */
  reviewerLive: boolean;
  offerEvidenceId: string;
  offerSnapshotSha256: string;
  withdrawalConfirmation: Readonly<{
    confirmed: true;
    copyVersion: string;
    statement: string;
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
      "method",
      "offerEvidenceId",
      "offerSnapshotSha256",
      "productId",
      "reviewerLive",
      "withdrawalConfirmation",
    ]) ||
    typeof value.reviewerLive !== "boolean" ||
    typeof value.checkoutRequestId !== "string" ||
    !UUID_RE.test(value.checkoutRequestId) ||
    typeof value.productId !== "string" ||
    value.productId.length < 1 ||
    value.productId.length > 100 ||
    value.productId !== value.productId.trim() ||
    (value.method !== "card" &&
      value.method !== "tosspay" &&
      value.method !== "kakaopay") ||
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
    // 문구·버전의 정합은 registry(0105)가 단일 검증 — 여기는 형식만 본다.
    typeof value.withdrawalConfirmation.copyVersion !== "string" ||
    value.withdrawalConfirmation.copyVersion.length < 1 ||
    value.withdrawalConfirmation.copyVersion.length > 100 ||
    typeof value.withdrawalConfirmation.statement !== "string" ||
    value.withdrawalConfirmation.statement.length < 1 ||
    value.withdrawalConfirmation.statement.length > 1000
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
