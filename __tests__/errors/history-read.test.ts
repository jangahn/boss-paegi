import assert from "node:assert/strict";
import test from "node:test";
import {
  parsePublicHistoryGames,
  parsePublicHistoryProfile,
} from "../../lib/history-read.ts";
import { SupabaseOperationError } from "../../lib/supabase-operation.ts";

const game = {
  id: "11111111-1111-4111-8111-111111111111",
  score: 12,
  weapon: "fist",
  duration_ms: 1000,
  max_combo: 2,
  created_at: "2026-07-29T00:00:00.000Z",
};

test("public history accepts authoritative empty/profile/game shapes", () => {
  assert.equal(parsePublicHistoryProfile("profile", null), null);
  assert.deepEqual(
    parsePublicHistoryProfile("profile", {
      display_name: null,
      avatar_url: null,
    }),
    { display_name: null, avatar_url: null },
  );
  assert.deepEqual(parsePublicHistoryGames("games", []), []);
  assert.deepEqual(parsePublicHistoryGames("games", [game]), [game]);
});

test("public history rejects malformed profile success instead of false identity", () => {
  for (const value of [
    undefined,
    [],
    {},
    { display_name: 1, avatar_url: null },
    { display_name: null, avatar_url: false },
  ]) {
    assert.throws(
      () => parsePublicHistoryProfile("profile", value),
      SupabaseOperationError,
    );
  }
});

test("public history rejects every unsafe game field equivalence class", () => {
  const invalid = [
    undefined,
    null,
    {},
    [{ ...game, id: "not-a-uuid" }],
    [{ ...game, score: -1 }],
    [{ ...game, score: 1.5 }],
    [{ ...game, score: Number.NaN }],
    [{ ...game, weapon: "unknown" }],
    [{ ...game, duration_ms: -1 }],
    [{ ...game, duration_ms: Number.POSITIVE_INFINITY }],
    [{ ...game, max_combo: -1 }],
    [{ ...game, max_combo: "2" }],
    [{ ...game, created_at: "not-a-date" }],
  ];
  for (const value of invalid) {
    assert.throws(
      () => parsePublicHistoryGames("games", value),
      SupabaseOperationError,
    );
  }
});
