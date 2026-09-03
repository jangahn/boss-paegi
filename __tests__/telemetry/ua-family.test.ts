import assert from "node:assert/strict";
import test from "node:test";
import { uaFamily } from "../../lib/telemetry/ua-family.ts";

test("ua family folds user agents into a low-cardinality diagnostic set", () => {
  assert.equal(uaFamily(null), "none");
  assert.equal(uaFamily(""), "none");
  assert.equal(
    uaFamily("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/150.0.0.0 Safari/537.36"),
    "headless",
  );
  assert.equal(
    uaFamily("Mozilla/5.0 (Linux; Android 14; SM-S911N Build/UP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/151.0.0.0 Mobile Safari/537.36"),
    "webview",
  );
  assert.equal(
    uaFamily("Mozilla/5.0 (Linux; Android 13; SM-G991N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Mobile Safari/537.36 KAKAOTALK/10.9.5"),
    "kakao",
  );
  assert.equal(
    uaFamily("Mozilla/5.0 (Linux; Android 14; SM-S908N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Whale/1.0.0.0 Mobile Safari/537.36"),
    "whale",
  );
  assert.equal(
    uaFamily("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/28.0 Chrome/130.0.0.0 Mobile Safari/537.36"),
    "samsung",
  );
  assert.equal(
    uaFamily("Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Mobile Safari/537.36 OPR/101.0.0.0"),
    "opera",
  );
  assert.equal(
    uaFamily("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"),
    "chrome",
  );
  assert.equal(
    uaFamily("Mozilla/5.0 (iPhone; CPU iPhone OS 18_7 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.6 Mobile/15E148 Safari/604.1"),
    "safari",
  );
  assert.equal(uaFamily("curl/8.4.0"), "other");
});
