import { SupabaseOperationError } from "../supabase-operation.ts";

export type OrderHistoryRow = {
  order_uuid: string;
  product_id: string;
  amount: number;
  credits: number;
  status: string;
  paid_at: string;
  error_message: string | null;
  refunded_credits: number;
  refunded_amount: number;
  receipt_url: string | null;
  created_at: string;
  pay_channel: string | null;
  is_test: boolean;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDER_STATUSES = new Set(["pending", "paid", "canceled", "failed"]);

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Number.isFinite(Date.parse(value))
  );
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048) return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function resolveOrderHistoryRead(result: {
  data: unknown;
  error?: unknown;
}): OrderHistoryRow[] {
  if (result.error !== null && result.error !== undefined) {
    throw new SupabaseOperationError("payments.orders", result.error);
  }
  if (!Array.isArray(result.data)) {
    throw new SupabaseOperationError(
      "payments.orders",
      new Error("order_rows_missing"),
    );
  }
  const seenOrderIds = new Set<string>();
  return result.data.map((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new SupabaseOperationError(
        "payments.orders",
        new Error("invalid_order_row"),
      );
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.order_uuid !== "string" ||
      !UUID_RE.test(row.order_uuid) ||
      seenOrderIds.has(row.order_uuid) ||
      typeof row.product_id !== "string" ||
      row.product_id.length === 0 ||
      !isNonNegativeInteger(row.amount) ||
      !isNonNegativeInteger(row.credits) ||
      typeof row.status !== "string" ||
      !ORDER_STATUSES.has(row.status) ||
      !isTimestamp(row.paid_at) ||
      (row.error_message !== null &&
        (typeof row.error_message !== "string" ||
          row.error_message.length === 0 ||
          row.error_message.length > 500)) ||
      !isNonNegativeInteger(row.refunded_credits) ||
      !isNonNegativeInteger(row.refunded_amount) ||
      row.refunded_credits > row.credits ||
      row.refunded_amount > row.amount ||
      (row.receipt_url !== null &&
        !isHttpsUrl(row.receipt_url)) ||
      !isTimestamp(row.created_at) ||
      (row.pay_channel !== null &&
        typeof row.pay_channel !== "string") ||
      typeof row.is_test !== "boolean"
    ) {
      throw new SupabaseOperationError(
        "payments.orders",
        new Error("invalid_order_row"),
      );
    }
    seenOrderIds.add(row.order_uuid);
    return row as OrderHistoryRow;
  });
}
