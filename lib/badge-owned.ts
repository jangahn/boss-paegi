import { SupabaseOperationError } from "./supabase-operation.ts";

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
