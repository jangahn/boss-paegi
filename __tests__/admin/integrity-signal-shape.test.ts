import assert from "node:assert/strict";
import test from "node:test";
import { normalizeFlagSignalShape } from "../../lib/integrity-signal-shape.ts";

test("legacy v1/v2 signals gain null value/threshold, current signals are untouched", () => {
  assert.deepEqual(
    normalizeFlagSignalShape([
      { id: "CONFIRMED_AUTOCLICKER", source: "admin" },
      { id: "C1B_DURATION_MISMATCH", value: 128975, source: "cron" },
      { id: "S3_SCORE_PER_SEC", value: 1498.4, threshold: 1400, source: "submit" },
      { id: "NULLED", value: null, threshold: null, source: "submit" },
    ]),
    [
      { id: "CONFIRMED_AUTOCLICKER", source: "admin", value: null, threshold: null },
      { id: "C1B_DURATION_MISMATCH", value: 128975, source: "cron", threshold: null },
      { id: "S3_SCORE_PER_SEC", value: 1498.4, threshold: 1400, source: "submit" },
      { id: "NULLED", value: null, threshold: null, source: "submit" },
    ],
  );
});

test("non-array or non-object entries pass through for the strict validator to reject", () => {
  assert.equal(normalizeFlagSignalShape(null), null);
  assert.equal(normalizeFlagSignalShape("x"), "x");
  assert.deepEqual(normalizeFlagSignalShape([1, "a", null, [2]]), [1, "a", null, [2]]);
});
