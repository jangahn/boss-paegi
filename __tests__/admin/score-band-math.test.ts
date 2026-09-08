import assert from "node:assert/strict";
import test from "node:test";
import { bandScoreBuckets } from "../../lib/admin-analytics-math.ts";

// 점수 구간 분포(v1.24) — 1,000점 버킷(dim game_score_1k)을 현재 경계로 접는 산식 회귀.
// tierOf 는 lib/score-tiers scoreTier 를 경계와 바인딩해 넘기는 계약 — 여기선 동일 규칙을 인라인으로 재현한다.

const thresholds = [10_000, 30_000, 60_000, 100_000];
const tierOf = (score: number) => Math.min(4, thresholds.filter((t) => score >= t).length);

test("buckets fold into five ordered bands with sums and empty bands kept", () => {
  const bands = bandScoreBuckets(
    [
      { bucket: 0, games: 3, score: 1_500, durationMs: 30_000 },
      { bucket: 9, games: 1, score: 9_900, durationMs: 40_000 }, // 9,000~9,999 → tier 0
      { bucket: 10, games: 2, score: 21_000, durationMs: 100_000 }, // 10,000~ → tier 1
      { bucket: 29, games: 1, score: 29_500, durationMs: 90_000 }, // tier 1
      { bucket: 30, games: 1, score: 30_100, durationMs: 120_000 }, // tier 2
      { bucket: 99, games: 1, score: 99_999, durationMs: 200_000 }, // tier 3
      { bucket: 100, games: 2, score: 250_000, durationMs: 600_000 }, // tier 4
      { bucket: 733, games: 1, score: 733_467, durationMs: 1_800_000 }, // tier 4
    ],
    tierOf,
    5,
  );
  assert.deepEqual(
    bands.map((b) => [b.tier, b.games, b.score, b.durationMs]),
    [
      [0, 4, 11_400, 70_000],
      [1, 3, 50_500, 190_000],
      [2, 1, 30_100, 120_000],
      [3, 1, 99_999, 200_000],
      [4, 3, 983_467, 2_400_000],
    ],
  );
});

test("empty input yields all-zero bands and malformed buckets are ignored", () => {
  assert.deepEqual(
    bandScoreBuckets([], tierOf, 5).map((b) => b.games),
    [0, 0, 0, 0, 0],
  );
  const bands = bandScoreBuckets(
    [
      { bucket: -1, games: 5, score: 0, durationMs: 0 },
      { bucket: Number.NaN, games: 5, score: 0, durationMs: 0 },
      { bucket: 1, games: 1, score: 1_200, durationMs: 1_000 },
    ],
    tierOf,
    5,
  );
  assert.deepEqual(bands.map((b) => b.games), [1, 0, 0, 0, 0]);
});

test("changing the thresholds re-bands the same buckets exactly", () => {
  const buckets = [
    { bucket: 15, games: 1, score: 15_000, durationMs: 1 },
    { bucket: 45, games: 1, score: 45_000, durationMs: 1 },
  ];
  const wide = [20_000, 40_000, 60_000, 80_000];
  const wideTier = (score: number) => Math.min(4, wide.filter((t) => score >= t).length);
  assert.deepEqual(bandScoreBuckets(buckets, tierOf, 5).map((b) => b.games), [0, 1, 1, 0, 0]);
  assert.deepEqual(bandScoreBuckets(buckets, wideTier, 5).map((b) => b.games), [1, 0, 1, 0, 0]);
});
