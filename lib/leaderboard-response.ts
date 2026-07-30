export type LeaderboardRow = {
  id: string;
  owner_id: string;
  score: number;
  weapon: string;
  duration_ms: number;
  created_at: string;
  display_name: string | null;
  avatar_url: string | null;
};

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalString(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Public RPC payload boundary. A malformed success must not become an empty ranking. */
export function parseLeaderboardRows(data: unknown): LeaderboardRow[] | null {
  if (!Array.isArray(data) || data.length > 10) return null;
  const rows: LeaderboardRow[] = [];
  for (const value of data) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      return null;
    }
    const row = value as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !UUID_RE.test(row.id) ||
      typeof row.owner_id !== "string" ||
      !UUID_RE.test(row.owner_id) ||
      !Number.isSafeInteger(row.score) ||
      (row.score as number) < 0 ||
      typeof row.weapon !== "string" ||
      row.weapon.length === 0 ||
      !Number.isSafeInteger(row.duration_ms) ||
      (row.duration_ms as number) <= 0 ||
      typeof row.created_at !== "string" ||
      !Number.isFinite(Date.parse(row.created_at)) ||
      !optionalString(row.display_name) ||
      !optionalString(row.avatar_url)
    ) {
      return null;
    }
    rows.push({
      id: row.id,
      owner_id: row.owner_id,
      score: row.score as number,
      weapon: row.weapon,
      duration_ms: row.duration_ms as number,
      created_at: row.created_at,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
    });
  }
  return rows;
}
