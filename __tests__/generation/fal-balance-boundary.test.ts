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

test("Fal billing lookup failures degrade gracefully instead of blocking", () => {
  // 2026-07-31 제품 결정: 잔액 체크 실패가 생성을 죽이면 안 된다.
  assert.match(source, /if \(!adminKey\) return \{ ok: true, balance: null \}/);
  assert.match(source, /log\.warn\("falbal\.api_error"[\s\S]*?return \{ ok: true, balance: null \}/);
  assert.match(source, /log\.warn\("falbal\.check_fail"[\s\S]*?return \{ ok: true, balance: null \}/);
  // 60초 캐시는 허용·차단 양방향 모두 사용한다.
  assert.match(source, /CACHE_TTL_MS = 60_000/);
  assert.match(source, /cached = \{ balance, at: now \}/);
  // 임계 미달은 여전히 차단한다.
  assert.match(source, /balance < HARD_CAP_USD/);
});
