import test from "node:test";
import assert from "node:assert/strict";
import {
  isReviewStatus,
  parseScoreVisibilityRow,
} from "../../lib/score-visibility.ts";

const SCORE_ID = "00000000-0000-4000-8000-000000000001";

test("review status authority는 네 enum만 허용한다", () => {
  for (const status of ["registered", "pending", "cleared", "voided"]) {
    assert.equal(isReviewStatus(status), true);
  }
  for (const status of [null, undefined, "", "REGISTERED", "unknown", true]) {
    assert.equal(isReviewStatus(status), false);
  }
});

test("compat visibility query는 exact score identity/status row만 승인한다", () => {
  assert.equal(
    parseScoreVisibilityRow(
      { id: SCORE_ID, review_status: "pending" },
      SCORE_ID,
    ),
    "pending",
  );
  for (const malformed of [
    null,
    {},
    { id: SCORE_ID },
    { id: SCORE_ID, review_status: null },
    { id: SCORE_ID, review_status: "unknown" },
    {
      id: "00000000-0000-4000-8000-000000000002",
      review_status: "registered",
    },
    { id: SCORE_ID, review_status: "registered", extra: true },
  ]) {
    assert.throws(
      () => parseScoreVisibilityRow(malformed, SCORE_ID),
      /invalid_score_visibility_row/,
    );
  }
});
