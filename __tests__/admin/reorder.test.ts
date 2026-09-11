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

import { moveWithinGroup, swapItems } from "../../lib/reorder.ts";

test("swapItems: 유효한 두 인덱스만 맞바꾼 새 배열, 같은 인덱스·범위 밖·비정수는 원본 그대로", () => {
  const original = ["a", "b", "c", "d"];
  assert.deepEqual(swapItems(original, 0, 3), ["d", "b", "c", "a"]);
  assert.deepEqual(swapItems(original, 2, 1), ["a", "c", "b", "d"]);
  assert.deepEqual(original, ["a", "b", "c", "d"], "원본 불변");
  for (const [i, j] of [[1, 1], [-1, 0], [0, 4], [0.5, 1], [Number.NaN, 0]] as const) {
    const out = swapItems(original, i, j);
    assert.deepEqual(out, original, JSON.stringify({ i, j }));
    assert.notEqual(out, original);
  }
});

test("moveWithinGroup: 그룹 이웃이 전체 배열에서 떨어져 있어도 그룹 안 한 칸 이동 = 두 이웃 자리 교환", () => {
  // 뱃지 카탈로그처럼 패밀리 행이 흩어진 배열: a1 b1 a2 b2 a3 (추가·편입 행이 뒤에 붙은 모양)
  const arr = [
    { g: "a", id: "a1" },
    { g: "b", id: "b1" },
    { g: "a", id: "a2" },
    { g: "b", id: "b2" },
    { g: "a", id: "a3" },
  ];
  const inA = (x: { g: string }) => x.g === "a";
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  const up = moveWithinGroup(arr, inA, 2, -1); // a3 위로 → a2 와 교환(사이의 b2 는 그대로)
  assert.deepEqual(ids(up), ["a1", "b1", "a3", "b2", "a2"]);
  assert.deepEqual(ids(up.filter(inA)), ["a1", "a3", "a2"], "그룹 안 순서만 한 칸 바뀐다");
  assert.deepEqual(ids(up.filter((x) => !inA(x))), ["b1", "b2"], "다른 그룹 순서 불변");
  const down = moveWithinGroup(arr, inA, 0, 1); // a1 아래로 → a2 와 교환
  assert.deepEqual(ids(down), ["a2", "b1", "a1", "b2", "a3"]);
  assert.deepEqual(ids(arr), ["a1", "b1", "a2", "b2", "a3"], "원본 불변");
  // 범위 밖·잘못된 방향은 원본 그대로(새 배열)
  for (const [gi, dir] of [[0, -1], [2, 1], [3, -1], [-1, 1], [1, 0]] as const) {
    const out = moveWithinGroup(arr, inA, gi, dir as -1 | 1);
    assert.deepEqual(ids(out), ids(arr), JSON.stringify({ gi, dir }));
    assert.notEqual(out, arr);
  }
  // 그룹이 연속 블록이면 moveItem 과 같은 결과
  const contiguous = ["x", "y", "z"].map((id) => ({ g: "a", id }));
  assert.deepEqual(ids(moveWithinGroup(contiguous, inA, 1, 1)), ["x", "z", "y"]);
});
