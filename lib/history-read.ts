import { SupabaseOperationError } from "./supabase-operation.ts";
import { WEAPON_KEY_VALUES } from "./weapon-keys.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const WEAPON_KEYS = new Set<string>(WEAPON_KEY_VALUES);

export type PublicHistoryProfile = {
  display_name: string | null;
  avatar_url: string | null;
};

export type PublicHistoryGame = {
  id: string;
  score: number;
  weapon: string;
  duration_ms: number;
  max_combo: number | null;
  created_at: string;
};

function malformed(operation: string, detail: string): never {
  throw new SupabaseOperationError(operation, new Error(detail));
}

export function parsePublicHistoryProfile(
  operation: string,
  value: unknown,
): PublicHistoryProfile | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    malformed(operation, "profile_shape_invalid");
  }
  const row = value as Record<string, unknown>;
  if (
    !(row.display_name === null || typeof row.display_name === "string") ||
    !(row.avatar_url === null || typeof row.avatar_url === "string")
  ) {
    malformed(operation, "profile_field_invalid");
  }
  return row as PublicHistoryProfile;
}

export function parsePublicHistoryGames(
  operation: string,
  value: unknown,
): PublicHistoryGame[] {
  if (!Array.isArray(value)) malformed(operation, "row_array_missing");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      malformed(operation, `row_shape_invalid:${index}`);
    }
    const row = entry as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !UUID_RE.test(row.id) ||
      !Number.isSafeInteger(row.score) ||
      (row.score as number) < 0 ||
      typeof row.weapon !== "string" ||
      !WEAPON_KEYS.has(row.weapon) ||
      !Number.isSafeInteger(row.duration_ms) ||
      (row.duration_ms as number) < 0 ||
      !(
        row.max_combo === null ||
        (Number.isSafeInteger(row.max_combo) &&
          (row.max_combo as number) >= 0)
      ) ||
      typeof row.created_at !== "string" ||
      !Number.isFinite(Date.parse(row.created_at))
    ) {
      malformed(operation, `row_field_invalid:${index}`);
    }
    return row as PublicHistoryGame;
  });
}
