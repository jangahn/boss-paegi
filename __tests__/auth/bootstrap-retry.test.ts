import assert from "node:assert/strict";
import test from "node:test";
import {
  BOOTSTRAP_RETRY_DELAYS_MS,
  BOOTSTRAP_RETRY_MAX_ATTEMPTS,
  bootstrapRetryDelayMs,
} from "../../lib/bootstrap-retry.ts";

test("bootstrap retry keeps the first two attempts short, then backs off to a 60s cap", () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 7].map(bootstrapRetryDelayMs),
    [5_000, 10_000, 20_000, 40_000, 60_000, 60_000, 60_000],
  );
  assert.equal(Math.max(...BOOTSTRAP_RETRY_DELAYS_MS), 60_000);
});

test("bootstrap retry stops after the attempt cap and rejects invalid counts", () => {
  assert.equal(bootstrapRetryDelayMs(BOOTSTRAP_RETRY_MAX_ATTEMPTS), null);
  assert.equal(bootstrapRetryDelayMs(BOOTSTRAP_RETRY_MAX_ATTEMPTS + 5), null);
  assert.equal(bootstrapRetryDelayMs(0), null);
  assert.equal(bootstrapRetryDelayMs(-1), null);
  assert.equal(bootstrapRetryDelayMs(Number.NaN), null);
  assert.equal(bootstrapRetryDelayMs(1.5), null);
});

test("a blocked client stays under ten attempts in its first ten minutes", () => {
  // 12s attempt timeout + wait, summed over the schedule: 8 attempts finish
  // well inside 10 minutes and the ninth never fires.
  let elapsed = 0;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    elapsed += 12_000;
    const wait = bootstrapRetryDelayMs(attempts);
    if (wait === null) break;
    elapsed += wait;
  }
  assert.equal(attempts, BOOTSTRAP_RETRY_MAX_ATTEMPTS);
  assert.ok(elapsed < 10 * 60_000, `elapsed ${elapsed}`);
});
