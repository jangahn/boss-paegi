import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  activeGameElapsedMs,
  firstHitElapsedMs,
} from "../../lib/game-clock.ts";

test("performance.now() zero is a valid active-game timestamp at every duration boundary", () => {
  assert.equal(activeGameElapsedMs(true, 0, 0), 0);
  assert.equal(activeGameElapsedMs(true, 0, 1), 1);
  assert.equal(activeGameElapsedMs(true, 0, 60_000), 60_000);
  assert.equal(activeGameElapsedMs(true, 10, 9), 0);
  assert.equal(activeGameElapsedMs(false, 0, 60_000), 0);

  assert.equal(
    firstHitElapsedMs({
      hitCount: 0,
      active: true,
      startedAt: 0,
      now: 0,
      previous: null,
    }),
    0,
  );
  assert.equal(
    firstHitElapsedMs({
      hitCount: 0,
      active: true,
      startedAt: 0,
      now: 123.6,
      previous: null,
    }),
    124,
  );
  assert.equal(
    firstHitElapsedMs({
      hitCount: 1,
      active: true,
      startedAt: 0,
      now: 500,
      previous: 124,
    }),
    124,
  );
});

test("play duration consumers use lifecycle state rather than timestamp truthiness", () => {
  const badge = readFileSync(
    new URL("../../app/play/useBadgeChallenge.ts", import.meta.url),
    "utf8",
  );
  const page = readFileSync(
    new URL("../../app/play/page.tsx", import.meta.url),
    "utf8",
  );
  const store = readFileSync(
    new URL("../../store/gameStore.ts", import.meta.url),
    "utf8",
  );
  assert.match(badge, /activeGameElapsedMs\(\s*s\.isPlaying,\s*s\.startedAt/);
  assert.match(page, /activeGameElapsedMs\(s\.isPlaying, s\.startedAt/);
  assert.match(page, /if \(!s\.isPlaying\) return/);
  assert.doesNotMatch(page, /!s\.startedAt|s\.startedAt \?/);
  assert.match(store, /firstHitElapsedMs\(/);
  assert.doesNotMatch(store, /hitCount === 0 && startedAt/);
});
