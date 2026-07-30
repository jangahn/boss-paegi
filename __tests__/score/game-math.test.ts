import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  comboMultiplier,
  selectIntervalCV,
  useGameStore,
} = await import("../../store/gameStore.ts");
const {
  FRESH_WEAPON_BONUS,
  VARIETY_CAP,
  VARIETY_FULL_AT,
  VARIETY_WINDOW_SIZE,
} = await import("../../lib/game-tuning.ts");
const { WEAPONS } = await import("../../lib/weapons.ts");
const {
  MAX_COMBO_MULTIPLIER,
  MAX_DURATION_MS,
  MAX_SCORE_HARD,
  clampForSubmit,
  scoreCeiling,
} = await import("../../lib/score-limits.ts");

test("combo multiplier is monotone and capped at every integer boundary", () => {
  let previous = -Infinity;
  for (let combo = 0; combo <= 100_000; combo += 1) {
    const multiplier = comboMultiplier(combo);
    assert.ok(multiplier >= previous, `combo=${combo}`);
    assert.ok(multiplier >= 1, `combo=${combo}`);
    assert.ok(multiplier <= MAX_COMBO_MULTIPLIER, `combo=${combo}`);
    assert.equal(
      multiplier,
      Math.min(MAX_COMBO_MULTIPLIER, 1 + Math.floor(combo / 5) * 0.5),
    );
    previous = multiplier;
  }
});

test("all 9^1..9^4 weapon sequences conserve score/count and match an independent model", () => {
  type WeaponKey = (typeof WEAPONS)[number]["key"];
  const keys = WEAPONS.map((weapon) => weapon.key);
  const byKey = new Map(WEAPONS.map((weapon) => [weapon.key, weapon]));

  const verify = (sequence: WeaponKey[]) => {
    useGameStore.getState().start();
    const counts: Record<string, number> = {};
    const scores: Record<string, number> = {};
    let score = 0;
    const window: WeaponKey[] = [];

    for (let index = 0; index < sequence.length; index += 1) {
      const key = sequence[index];
      const weapon = byKey.get(key);
      assert.ok(weapon);
      const fresh = (counts[key] ?? 0) === 0;
      window.push(key);
      if (window.length > VARIETY_WINDOW_SIZE) window.shift();
      const distinct = new Set(window).size;
      const variety = Math.min(
        VARIETY_CAP,
        ((distinct - 1) / (VARIETY_FULL_AT - 1)) * VARIETY_CAP,
      );
      const base = Math.round(
        weapon.strength * comboMultiplier(index + 1) * (1 + variety),
      );
      const gain = base + (fresh ? FRESH_WEAPON_BONUS : 0);
      counts[key] = (counts[key] ?? 0) + 1;
      scores[key] = (scores[key] ?? 0) + gain;
      score += gain;

      assert.equal(
        useGameStore.getState().hit(weapon.strength, key),
        base,
        sequence.join(","),
      );
    }

    const actual = useGameStore.getState();
    assert.equal(actual.score, score, sequence.join(","));
    assert.deepEqual(actual.weaponCounts, counts, sequence.join(","));
    assert.deepEqual(actual.weaponScores, scores, sequence.join(","));
    assert.equal(actual.hitCount, sequence.length, sequence.join(","));
    assert.equal(
      Object.values(actual.weaponCounts).reduce((sum, value) => sum + value, 0),
      actual.hitCount,
    );
    assert.equal(
      Object.values(actual.weaponScores).reduce((sum, value) => sum + value, 0) +
        actual.ultScore,
      actual.score,
    );
  };

  const walk = (prefix: WeaponKey[], remaining: number) => {
    if (remaining === 0) {
      verify(prefix);
      return;
    }
    for (const key of keys) walk([...prefix, key], remaining - 1);
  };
  for (let length = 1; length <= 4; length += 1) walk([], length);
});

test("ultimate hits mutate score only and preserve every manual-play statistic", () => {
  useGameStore.getState().start();
  useGameStore.getState().hit(12, "fist");
  const before = useGameStore.getState();
  const manualSnapshot = {
    combo: before.combo,
    maxCombo: before.maxCombo,
    hitCount: before.hitCount,
    weaponCounts: before.weaponCounts,
    weaponScores: before.weaponScores,
    firstHitMs: before.firstHitMs,
    ultProgress: before.ultProgress,
    weaponWindow: before.weaponWindow,
    varietyMult: before.varietyMult,
  };
  const gain = useGameStore.getState().hit(41, "keyboard", false);
  const after = useGameStore.getState();
  assert.deepEqual(
    {
      combo: after.combo,
      maxCombo: after.maxCombo,
      hitCount: after.hitCount,
      weaponCounts: after.weaponCounts,
      weaponScores: after.weaponScores,
      firstHitMs: after.firstHitMs,
      ultProgress: after.ultProgress,
      weaponWindow: after.weaponWindow,
      varietyMult: after.varietyMult,
    },
    manualSnapshot,
  );
  assert.equal(after.score, before.score + gain);
  assert.equal(after.ultScore, before.ultScore + gain);
});

test("interval CV is exact for constant and deliberately jittered sequences", () => {
  assert.equal(selectIntervalCV({ ivN: 19, ivSum: 1_900, ivSumSq: 190_000 }), null);
  assert.equal(selectIntervalCV({ ivN: 20, ivSum: 2_000, ivSumSq: 200_000 }), 0);

  const values = Array.from({ length: 20 }, (_, index) =>
    index % 2 === 0 ? 50 : 150,
  );
  const sum = values.reduce((total, value) => total + value, 0);
  const sumSq = values.reduce((total, value) => total + value * value, 0);
  const mean = sum / values.length;
  const expected =
    Math.sqrt(sumSq / values.length - mean * mean) / mean;
  assert.equal(
    selectIntervalCV({ ivN: values.length, ivSum: sum, ivSumSq: sumSq }),
    expected,
  );
});

test("client clamp and server ceiling agree across every millisecond around all caps", () => {
  const boundaryDurations = [
    -1,
    0,
    1,
    2,
    499,
    500,
    999,
    1_000,
    MAX_DURATION_MS - 1,
    MAX_DURATION_MS,
    MAX_DURATION_MS + 1,
  ];
  const boundaryScores = [
    -1,
    0,
    1,
    MAX_SCORE_HARD - 1,
    MAX_SCORE_HARD,
    MAX_SCORE_HARD + 1,
    Number.MAX_SAFE_INTEGER,
  ];
  for (const duration of boundaryDurations) {
    for (const score of boundaryScores) {
      const clamped = clampForSubmit(score, duration);
      assert.ok(clamped.durationMs >= 1);
      assert.ok(clamped.durationMs <= MAX_DURATION_MS);
      assert.ok(clamped.score >= 0);
      assert.ok(clamped.score <= scoreCeiling(clamped.durationMs));
    }
  }

  let seed = 0x4f1bbcdc;
  for (let index = 0; index < 20_000; index += 1) {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const duration = seed % (MAX_DURATION_MS * 2);
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    const score = seed * 2;
    const clamped = clampForSubmit(score, duration);
    assert.equal(
      clamped.score,
      Math.min(Math.max(0, Math.round(score)), scoreCeiling(clamped.durationMs)),
    );
  }
});
