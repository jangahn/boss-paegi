import { SupabaseOperationError } from "./supabase-operation.ts";

export type AdminFieldRule =
  | "text"
  | "string"
  | "nullableText"
  | "nullableString"
  | "uuid"
  | "nullableUuid"
  | "date"
  | "nullableDate"
  | "timestamp"
  | "nullableTimestamp"
  | "boolean"
  | "nullableBoolean"
  | "safeInteger"
  | "nullableSafeInteger"
  | "nonnegativeInteger"
  | "nullableNonnegativeInteger"
  | "numeric"
  | "nullableNumeric"
  | "nonnegativeNumeric"
  | "nullableNonnegativeNumeric"
  | "array"
  | "nullableArray"
  | "jsonObject"
  | "nullableJsonObject"
  | "embed";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function malformed(operation: string, reason: string): never {
  throw new SupabaseOperationError(operation, new Error(reason));
}

function numeric(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (
    typeof value === "string" &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/.test(value)
  ) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function validCalendarDateParts(
  year: number,
  month: number,
  day: number,
): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day <= days[month - 1]!;
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_RE.exec(value);
  return (
    match !== null &&
    validCalendarDateParts(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    )
  );
}

function validTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP_RE.exec(value);
  if (!match) return false;
  const offsetHour = match[8] === undefined ? 0 : Number(match[8]);
  const offsetMinute = match[9] === undefined ? 0 : Number(match[9]);
  return (
    validCalendarDateParts(
      Number(match[1]),
      Number(match[2]),
      Number(match[3]),
    ) &&
    Number(match[4]) <= 23 &&
    Number(match[5]) <= 59 &&
    Number(match[6]) <= 59 &&
    offsetHour <= 23 &&
    offsetMinute <= 59 &&
    Number.isFinite(Date.parse(value))
  );
}

function validField(value: unknown, rule: AdminFieldRule): boolean {
  switch (rule) {
    case "text":
      return typeof value === "string";
    case "string":
      return typeof value === "string" && value.length > 0;
    case "nullableText":
      return value === null || typeof value === "string";
    case "nullableString":
      return value === null || (typeof value === "string" && value.length > 0);
    case "uuid":
      return typeof value === "string" && UUID_RE.test(value);
    case "nullableUuid":
      return value === null || (typeof value === "string" && UUID_RE.test(value));
    case "date":
      return validDate(value);
    case "nullableDate":
      return value === null || validDate(value);
    case "timestamp":
      return validTimestamp(value);
    case "nullableTimestamp":
      return value === null || validTimestamp(value);
    case "boolean":
      return typeof value === "boolean";
    case "nullableBoolean":
      return value === null || typeof value === "boolean";
    case "safeInteger":
      return Number.isSafeInteger(value);
    case "nullableSafeInteger":
      return value === null || Number.isSafeInteger(value);
    case "nonnegativeInteger":
      return Number.isSafeInteger(value) && (value as number) >= 0;
    case "nullableNonnegativeInteger":
      return (
        value === null ||
        (Number.isSafeInteger(value) && (value as number) >= 0)
      );
    case "numeric":
      return numeric(value) !== null;
    case "nullableNumeric":
      return value === null || numeric(value) !== null;
    case "nonnegativeNumeric": {
      const parsed = numeric(value);
      return parsed !== null && parsed >= 0;
    }
    case "nullableNonnegativeNumeric": {
      if (value === null) return true;
      const parsed = numeric(value);
      return parsed !== null && parsed >= 0;
    }
    case "array":
      return Array.isArray(value);
    case "nullableArray":
      return value === null || Array.isArray(value);
    case "jsonObject":
      return !!value && typeof value === "object" && !Array.isArray(value);
    case "nullableJsonObject":
      return (
        value === null ||
        (!!value && typeof value === "object" && !Array.isArray(value))
      );
    case "embed":
      return (
        value === null ||
        (!!value && typeof value === "object" && !Array.isArray(value)) ||
        (Array.isArray(value) &&
          value.length <= 1 &&
          value.every(
            (entry) =>
              !!entry && typeof entry === "object" && !Array.isArray(entry),
          ))
      );
  }
}

/**
 * Runtime row-shape contract for admin authority reads. Extra selected columns
 * are allowed, but every declared field must exist with its exact primitive
 * kind; null/type confusion never becomes a zero/empty dashboard value.
 */
export function validateAdminRows<T>(
  operation: string,
  value: unknown,
  schema: Readonly<Record<string, AdminFieldRule>>,
): T[] {
  if (!Array.isArray(value)) malformed(operation, "row_array_missing");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      malformed(operation, `invalid_row:${index}`);
    }
    const row = entry as Record<string, unknown>;
    for (const [field, rule] of Object.entries(schema)) {
      if (!validField(row[field], rule)) {
        malformed(operation, `invalid_field:${index}:${field}`);
      }
    }
    return entry as T;
  });
}

export function parseAdminRpcPage<T>(
  operation: string,
  value: unknown,
  rowSchema: Readonly<Record<string, AdminFieldRule>>,
): { rows: T[]; total: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    malformed(operation, "invalid_page");
  }
  const page = value as Record<string, unknown>;
  if (!Number.isSafeInteger(page.total) || (page.total as number) < 0) {
    malformed(operation, "invalid_total");
  }
  const rows = validateAdminRows<T>(operation, page.rows, rowSchema);
  if ((page.total as number) < rows.length) {
    malformed(operation, "invalid_total");
  }
  return {
    rows,
    total: page.total as number,
  };
}

/** Window-count RPC rows must all agree on one finite nonnegative total. */
export function parseAdminWindowTotal(
  operation: string,
  rows: readonly Record<string, unknown>[],
  field = "total_count",
): number {
  if (rows.length === 0) return 0;
  let expected: number | null = null;
  for (const row of rows) {
    const parsed = numeric(row[field]);
    if (
      parsed === null ||
      !Number.isSafeInteger(parsed) ||
      parsed < 0 ||
      (expected !== null && parsed !== expected)
    ) {
      malformed(operation, "invalid_window_total");
    }
    expected = parsed;
  }
  if (expected === null || expected < rows.length) {
    malformed(operation, "invalid_window_total");
  }
  return expected;
}

/** A same-table enrichment query must acknowledge every requested unique id. */
export function requireExactAdminIdCoverage(
  operation: string,
  expectedIds: readonly string[],
  actualIds: readonly string[],
): void {
  const expected = new Set(expectedIds);
  const actual = new Set(actualIds);
  if (
    expected.size !== expectedIds.length ||
    actual.size !== actualIds.length ||
    expected.size !== actual.size ||
    [...expected].some((id) => !actual.has(id))
  ) {
    malformed(operation, "incomplete_id_coverage");
  }
}
