export type GalleryCursor = {
  createdAt: string;
  id: string;
};

export type GalleryDollRow = {
  id: string;
  image_url: string;
  created_at: string;
  role: string;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// PostgreSQL timestamptz JSON output preserves up to microsecond precision.
// Keep the exact value for keyset pagination; Date would truncate it to ms.
const TIMESTAMPTZ_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

export class InvalidGalleryPageError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "InvalidGalleryPageError";
  }
}

function isSafeTimestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    TIMESTAMPTZ_RE.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/** Validate the RLS-backed page before it becomes UI state or a query cursor. */
export function parseGalleryDollRows(value: unknown): GalleryDollRow[] {
  if (!Array.isArray(value)) {
    throw new InvalidGalleryPageError("gallery_rows_missing");
  }
  const seen = new Set<string>();
  return value.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      throw new InvalidGalleryPageError("invalid_gallery_row");
    }
    const row = raw as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !UUID_RE.test(row.id) ||
      seen.has(row.id) ||
      typeof row.image_url !== "string" ||
      row.image_url.length === 0 ||
      row.image_url.length > 2048 ||
      row.image_url !== row.image_url.trim() ||
      !isSafeTimestamp(row.created_at) ||
      typeof row.role !== "string" ||
      row.role.length === 0 ||
      row.role.length > 40 ||
      row.role !== row.role.trim()
    ) {
      throw new InvalidGalleryPageError("invalid_gallery_row");
    }
    seen.add(row.id);
    return {
      id: row.id,
      image_url: row.image_url,
      created_at: row.created_at,
      role: row.role,
    };
  });
}

/**
 * PostgREST OR expression for a strict descending (created_at, id) cursor.
 * Inputs are parser-produced and contain no PostgREST control characters.
 */
export function galleryCursorFilter(cursor: GalleryCursor): string {
  if (!isSafeTimestamp(cursor.createdAt) || !UUID_RE.test(cursor.id)) {
    throw new InvalidGalleryPageError("invalid_gallery_cursor");
  }
  return [
    `created_at.lt.${cursor.createdAt}`,
    `and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`,
  ].join(",");
}

/**
 * Derive continuation from the raw DB page, before a deletion/signing race may
 * remove rendered rows. A full page can have a continuation; a short page is
 * authoritative exhaustion.
 */
export function nextGalleryCursor(
  rawRows: readonly Pick<GalleryDollRow, "id" | "created_at">[],
  pageSize: number,
): GalleryCursor | null {
  if (!Number.isSafeInteger(pageSize) || pageSize <= 0) {
    throw new InvalidGalleryPageError("invalid_gallery_page_size");
  }
  if (rawRows.length < pageSize) return null;
  if (rawRows.length !== pageSize) {
    throw new InvalidGalleryPageError("oversized_gallery_page");
  }
  const last = rawRows.at(-1);
  if (!last || !UUID_RE.test(last.id) || !isSafeTimestamp(last.created_at)) {
    throw new InvalidGalleryPageError("invalid_gallery_cursor_row");
  }
  return { createdAt: last.created_at, id: last.id };
}

/** Defensive state merge: inter-page overlap can never create duplicate cards. */
export function mergeUniqueGalleryRows<T extends { id: string }>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  const merged: T[] = [];
  const seen = new Set<string>();
  for (const row of [...current, ...incoming]) {
    if (!seen.has(row.id)) {
      seen.add(row.id);
      merged.push(row);
    }
  }
  return merged;
}
