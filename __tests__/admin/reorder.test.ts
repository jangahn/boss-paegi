import assert from "node:assert/strict";
import test from "node:test";
import { moveItem } from "../../lib/reorder.ts";

test("moveItem exhaustively swaps only valid adjacent indexes", () => {
  for (let length = 0; length <= 12; length += 1) {
    const original = Array.from({ length }, (_, index) => index);
    for (let index = -3; index <= length + 3; index += 1) {
      for (const direction of [-1, 1] as const) {
        const actual = moveItem(original, index, direction);
        const adjacent = index + direction;
        const shouldSwap =
          index >= 0 &&
          index < length &&
          adjacent >= 0 &&
          adjacent < length;
        const expected = original.slice();
        if (shouldSwap) {
          [expected[index], expected[adjacent]] = [
            expected[adjacent]!,
            expected[index]!,
          ];
        }

        assert.deepEqual(
          actual,
          expected,
          JSON.stringify({ length, index, direction }),
        );
        assert.deepEqual(original, Array.from({ length }, (_, i) => i));
        assert.notEqual(actual, original);
      }
    }
  }
});

test("moveItem fails closed for every non-safe index and invalid runtime direction", () => {
  const original = [0, 1, 2];
  const invalidIndexes = [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    -0.1,
    0.1,
    Number.MAX_SAFE_INTEGER + 1,
    Number.MIN_SAFE_INTEGER - 1,
  ];

  for (const index of invalidIndexes) {
    assert.deepEqual(moveItem(original, index, 1), original);
    assert.deepEqual(moveItem(original, index, -1), original);
  }

  for (const direction of [-2, 0, 2, Number.NaN]) {
    assert.deepEqual(
      moveItem(original, 1, direction as -1 | 1),
      original,
    );
  }
});
