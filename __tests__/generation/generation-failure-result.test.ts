import assert from "node:assert/strict";
import test from "node:test";
import {
  GENERATION_FAILURE_SUCCESS_OUTCOMES,
  parseGenerationFailureRpcResult,
} from "../../lib/character-gen/generation-failure-result.ts";

test("accepts every explicit successful failure/refund outcome", () => {
  for (const outcome of GENERATION_FAILURE_SUCCESS_OUTCOMES) {
    assert.deepEqual(
      parseGenerationFailureRpcResult({ ok: true, outcome, extra: "ignored" }),
      { ok: true, outcome },
    );
  }
});

test("recognizes version conflict as a fenced no-write result", () => {
  assert.deepEqual(
    parseGenerationFailureRpcResult({
      ok: false,
      outcome: "version_conflict",
      expectedVersion: 3,
      actualVersion: 4,
    }),
    { ok: false, outcome: "version_conflict" },
  );
});

test("rejects malformed, contradictory, and unknown resolved RPC payloads", () => {
  for (const value of [
    null,
    [],
    {},
    { ok: true },
    { ok: "true", outcome: "refunded" },
    { ok: false, outcome: "refunded" },
    { ok: true, outcome: "version_conflict" },
    { ok: false, outcome: "no_op" },
    { ok: true, outcome: "future_success" },
  ]) {
    assert.equal(parseGenerationFailureRpcResult(value), null);
  }
});
