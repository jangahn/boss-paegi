import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { buildGameplayStats } = await import("../../lib/stats.ts");
const { PERSONA_DEFS, matchPersona } = await import("../../lib/persona.ts");

function personaFor(
  weaponCounts: Record<string, number>,
  options: {
    durationMs?: number;
    maxCombo?: number;
    ultimateCount?: number;
  } = {},
) {
  const hitCount = Object.values(weaponCounts).reduce(
    (sum, count) => sum + count,
    0,
  );
  const weaponScores = Object.fromEntries(
    Object.keys(weaponCounts).map((key) => [key, 0]),
  );
  return matchPersona(
    buildGameplayStats({
      hitCount,
      maxCombo: options.maxCombo ?? Math.min(hitCount, 1),
      durationMs: options.durationMs ?? 60_000,
      weaponCounts,
      weaponScores,
      ultScore: 0,
      ultimateCount: options.ultimateCount ?? 0,
      firstHitMs: hitCount > 0 ? 0 : null,
      bgVisits: [],
      intervalCV: null,
    }),
  );
}

test("every strict persona threshold is closed on the documented side", () => {
  assert.equal(
    personaFor({ slap: 10 }, { ultimateCount: 2 }).id,
    "precision",
  );
  assert.equal(
    personaFor({ slap: 10 }, { ultimateCount: 3 }).id,
    "ult_dependent",
  );

  assert.equal(personaFor({ pen: 3, slap: 7 }).id, "precision");
  assert.equal(personaFor({ pen: 4, slap: 6 }).id, "graffiti");

  assert.equal(personaFor({ gun: 5, slap: 5 }).id, "precision");
  assert.equal(personaFor({ gun: 6, slap: 4 }).id, "sniper");

  assert.equal(personaFor({ book: 6, slap: 4 }).id, "precision");
  assert.equal(personaFor({ book: 7, slap: 3 }).id, "thrower");

  assert.equal(personaFor({ grab: 4, slap: 6 }).id, "precision");
  assert.equal(personaFor({ grab: 5, slap: 5 }).id, "grabber");

  assert.equal(
    personaFor({ slap: 10 }, { maxCombo: 29 }).id,
    "precision",
  );
  assert.equal(personaFor({ slap: 10 }, { maxCombo: 30 }).id, "combo");

  assert.equal(personaFor({ fist: 7, slap: 3 }).id, "precision");
  assert.equal(personaFor({ fist: 8, slap: 2 }).id, "barehand");
});

test("variety and speed branches are reachable without crossing earlier thresholds", () => {
  assert.equal(
    personaFor({
      fist: 1,
      slap: 1,
      book: 1,
      keyboard: 1,
      gun: 1,
      grab: 1,
      pen: 1,
    }).id,
    "carpet",
  );
  assert.equal(
    personaFor(
      { fist: 1, slap: 1, book: 1, gun: 1 },
      { durationMs: 2_008 },
    ).id,
    "blitz",
  );
  assert.equal(
    personaFor(
      { fist: 1, slap: 1, book: 1, gun: 1 },
      { durationMs: 2_009 },
    ).id,
    "precision",
  );
});

test("catalog ids are unique and every persona branch is reachable", () => {
  const ids = PERSONA_DEFS.map((definition) => definition.id);
  assert.equal(new Set(ids).size, ids.length);

  const reached = new Set([
    personaFor({ slap: 1 }, { ultimateCount: 3 }).id,
    personaFor({ pen: 4, slap: 6 }).id,
    personaFor({ gun: 6, slap: 4 }).id,
    personaFor({ book: 7, slap: 3 }).id,
    personaFor({ grab: 5, slap: 5 }).id,
    personaFor({ slap: 30 }, { maxCombo: 30 }).id,
    personaFor({
      fist: 1,
      slap: 1,
      book: 1,
      keyboard: 1,
      gun: 1,
      grab: 1,
      pen: 1,
    }).id,
    personaFor({ fist: 8, slap: 2 }).id,
    personaFor(
      { fist: 1, slap: 1, book: 1, gun: 1 },
      { durationMs: 2_008 },
    ).id,
    personaFor({ slap: 1 }).id,
  ]);
  assert.deepEqual([...reached].sort(), [...ids].sort());
});
