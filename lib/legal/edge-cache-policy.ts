import { kstDateAt } from "./kst-boundary.ts";

export type LegalEdgeCacheIdentity = Readonly<{
  kstDate: string;
  expiresAt: number;
}>;

const DEFAULT_TTL_MS = 60_000;

function nextCivilDate(civilDate: string): string {
  const [year, month, day] = civilDate.split("-").map(Number);
  const next = new Date(Date.UTC(year, month - 1, day + 1));
  return [
    next.getUTCFullYear().toString().padStart(4, "0"),
    (next.getUTCMonth() + 1).toString().padStart(2, "0"),
    next.getUTCDate().toString().padStart(2, "0"),
  ].join("-");
}

/**
 * Edge-cache entries can never survive the automatic KST effective-date
 * boundary. The civil date is part of the identity and expiry is capped at
 * the next KST midnight even when the ordinary TTL would end later.
 */
export function legalEdgeCacheIdentityAt(
  instant: Date | number | string = new Date(),
  ttlMs = DEFAULT_TTL_MS,
): LegalEdgeCacheIdentity {
  const now = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(now) || !Number.isSafeInteger(ttlMs) || ttlMs < 1) {
    throw new RangeError("invalid_legal_edge_cache_input");
  }
  const kstDate = kstDateAt(now);
  const nextMidnight = Date.parse(`${nextCivilDate(kstDate)}T00:00:00+09:00`);
  return {
    kstDate,
    expiresAt: Math.min(now + ttlMs, nextMidnight),
  };
}

export function legalEdgeCacheUsable(
  cache: LegalEdgeCacheIdentity | null,
  instant: Date | number | string = new Date(),
): boolean {
  if (!cache) return false;
  const now = instant instanceof Date ? instant.getTime() : new Date(instant).getTime();
  if (!Number.isFinite(now)) return false;
  return cache.kstDate === kstDateAt(now) && now < cache.expiresAt;
}
