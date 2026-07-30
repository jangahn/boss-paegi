export type ChronologicalCursor = {
  createdAt: string;
  id: string;
};

type ChronologicalRow = {
  created_at: string;
  id: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_TIMESTAMP_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(?:Z|([+-])(\d{2}):(\d{2}))$/;

function timestampMicros(value: string): bigint {
  const match = SAFE_TIMESTAMP_RE.exec(value);
  if (!match) throw new Error("invalid_chronological_cursor");

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const fraction = (match[7] ?? "").padEnd(6, "0");
  const millisecond = Number(fraction.slice(0, 3));
  const trailingMicros = BigInt(fraction.slice(3) || "0");
  const offsetHour = Number(match[9] ?? "0");
  const offsetMinute = Number(match[10] ?? "0");

  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    throw new Error("invalid_chronological_cursor");
  }

  // setUTCFullYear avoids Date.UTC's special 1900-based interpretation for
  // years 0000..0099. Round-trip the local clock before applying its offset so
  // normalized dates such as February 30 never enter a raw PostgREST filter.
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, millisecond);
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second ||
    local.getUTCMilliseconds() !== millisecond
  ) {
    throw new Error("invalid_chronological_cursor");
  }

  const offsetDirection = match[8] === "-" ? -1 : 1;
  const offsetMillis =
    offsetDirection * (offsetHour * 60 + offsetMinute) * 60_000;
  return (
    BigInt(local.getTime() - offsetMillis) * BigInt(1_000) + trailingMicros
  );
}

function assertCursor(cursor: ChronologicalCursor): void {
  if (!UUID_RE.test(cursor.id)) {
    throw new Error("invalid_chronological_cursor");
  }
  timestampMicros(cursor.createdAt);
}

export function compareChronologicalKey(
  left: ChronologicalCursor,
  right: ChronologicalCursor,
): number {
  if (!UUID_RE.test(left.id) || !UUID_RE.test(right.id)) {
    throw new Error("invalid_chronological_cursor");
  }
  const leftMicros = timestampMicros(left.createdAt);
  const rightMicros = timestampMicros(right.createdAt);
  if (leftMicros !== rightMicros) return leftMicros < rightMicros ? -1 : 1;
  if (left.id === right.id) return 0;
  return left.id < right.id ? -1 : 1;
}

/**
 * PostgREST keyset predicate for an ascending `(created_at, id)` ordering.
 * Both values are validated before interpolation; callers never pass user
 * input into the raw `.or(...)` filter.
 */
export function chronologicalKeysetFilter(
  cursor: ChronologicalCursor,
): string {
  assertCursor(cursor);
  return [
    `created_at.gt.${cursor.createdAt}`,
    `and(created_at.eq.${cursor.createdAt},id.gt.${cursor.id})`,
  ].join(",");
}

/**
 * Validate that an authoritative page is strictly ordered and advances the
 * previous cursor. A repeated/malformed page fails instead of looping or
 * silently skipping work.
 */
export function advanceChronologicalCursor(
  page: readonly ChronologicalRow[],
  previous: ChronologicalCursor | null,
): ChronologicalCursor | null {
  if (page.length === 0) return null;
  let prior = previous;
  for (const row of page) {
    const next = { createdAt: row.created_at, id: row.id };
    assertCursor(next);
    if (prior && compareChronologicalKey(next, prior) <= 0) {
      throw new Error("non_advancing_chronological_page");
    }
    prior = next;
  }
  return prior;
}

export function isAfterChronologicalCursor(
  row: ChronologicalRow,
  cursor: ChronologicalCursor,
): boolean {
  return (
    compareChronologicalKey(
      { createdAt: row.created_at, id: row.id },
      cursor,
    ) > 0
  );
}
