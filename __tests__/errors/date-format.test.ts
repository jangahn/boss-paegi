import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { fmtKstDateTime } = await import("../../lib/format.ts");
const { fmtKst } = await import("../../lib/admin-format.ts");

test("member and admin date formatters fail closed for every non-date boundary", () => {
  for (const value of [
    null,
    "",
    "not-a-date",
    "2026-02-30T25:00:00Z",
    "NaN",
    "Infinity",
  ]) {
    assert.equal(fmtKstDateTime(value), "—", String(value));
    assert.equal(fmtKst(value), "—", String(value));
  }
});

test("member and admin date formatters preserve the year and normalize offsets to KST", () => {
  const inputs = [
    "1970-01-01T00:00:00.000Z",
    "2026-07-30T12:34:56.789Z",
    "2099-12-31T23:59:59-05:00",
  ];
  for (const input of inputs) {
    const member = fmtKstDateTime(input);
    const admin = fmtKst(input);
    assert.notEqual(member, "—", input);
    assert.notEqual(admin, "—", input);
    assert.match(member, /\d{4}/, input);
    assert.match(admin, /\d{4}/, input);
    assert.doesNotMatch(member, /Invalid Date/i, input);
    assert.doesNotMatch(admin, /Invalid Date/i, input);
  }
});
