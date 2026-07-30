import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isExactPrepareSignupAck,
  parseOAuthStartUrl,
} from "../../lib/oauth-start-result.ts";

const SUPABASE_URL = "https://project.supabase.co";
const REDIRECT_TO =
  "https://boss.example/auth/callback?next=%2Fgallery&p=google";
const VALID_URL =
  `${SUPABASE_URL}/auth/v1/authorize` +
  `?provider=google&redirect_to=${encodeURIComponent(REDIRECT_TO)}` +
  "&skip_http_redirect=true";

test("prepare-signup HTTP body는 exact {ok:true}만 승인한다", () => {
  assert.equal(isExactPrepareSignupAck({ ok: true }), true);
  for (const malformed of [
    null,
    {},
    { ok: false },
    { ok: 1 },
    { ok: true, extra: true },
  ]) {
    assert.equal(isExactPrepareSignupAck(malformed), false);
  }
});

test("OAuth start ack는 provider/Supabase origin/authorize path/redirect를 모두 결속한다", () => {
  assert.equal(
    parseOAuthStartUrl(
      {
        data: { provider: "google", url: VALID_URL },
        error: null,
      },
      {
        provider: "google",
        supabaseUrl: SUPABASE_URL,
        redirectTo: REDIRECT_TO,
      },
    ),
    VALID_URL,
  );

  const attacks = [
    { provider: "kakao", url: VALID_URL },
    { provider: "google", url: VALID_URL.replace("provider=google", "provider=kakao") },
    { provider: "google", url: VALID_URL.replace("project.supabase.co", "evil.example") },
    { provider: "google", url: VALID_URL.replace("/authorize", "/token") },
    { provider: "google", url: VALID_URL.replace("%252Fgallery", "%252Fadmin") },
    { provider: "google", url: "javascript:alert(1)" },
    { provider: "google", url: VALID_URL, extra: true },
  ];
  for (const data of attacks) {
    assert.equal(
      parseOAuthStartUrl(
        { data, error: null },
        {
          provider: "google",
          supabaseUrl: SUPABASE_URL,
          redirectTo: REDIRECT_TO,
        },
      ),
      null,
    );
  }
  assert.equal(
    parseOAuthStartUrl(
      {
        data: { provider: "google", url: VALID_URL },
        error: new Error("resolved dependency failure"),
      },
      {
        provider: "google",
        supabaseUrl: SUPABASE_URL,
        redirectTo: REDIRECT_TO,
      },
    ),
    null,
  );
});

test("OAuth surface는 SDK 자동 navigation을 끄고 검증 후 직접 이동한다", () => {
  const source = readFileSync(
    new URL("../../lib/auth-oauth.ts", import.meta.url),
    "utf8",
  );
  const skip = source.indexOf("skipBrowserRedirect: true");
  const parse = source.indexOf("const oauthUrl = parseOAuthStartUrl");
  const assign = source.indexOf("window.location.assign(oauthUrl)");
  assert.ok(skip >= 0);
  assert.ok(parse > skip);
  assert.ok(assign > parse);
  assert.match(source, /isExactPrepareSignupAck\(preparedAck\)/);
});
