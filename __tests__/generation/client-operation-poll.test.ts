import assert from "node:assert/strict";
import test from "node:test";

import { parseClientPollDirective } from "../../lib/client-operation-poll.ts";

test("poll directives require an exact server deadline and bounded Retry-After", () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const directive = parseClientPollDirective({
    retryAfter: "2",
    pollUntil: "2026-07-30T00:05:00.000Z",
    startedAtMs: now,
    startedAtMonotonicMs: 1_000,
    priorDeadlineMs: null,
    priorMonotonicDeadlineMs: null,
    nowMs: now,
    nowMonotonicMs: 1_000,
  });
  assert.deepEqual(directive, {
    deadlineMs: Date.parse("2026-07-30T00:05:00.000Z"),
    monotonicDeadlineMs: 301_000,
    retryAfterMs: 2_000,
  });

  for (const [retryAfter, pollUntil] of [
    [null, "2026-07-30T00:05:00.000Z"],
    ["0", "2026-07-30T00:05:00.000Z"],
    ["11", "2026-07-30T00:05:00.000Z"],
    ["2.5", "2026-07-30T00:05:00.000Z"],
    ["2", "not-a-date"],
    ["2", "2026-07-29T23:59:59.000Z"],
  ] as const) {
    assert.equal(
      parseClientPollDirective({
        retryAfter,
        pollUntil,
        startedAtMs: now,
        startedAtMonotonicMs: 1_000,
        priorDeadlineMs: null,
        priorMonotonicDeadlineMs: null,
        nowMs: now,
        nowMonotonicMs: 1_000,
      }),
      null,
    );
  }
});

test("the first response deadline can only shrink and has a ten-minute hard cap", () => {
  const now = Date.parse("2026-07-30T00:00:00.000Z");
  const prior = now + 4 * 60 * 1000;
  assert.equal(
    parseClientPollDirective({
      retryAfter: "2",
      pollUntil: "2026-07-30T00:09:00.000Z",
      startedAtMs: now,
      startedAtMonotonicMs: 1_000,
      priorDeadlineMs: prior,
      priorMonotonicDeadlineMs: 241_000,
      nowMs: now + 1_000,
      nowMonotonicMs: 2_000,
    })?.deadlineMs,
    prior,
  );
  assert.equal(
    parseClientPollDirective({
      retryAfter: "2",
      pollUntil: "2026-07-30T00:30:00.000Z",
      startedAtMs: now,
      startedAtMonotonicMs: 1_000,
      priorDeadlineMs: null,
      priorMonotonicDeadlineMs: null,
      nowMs: now,
      nowMonotonicMs: 1_000,
    })?.deadlineMs,
    now + 10 * 60 * 1000,
  );
});

test("wall-clock rollback cannot extend the monotonic ten-minute cap", () => {
  const startedAt = Date.parse("2026-07-30T00:00:00.000Z");
  const first = parseClientPollDirective({
    retryAfter: "2",
    pollUntil: "2026-07-30T00:09:00.000Z",
    startedAtMs: startedAt,
    startedAtMonotonicMs: 10_000,
    priorDeadlineMs: null,
    priorMonotonicDeadlineMs: null,
    nowMs: startedAt,
    nowMonotonicMs: 10_000,
  });
  assert.ok(first);
  assert.equal(
    parseClientPollDirective({
      retryAfter: "2",
      pollUntil: "2026-07-30T00:09:00.000Z",
      startedAtMs: startedAt,
      startedAtMonotonicMs: 10_000,
      priorDeadlineMs: first.deadlineMs,
      priorMonotonicDeadlineMs: first.monotonicDeadlineMs,
      // Wall time has been moved back to +1 minute while monotonic elapsed
      // time has already crossed the operation cap.
      nowMs: startedAt + 60 * 1000,
      nowMonotonicMs: 10_000 + 10 * 60 * 1000 + 1,
    }),
    null,
  );
});
