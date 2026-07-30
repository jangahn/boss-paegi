const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const SAFE_TEXT_RE = /^[^\u0000-\u001f\u007f]+$/;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function safeText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    value === value.trim() &&
    SAFE_TEXT_RE.test(value)
  );
}

function timestamp(value: unknown, required: true): string | undefined;
function timestamp(
  value: unknown,
  required: false,
): string | null | undefined;
function timestamp(
  value: unknown,
  required: boolean,
): string | null | undefined {
  if (value === undefined || value === null) {
    return required ? undefined : null;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const match = TIMESTAMP_RE.exec(value);
  if (!match) return undefined;
  const [, yearRaw, monthRaw, dayRaw, hourRaw, minuteRaw, secondRaw, , offsetHourRaw, offsetMinuteRaw] =
    match;
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const day = Number(dayRaw);
  const hour = Number(hourRaw);
  const minute = Number(minuteRaw);
  const second = Number(secondRaw);
  const offsetHour = offsetHourRaw === undefined ? 0 : Number(offsetHourRaw);
  const offsetMinute =
    offsetMinuteRaw === undefined ? 0 : Number(offsetMinuteRaw);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    calendar.getUTCFullYear() !== year ||
    calendar.getUTCMonth() !== month - 1 ||
    calendar.getUTCDate() !== day ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59 ||
    !Number.isFinite(Date.parse(value))
  ) {
    return undefined;
  }
  return value;
}

function optionalReceiptUrl(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username !== "" ||
      url.password !== ""
    ) {
      return undefined;
    }
    return value;
  } catch {
    return undefined;
  }
}

export type PortoneCancelWireReceipt = {
  id: string;
  status: "REQUESTED" | "SUCCEEDED" | "FAILED";
  totalAmount: number;
  reason: string;
  requestedAt: string;
  cancelledAt: string | null;
  receiptUrl: string | null;
};

export type PortoneAcceptedCancelWireReceipt =
  PortoneCancelWireReceipt & {
    status: "REQUESTED" | "SUCCEEDED";
  };

export type PortoneFailedCancelWireReceipt =
  PortoneCancelWireReceipt & {
    status: "FAILED";
  };

export type PortoneCancelWireOutcome =
  | { kind: "accepted"; cancellation: PortoneAcceptedCancelWireReceipt }
  | { kind: "failed"; cancellation: PortoneFailedCancelWireReceipt }
  | { kind: "uncertain" };

/**
 * Strictly correlate a 2xx cancel response with the persisted request.
 * Unknown/malformed 2xx is uncertain: the PG may have moved money.
 */
export function classifyPortoneCancelResponse(
  value: unknown,
  expected: { amount: number; reason: string },
): PortoneCancelWireOutcome {
  const root = record(value);
  if (!root || !hasExactKeys(root, ["cancellation"])) {
    return { kind: "uncertain" };
  }
  const row = record(root.cancellation);
  if (
    !row ||
    (row.status !== "REQUESTED" &&
      row.status !== "SUCCEEDED" &&
      row.status !== "FAILED") ||
    !safeText(row.id, 256) ||
    !Number.isSafeInteger(row.totalAmount) ||
    row.totalAmount !== expected.amount ||
    !Number.isSafeInteger(row.taxFreeAmount) ||
    (row.taxFreeAmount as number) < 0 ||
    !Number.isSafeInteger(row.vatAmount) ||
    (row.vatAmount as number) < 0 ||
    row.reason !== expected.reason
  ) {
    return { kind: "uncertain" };
  }
  const requestedAt = timestamp(row.requestedAt, true);
  const cancelledAt = timestamp(row.cancelledAt, false);
  const receiptUrl = optionalReceiptUrl(row.receiptUrl);
  if (
    requestedAt === undefined ||
    cancelledAt === undefined ||
    receiptUrl === undefined
  ) {
    return { kind: "uncertain" };
  }
  const cancellation: PortoneCancelWireReceipt = {
    id: row.id,
    status: row.status,
    totalAmount: row.totalAmount as number,
    reason: expected.reason,
    requestedAt,
    cancelledAt,
    receiptUrl,
  };
  return row.status === "FAILED"
    ? {
        kind: "failed",
        cancellation: cancellation as PortoneFailedCancelWireReceipt,
      }
    : {
        kind: "accepted",
        cancellation: cancellation as PortoneAcceptedCancelWireReceipt,
      };
}
