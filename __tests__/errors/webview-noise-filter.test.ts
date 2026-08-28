import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/**
 * 인앱 웹뷰 주입 스크립트 노이즈 필터(ignoreErrors) 계약 — instrumentation-client.ts 와
 * 여기의 패턴 리터럴을 동일하게 유지한다(둘 중 하나만 바뀌면 소스핀이 깨져 동기화를 강제).
 * 근거: 2026-08-28 Android 15/16 Chrome Mobile WebView 실측 7종 — 전부 `<anonymous>:1`
 * 전역 심볼이고 앱 번들에 해당 전역이 없다(KB known-non-issues #11).
 */
const INJECTED_SYMBOL_PATTERNS = [
  /^(?:onReady|onShow|onHide|selectwords|tapAt|removeHighlight) is not defined$/,
  /^Can't find variable: (?:onReady|onShow|onHide|selectwords|tapAt|removeHighlight)$/,
  /Failed to execute 'appendChild' on 'Node': Identifier/,
];

test("instrumentation-client pins the exact webview-noise ignoreErrors literals", () => {
  const src = readFileSync("instrumentation-client.ts", "utf8");
  assert.ok(src.includes("ignoreErrors:"), "ignoreErrors 선언 존재");
  for (const pattern of INJECTED_SYMBOL_PATTERNS) {
    assert.ok(
      src.includes(pattern.source),
      `ignoreErrors 리터럴 유지: ${pattern.source}`,
    );
  }
});

test("patterns match the observed injected-script wordings and nothing app-shaped", () => {
  const observed = [
    "onReady is not defined",
    "onShow is not defined",
    "onHide is not defined",
    "selectwords is not defined",
    "tapAt is not defined",
    "removeHighlight is not defined",
    "Can't find variable: selectwords",
    "Failed to execute 'appendChild' on 'Node': Identifier 'style' has already been declared",
  ];
  for (const message of observed) {
    assert.ok(
      INJECTED_SYMBOL_PATTERNS.some((p) => p.test(message)),
      `주입 노이즈 매치: ${message}`,
    );
  }
  // 앱이 낼 수 있는 실오류는 절대 걸리면 안 된다.
  const appShaped = [
    "myAppSymbol is not defined",
    "fmtKst is not defined",
    // lib/share 의 textarea appendChild 실패는 Identifier 문구가 아니다.
    "Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.",
    "Hydration failed because the server rendered text didn't match the client.",
  ];
  for (const message of appShaped) {
    assert.ok(
      !INJECTED_SYMBOL_PATTERNS.some((p) => p.test(message)),
      `실오류 미차단: ${message}`,
    );
  }
});
