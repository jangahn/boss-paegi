import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isExactNicknameMutationRow } from "../../lib/profile-read.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";

test("nickname UPDATE는 한 exact owner/name row만 commit으로 인정한다", () => {
  assert.equal(
    isExactNicknameMutationRow(
      { id: USER_ID, display_name: "새닉네임" },
      USER_ID,
      "새닉네임",
    ),
    true,
  );
  for (const malformed of [
    null,
    [],
    {},
    { id: USER_ID },
    { id: "00000000-0000-4000-8000-000000000002", display_name: "새닉네임" },
    { id: USER_ID, display_name: "다른닉네임" },
    { id: USER_ID, display_name: "새닉네임", extra: true },
  ]) {
    assert.equal(
      isExactNicknameMutationRow(malformed, USER_ID, "새닉네임"),
      false,
    );
  }
});

test("nickname write surface는 UPDATE 반환 row를 요청 identity와 재검증한다", () => {
  const source = readFileSync(
    new URL("../../lib/profile.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /\.update\(\{ display_name: name \}\)[\s\S]*\.select\("id, display_name"\)[\s\S]*\.maybeSingle\(\)/,
  );
  assert.match(
    source,
    /isExactNicknameMutationRow\(data, session\.user\.id, name\)/,
  );
});
