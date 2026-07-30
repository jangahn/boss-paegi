import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  InvalidRefundableCreditsResponseError,
  parseRefundableCreditsResponse,
} from "../../lib/refundable-credits-response.ts";

test("refundable credits response requires an exact nonnegative safe count and timestamp", () => {
  assert.deepEqual(
    parseRefundableCreditsResponse({
      ok: true,
      refundable: 0,
      asOf: "2026-07-29T00:00:00.000Z",
    }),
    { refundable: 0, asOf: "2026-07-29T00:00:00.000Z" },
  );

  for (const value of [
    null,
    {},
    { ok: false, refundable: 0, asOf: "2026-07-29T00:00:00.000Z" },
    { ok: true, refundable: null, asOf: "2026-07-29T00:00:00.000Z" },
    { ok: true, refundable: -1, asOf: "2026-07-29T00:00:00.000Z" },
    { ok: true, refundable: 1.5, asOf: "2026-07-29T00:00:00.000Z" },
    { ok: true, refundable: 0, asOf: "not-a-date" },
  ]) {
    assert.throws(
      () => parseRefundableCreditsResponse(value),
      InvalidRefundableCreditsResponseError,
    );
  }
});

test("withdrawal stays disabled until refundable credits are authoritatively loaded", () => {
  const page = readFileSync(
    new URL("../../app/account/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /refundableStatus === "ready"/);
  assert.match(page, /parseRefundableCreditsResponse/);
  assert.match(page, /role="alert"/);
  assert.match(page, /setRefundableStatus\("loading"\)/);
  assert.match(page, /setRefundableRetry\(\(value\) => value \+ 1\)/);
  assert.doesNotMatch(
    page,
    /refundable-credits"[\s\S]{0,400}\.catch\(\(\) => \{\}\)/,
  );
});
