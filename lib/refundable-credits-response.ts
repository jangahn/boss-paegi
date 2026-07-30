export class InvalidRefundableCreditsResponseError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidRefundableCreditsResponseError";
  }
}

export function parseRefundableCreditsResponse(value: unknown): {
  refundable: number;
  asOf: string;
} {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidRefundableCreditsResponseError("invalid_response");
  }
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true ||
    !Number.isSafeInteger(row.refundable) ||
    (row.refundable as number) < 0 ||
    typeof row.asOf !== "string" ||
    !Number.isFinite(Date.parse(row.asOf))
  ) {
    throw new InvalidRefundableCreditsResponseError("invalid_response");
  }
  return {
    refundable: row.refundable as number,
    asOf: row.asOf,
  };
}
