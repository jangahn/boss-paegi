import assert from "node:assert/strict";
import test from "node:test";
import {
  parseAnalyticsPruneAck,
  parseCreditSweepAck,
  parseIntegrityScanAck,
  parsePublicWriteQuotaPruneAck,
  parseRollupMaintenanceAck,
  parseTelemetryBudgetAck,
  parseTelemetryPruneAck,
  resolveOpsRpc,
} from "../../lib/ops-rpc-result.ts";

test("ops RPC resolution gives errors and throws precedence over data", async () => {
  assert.deepEqual(
    await resolveOpsRpc(async () => ({ data: { ok: true }, error: null })),
    { ok: true, data: { ok: true } },
  );
  const resolved = new Error("database unavailable");
  assert.deepEqual(
    await resolveOpsRpc(async () => ({
      data: { ok: true },
      error: resolved,
    })),
    { ok: false, error: resolved },
  );
  const thrown = new Error("transport unavailable");
  assert.deepEqual(
    await resolveOpsRpc(async () => {
      throw thrown;
    }),
    { ok: false, error: thrown },
  );
});

test("rollup acknowledgements require exact success and requested day count", () => {
  assert.deepEqual(parseRollupMaintenanceAck({ ok: true, days: 7 }, 7), {
    ok: true,
    days: 7,
  });
  for (const value of [
    null,
    {},
    { ok: false, days: 7 },
    { ok: true, days: 3 },
    { ok: true, days: 7, extra: true },
  ]) {
    assert.equal(parseRollupMaintenanceAck(value, 7), null);
  }
});

test("analytics prune acknowledgement is exact and bounded", () => {
  const valid = { ok: true, deleted: 42, cutoff: "2026-04-30" };
  assert.deepEqual(parseAnalyticsPruneAck(valid), valid);
  for (const value of [
    null,
    { ok: true, deleted: -1, cutoff: "2026-04-30" },
    { ok: true, deleted: 1.5, cutoff: "2026-04-30" },
    { ok: true, deleted: 1, cutoff: "not-a-date" },
    { ...valid, extra: true },
  ]) {
    assert.equal(parseAnalyticsPruneAck(value), null);
  }
});

test("telemetry prune and budget acknowledgements reject every malformed counter or mode", () => {
  const prune = {
    ok: true,
    timeline_nulled: 1,
    anon_deleted: 2,
    over_budget_deleted: 3,
    bytes: 4,
  };
  assert.deepEqual(parseTelemetryPruneAck(prune), prune);
  for (const key of [
    "timeline_nulled",
    "anon_deleted",
    "over_budget_deleted",
    "bytes",
  ] as const) {
    assert.equal(
      parseTelemetryPruneAck({ ...prune, [key]: Number.NaN }),
      null,
    );
  }
  const budget = { ok: true, bytes: 100, degrade_mode: "summary" };
  assert.deepEqual(parseTelemetryBudgetAck(budget), budget);
  assert.equal(
    parseTelemetryBudgetAck({ ...budget, degrade_mode: "unknown" }),
    null,
  );
  assert.equal(parseTelemetryBudgetAck({ ...budget, bytes: -1 }), null);
});

test("public-write quota prune acknowledgement is exact, bounded, and backlog-visible", () => {
  const complete = {
    ok: true,
    deleted: 42,
    done: true,
    cutoff: "2026-07-28",
  };
  assert.deepEqual(
    parsePublicWriteQuotaPruneAck(complete, 2_000),
    complete,
  );
  assert.deepEqual(
    parsePublicWriteQuotaPruneAck(
      { ...complete, deleted: 2_000, done: false },
      2_000,
    ),
    { ...complete, deleted: 2_000, done: false },
  );
  for (const value of [
    null,
    { ...complete, deleted: -1 },
    { ...complete, deleted: 2_001 },
    { ...complete, done: "true" },
    { ...complete, cutoff: "not-a-date" },
    { ...complete, extra: true },
  ]) {
    assert.equal(parsePublicWriteQuotaPruneAck(value, 2_000), null);
  }
});

test("integrity scan acknowledgement enforces subset counts", () => {
  assert.deepEqual(parseIntegrityScanAck({ scanned: 10, flagged: 3 }), {
    scanned: 10,
    flagged: 3,
  });
  for (const value of [
    null,
    {},
    { scanned: 10, flagged: 11 },
    { scanned: -1, flagged: 0 },
    { scanned: 10, flagged: 0, ok: true },
  ]) {
    assert.equal(parseIntegrityScanAck(value), null);
  }
});

test("credit sweep acknowledgement cannot claim more rows than the requested batch", () => {
  assert.deepEqual(parseCreditSweepAck({ ok: true, expired: 500 }, 500), {
    ok: true,
    expired: 500,
  });
  for (const value of [
    null,
    {},
    { ok: false, expired: 1 },
    { ok: true, expired: -1 },
    { ok: true, expired: 501 },
    { ok: true, expired: 1, extra: true },
  ]) {
    assert.equal(parseCreditSweepAck(value, 500), null);
  }
});
