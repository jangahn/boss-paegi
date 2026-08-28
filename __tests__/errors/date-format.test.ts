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

test("date formatters never emit a locale day period — SSR/CSR must render identical text", () => {
  // Vercel Node 런타임 ICU 는 ko-KR dayPeriod 를 루트 폴백 "AM/PM" 으로 내지만(프로드 SSR 실측)
  // 클라 ICU 는 "오전/오후" — meridiem 이 출력에 있으면 hydration text mismatch(#418)가 난다.
  const inputs = [
    "2026-08-28T03:24:48.444948+00:00", // KST 12:24 (오후 경계)
    "2026-08-28T22:05:00Z", // KST 다음날 07:05 (오전)
  ];
  for (const input of inputs) {
    for (const formatted of [fmtKstDateTime(input), fmtKst(input)]) {
      assert.doesNotMatch(formatted, /AM|PM|오전|오후/, input);
      assert.match(formatted, /\d{2}:\d{2}/, input);
    }
  }
  assert.equal(fmtKst("2026-08-28T03:24:48.444948+00:00"), "2026. 08. 28. 12:24");
  assert.equal(
    fmtKstDateTime("2026-08-28T03:24:48.444948+00:00"),
    "2026. 08. 28. 12:24",
  );
});
