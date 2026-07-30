const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type CheckoutHttpResponse = {
  orderUuid: string;
  paymentId: string;
  orderName: string;
  totalAmount: number;
  storeId: string;
  currency: "KRW";
  channelKey: string;
  payMethod: "CARD" | "EASY_PAY";
};

const CONTROL_TEXT_RE = /[\u0000-\u001f\u007f]/;

export function parseCheckoutHttpResponse(
  value: unknown,
): CheckoutHttpResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    typeof row.orderUuid !== "string" ||
    !UUID_RE.test(row.orderUuid) ||
    typeof row.paymentId !== "string" ||
    row.paymentId !== row.orderUuid.replaceAll("-", "") ||
    typeof row.orderName !== "string" ||
    row.orderName !== row.orderName.trim() ||
    row.orderName.length === 0 ||
    row.orderName.length > 200 ||
    CONTROL_TEXT_RE.test(row.orderName) ||
    !Number.isSafeInteger(row.totalAmount) ||
    (row.totalAmount as number) <= 0 ||
    typeof row.storeId !== "string" ||
    row.storeId !== row.storeId.trim() ||
    row.storeId.length === 0 ||
    row.storeId.length > 128 ||
    CONTROL_TEXT_RE.test(row.storeId) ||
    row.currency !== "KRW" ||
    typeof row.channelKey !== "string" ||
    row.channelKey !== row.channelKey.trim() ||
    row.channelKey.length === 0 ||
    row.channelKey.length > 256 ||
    CONTROL_TEXT_RE.test(row.channelKey) ||
    (row.payMethod !== "CARD" && row.payMethod !== "EASY_PAY")
  ) {
    return null;
  }
  return row as CheckoutHttpResponse;
}

export type OrderStatusHttpResponse = {
  /**
   * `paid` means provider-paid + live credits granted. `paid_review` preserves
   * provider-paid truth while explicitly withholding any grant-success claim.
   */
  status: "pending" | "paid" | "paid_review" | "canceled" | "failed";
  credits: number;
  amount: number;
  productId: string;
};

export function parseOrderStatusHttpResponse(
  value: unknown,
): OrderStatusHttpResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    !["pending", "paid", "paid_review", "canceled", "failed"].includes(
      typeof row.status === "string" ? row.status : "",
    ) ||
    !Number.isSafeInteger(row.credits) ||
    (row.credits as number) <= 0 ||
    !Number.isSafeInteger(row.amount) ||
    (row.amount as number) <= 0 ||
    typeof row.productId !== "string" ||
    row.productId !== row.productId.trim() ||
    row.productId.length === 0 ||
    row.productId.length > 100
  ) {
    return null;
  }
  return row as OrderStatusHttpResponse;
}
