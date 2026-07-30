import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_PAGE_PARAM,
  parsePageParam,
} from "../../lib/pagination.ts";

test("page parser accepts only canonical bounded positive integers", () => {
  assert.equal(parsePageParam("1"), 1);
  assert.equal(parsePageParam("2"), 2);
  assert.equal(parsePageParam(String(MAX_PAGE_PARAM)), MAX_PAGE_PARAM);
  assert.equal(parsePageParam(["7", "8"]), 7);
});

test("page parser maps malformed numeric equivalence classes to page 1", () => {
  const invalid = [
    undefined,
    "",
    "0",
    "-1",
    "+1",
    "01",
    "1.0",
    "1e2",
    " 2",
    "2 ",
    "NaN",
    "Infinity",
    "-Infinity",
    "1_000",
    "1/2",
    "abc",
    "9007199254740992",
    String(MAX_PAGE_PARAM + 1),
  ] as const;
  for (const value of invalid) {
    assert.equal(parsePageParam(value), 1, String(value));
  }
  assert.equal(parsePageParam([]), 1);
  assert.equal(parsePageParam(["", "2"]), 1);
});

test("page parser rejects an invalid caller bound", () => {
  assert.equal(parsePageParam("2", 0), 1);
  assert.equal(parsePageParam("2", Number.POSITIVE_INFINITY), 1);
  assert.equal(parsePageParam("2", 1.5), 1);
});
