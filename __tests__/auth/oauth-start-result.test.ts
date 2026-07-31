import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  parsePrepareSignupActiveConflict,
  parsePrepareSignupAck,
  parseOAuthStartUrl,
} from "../../lib/oauth-start-result.ts";

const FLOW_ID = "11111111-1111-4111-8111-111111111111";
const SUPABASE_URL = "https://project.supabase.co";
const REDIRECT_TO =
  "https://boss.example/auth/callback" +
  `?next=%2Fgallery&p=google&flow=${FLOW_ID}`;
const CODE_CHALLENGE =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const VALID_URL =
  `${SUPABASE_URL}/auth/v1/authorize` +
  `?provider=google&redirect_to=${encodeURIComponent(REDIRECT_TO)}` +
  `&code_challenge=${CODE_CHALLENGE}` +
  "&code_challenge_method=s256&prompt=select_account" +
  "&skip_http_redirect=true";

test("prepare-signup HTTP body는 exact flow-bound ack만 승인한다", () => {
  assert.equal(
    parsePrepareSignupAck(
      { ok: true, flowId: FLOW_ID },
      FLOW_ID,
    ),
    FLOW_ID,
  );
  for (const malformed of [
    null,
    {},
    { ok: false },
    { ok: 1 },
    { ok: true },
    { ok: true, flowId: "22222222-2222-4222-8222-222222222222" },
    { ok: true, flowId: FLOW_ID, extra: true },
  ]) {
    assert.equal(
      parsePrepareSignupAck(malformed, FLOW_ID),
      null,
    );
  }
});

test("prepare-signup active-flow conflict는 exact error receipt만 승인한다", () => {
  assert.equal(
    parsePrepareSignupActiveConflict({
      error: "oauth_flow_already_active",
    }),
    true,
  );
  for (const malformed of [
    null,
    {},
    { error: "oauth_flow_already_active", flowId: FLOW_ID },
    { error: "oauth_flow_already_active", extra: true },
    { error: "auth_unavailable" },
  ]) {
    assert.equal(
      parsePrepareSignupActiveConflict(malformed),
      false,
    );
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
        codeChallenge: CODE_CHALLENGE,
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
          codeChallenge: CODE_CHALLENGE,
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
        codeChallenge: CODE_CHALLENGE,
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
  assert.match(
    source,
    /parsePrepareSignupAck\([\s\S]*?flowId/,
  );
  assert.match(
    source,
    /const prepareBody = JSON\.stringify\([\s\S]*?body: prepareBody,[\s\S]*?attempt: prepare,[\s\S]*?reconcile: prepare/,
  );
  assert.match(
    source,
    /prepared\.status === 409[\s\S]*?parsePrepareSignupActiveConflict\(parsed\.value\)[\s\S]*?OAuthExistingFlowConflictError[\s\S]*?clearOAuthFlowBrowserBarrier\(flowId\)[\s\S]*?window\.location\.replace\("\/auth\/flow-pending"\)[\s\S]*?return;[\s\S]*?cancelOAuthFlowLease/,
  );
});
