import test from "node:test";
import assert from "node:assert/strict";
import {
  WINDOW_MS_MAX,
  WINDOW_MS_MIN,
  pickHighlightWindow,
  recentVelocity,
  sanitizeHighlightMeta,
  type ScoreSample,
} from "../../lib/highlight.ts";

function bruteWindow(
  samples: ScoreSample[],
  minMs: number,
  maxMs: number,
) {
  let best: { startAt: number; endAt: number; delta: number } | null = null;
  for (let start = 0; start < samples.length; start += 1) {
    for (let end = start + 1; end < samples.length; end += 1) {
      const dt = samples[end].t - samples[start].t;
      const delta = samples[end].score - samples[start].score;
      if (
        dt >= minMs &&
        dt <= maxMs &&
        delta > 0 &&
        (!best || delta > best.delta)
      ) {
        best = {
          startAt: samples[start].t,
          endAt: samples[end].t,
          delta,
        };
      }
    }
  }
  return best;
}

test("highlight window algorithm equals brute force for every length<=7 finite trace", () => {
  const increments = [0, 1, 10];
  const timeSteps = [500, 1_000];

  const walk = (
    samples: ScoreSample[],
    remaining: number,
  ): void => {
    if (remaining === 0) {
      assert.deepEqual(
        pickHighlightWindow(samples, { minMs: 1_500, maxMs: 3_000 }),
        bruteWindow(samples, 1_500, 3_000),
        JSON.stringify(samples),
      );
      return;
    }
    const previous = samples.at(-1) ?? { t: 0, score: 0 };
    for (const dt of timeSteps) {
      for (const gain of increments) {
        walk(
          [
            ...samples,
            { t: previous.t + dt, score: previous.score + gain },
          ],
          remaining - 1,
        );
      }
    }
  };

  for (let length = 2; length <= 7; length += 1) {
    walk([{ t: 0, score: 0 }], length - 1);
  }
});

test("recent velocity matches the latest sample minus the cutoff baseline", () => {
  const samples = [
    { t: 0, score: 0 },
    { t: 500, score: 10 },
    { t: 1_000, score: 30 },
    { t: 1_500, score: 60 },
  ];
  assert.equal(recentVelocity([], 1_500, 1_000), 0);
  assert.equal(recentVelocity(samples, 1_500, 1_000), 50);
  assert.equal(recentVelocity(samples, 1_500, 500), 30);
  assert.equal(recentVelocity(samples, 1_500, 2_000), 60);
});

test("highlight metadata accepts exactly the documented closed boundaries", () => {
  const finalScore = 1_000;
  const deltas = [-1, 0, 1, finalScore - 1, finalScore, finalScore + 1];
  const windows = [
    WINDOW_MS_MIN - 1,
    WINDOW_MS_MIN,
    WINDOW_MS_MIN + 1,
    WINDOW_MS_MAX - 1,
    WINDOW_MS_MAX,
    WINDOW_MS_MAX + 1,
  ];
  for (const delta of deltas) {
    for (const windowMs of windows) {
      const result = sanitizeHighlightMeta({ delta, windowMs }, finalScore);
      assert.equal(
        result.delta,
        delta >= 0 && delta <= finalScore ? delta : null,
      );
      assert.equal(
        result.windowMs,
        windowMs >= WINDOW_MS_MIN && windowMs <= WINDOW_MS_MAX
          ? windowMs
          : null,
      );
    }
  }
});
