import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(
  new URL("../../lib/fal-balance.ts", import.meta.url),
  "utf8",
);

test("Fal billing response is bounded before UTF-8 decoding and JSON parsing", () => {
  assert.match(source, /readBoundedResponseBytes/);
  assert.match(source, /FAL_BILLING_RESPONSE_MAX_BYTES/);
  assert.match(source, /TextDecoder\("utf-8", \{ fatal: true \}\)/);
  assert.doesNotMatch(source, /\bres\.json\(\)/);
  assert.doesNotMatch(source, /\bres\.(?:text|arrayBuffer|blob)\(\)/);
});

test("Fal balance evidence rejects non-finite and negative numbers", () => {
  assert.match(source, /Number\.isFinite\(balance\)/);
  assert.match(source, /balance < 0/);
});

test("Fal billing authority is fail-closed and never caches an allow decision", () => {
  assert.match(
    source,
    /if \(!adminKey\)[\s\S]*?ok:\s*false[\s\S]*?missing_admin_key/,
  );
  for (const reason of [
    "billing_http_error",
    "billing_body_invalid",
    "billing_json_invalid",
    "billing_balance_invalid",
    "billing_unavailable",
  ]) {
    assert.match(source, new RegExp(`ok:\\s*false[\\s\\S]*?${reason}`));
  }
  assert.match(source, /cachedDenial/);
  assert.doesNotMatch(source, /cached(?:Allow|Success)/);
  assert.match(
    source,
    /return \{ ok: true, balance, checkedAt: now \}/,
  );
});

