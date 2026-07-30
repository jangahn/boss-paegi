import {
  BANNER_SURFACES,
  isEventType,
  type BannerSurface,
  type EventType,
} from "./events/types.ts";
import { readBoundedResponseBytes } from "./http/bounded-response.ts";

export const ACTIVE_EVENTS_MAX_RESPONSE_BYTES = 32 * 1024;
export const ACTIVE_EVENTS_FALLBACK_TTL_MS = 30_000;
export const ACTIVE_EVENTS_MAX_STALE_RESPONSE_ATTEMPTS = 3;

export type ActivePopup = {
  id: string;
  type: EventType;
  title: string;
  summary: string;
  popupDismissDays: number;
};

export type ActiveBanner = {
  id: string;
  type: EventType;
  summary: string;
};

export type ActiveEvents = {
  serverNow: string;
  nextTransitionAt: string | null;
  popup: ActivePopup | null;
  banners: Record<BannerSurface, ActiveBanner | null>;
};

export type FetchedActiveEvents = ActiveEvents & {
  cacheForMs: number;
  cacheUntilMonotonic: number;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EXACT_UTC_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
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

function isText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value === value.trim() &&
    value.length > 0 &&
    value.length <= max
  );
}

function isExactUtcTimestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !EXACT_UTC_TIMESTAMP_RE.test(value)
  ) {
    return false;
  }
  const milliseconds = Date.parse(value);
  return (
    Number.isFinite(milliseconds) &&
    new Date(milliseconds).toISOString() === value
  );
}

function parseBanner(value: unknown): ActiveBanner | null | undefined {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !hasExactKeys(value, ["id", "type", "summary"]) ||
    typeof value.id !== "string" ||
    !UUID_RE.test(value.id) ||
    typeof value.type !== "string" ||
    !isEventType(value.type) ||
    !isText(value.summary, 200)
  ) {
    return undefined;
  }
  return { id: value.id, type: value.type, summary: value.summary };
}

function parsePopup(value: unknown): ActivePopup | null | undefined {
  if (value === null) return null;
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "id",
      "type",
      "title",
      "summary",
      "popupDismissDays",
    ]) ||
    typeof value.id !== "string" ||
    !UUID_RE.test(value.id) ||
    typeof value.type !== "string" ||
    !isEventType(value.type) ||
    !isText(value.title, 200) ||
    !isText(value.summary, 200) ||
    !Number.isSafeInteger(value.popupDismissDays) ||
    (value.popupDismissDays as number) < 1 ||
    (value.popupDismissDays as number) > 365
  ) {
    return undefined;
  }
  return {
    id: value.id,
    type: value.type,
    title: value.title,
    summary: value.summary,
    popupDismissDays: value.popupDismissDays as number,
  };
}

export function parseActiveEventsResponse(
  value: unknown,
): ActiveEvents | null {
  if (
    !isObject(value) ||
    !hasExactKeys(value, [
      "serverNow",
      "nextTransitionAt",
      "popup",
      "banners",
    ]) ||
    !isExactUtcTimestamp(value.serverNow) ||
    !(
      value.nextTransitionAt === null ||
      (
        isExactUtcTimestamp(value.nextTransitionAt) &&
        Date.parse(value.nextTransitionAt) > Date.parse(value.serverNow)
      )
    ) ||
    !isObject(value.banners) ||
    !hasExactKeys(value.banners, BANNER_SURFACES)
  ) {
    return null;
  }
  const popup = parsePopup(value.popup);
  if (popup === undefined) return null;

  const banners = {} as Record<BannerSurface, ActiveBanner | null>;
  for (const surface of BANNER_SURFACES) {
    const banner = parseBanner(value.banners[surface]);
    if (banner === undefined) return null;
    banners[surface] = banner;
  }
  return {
    serverNow: value.serverNow,
    nextTransitionAt: value.nextTransitionAt,
    popup,
    banners,
  };
}

/**
 * Convert the authoritative server interval to a client cache lifetime without
 * trusting the client's wall clock. Subtracting the full observed round trip
 * is conservative: the old snapshot is discarded no later than the server
 * transition even when the response itself was slow. `null` means the
 * transition passed in flight, so callers must not expose that snapshot.
 */
export function activeEventsCacheForMs(
  value: ActiveEvents,
  roundTripMs: number,
): number | null {
  if (!Number.isFinite(roundTripMs) || roundTripMs < 0) {
    throw new Error("invalid_active_events_round_trip");
  }
  if (value.nextTransitionAt === null) {
    return ACTIVE_EVENTS_FALLBACK_TTL_MS;
  }
  const serverInterval =
    Date.parse(value.nextTransitionAt) - Date.parse(value.serverNow);
  const remainingMs = serverInterval - Math.ceil(roundTripMs);
  return remainingMs < 1
    ? null
    : Math.min(
        ACTIVE_EVENTS_FALLBACK_TTL_MS,
        remainingMs,
      );
}

export class ActiveEventsResponseError extends Error {
  readonly kind: "http" | "invalid_response" | "stale_response";
  readonly status: number | undefined;

  constructor(
    kind: "http" | "invalid_response" | "stale_response",
    status?: number,
  ) {
    super(
      kind === "http"
        ? `active_events_http_${status ?? "unknown"}`
        : kind === "stale_response"
          ? "active_events_stale_response"
          : "active_events_invalid_response",
    );
    this.name = "ActiveEventsResponseError";
    this.kind = kind;
    this.status = status;
  }
}

export const activeEventsMonotonicNow = () =>
  typeof performance !== "undefined" &&
  typeof performance.now === "function"
    ? performance.now()
    : Date.now();

export async function fetchActiveEvents(
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  monotonicNow: () => number = activeEventsMonotonicNow,
): Promise<FetchedActiveEvents> {
  for (
    let attempt = 0;
    attempt < ACTIVE_EVENTS_MAX_STALE_RESPONSE_ATTEMPTS;
    attempt += 1
  ) {
    const startedAt = monotonicNow();
    const response = await fetcher("/api/events/active", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!response.ok) {
      throw new ActiveEventsResponseError("http", response.status);
    }
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    if (contentType !== "application/json") {
      throw new ActiveEventsResponseError("invalid_response");
    }
    const bounded = await readBoundedResponseBytes(
      response,
      ACTIVE_EVENTS_MAX_RESPONSE_BYTES,
    );
    if (!bounded.ok) {
      throw new ActiveEventsResponseError("invalid_response");
    }
    const raw = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bounded.bytes),
    ) as unknown;
    const parsed = parseActiveEventsResponse(raw);
    if (!parsed) throw new ActiveEventsResponseError("invalid_response");
    const finishedAt = monotonicNow();
    const roundTripMs = Math.max(0, finishedAt - startedAt);
    const cacheForMs = activeEventsCacheForMs(parsed, roundTripMs);
    if (cacheForMs !== null) {
      return {
        ...parsed,
        cacheForMs,
        // Preserve the deadline calculated at response receipt. Re-basing the
        // duration when an outer promise settles would extend a 1ms boundary.
        cacheUntilMonotonic: finishedAt + cacheForMs,
      };
    }
  }
  throw new ActiveEventsResponseError("stale_response");
}
