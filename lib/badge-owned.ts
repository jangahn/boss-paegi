import { SupabaseOperationError } from "./supabase-operation.ts";
import { parsePlayTotals, type PlayTotals } from "./play-totals.ts";

export function resolveOwnedBadgeRead(result: {
  data: unknown;
  error?: unknown;
}): Set<string> {
  if (result.error !== null && result.error !== undefined) {
    throw new SupabaseOperationError("badges.owned", result.error);
  }
  if (!Array.isArray(result.data)) {
    throw new SupabaseOperationError(
      "badges.owned",
      new Error("badge_rows_missing"),
    );
  }
  const owned = new Set<string>();
  for (const value of result.data) {
    const badgeId =
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
        ? (value as Record<string, unknown>).badge_id
        : null;
    if (
      typeof badgeId !== "string" ||
      badgeId.length === 0 ||
      badgeId.length > 40 ||
      badgeId !== badgeId.trim() ||
      owned.has(badgeId)
    ) {
      throw new SupabaseOperationError(
        "badges.owned",
        new Error("invalid_badge_row"),
      );
    }
    owned.add(badgeId);
  }
  return owned;
}

/** 누적 합계(get_my_play_totals, 0132) 읽기 — 모르면 누적 도전 진행도를 정할 수 없어 보유 목록 실패와 같이 도전을 멈춘다. */
export function resolvePlayTotalsRead(result: {
  data: unknown;
  error?: unknown;
}): PlayTotals {
  if (result.error !== null && result.error !== undefined) {
    throw new SupabaseOperationError("badges.play_totals", result.error);
  }
  const totals = parsePlayTotals(result.data);
  if (!totals) {
    throw new SupabaseOperationError(
      "badges.play_totals",
      new Error("invalid_play_totals"),
    );
  }
  return totals;
}
