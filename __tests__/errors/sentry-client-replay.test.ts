import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  resolveSentryReplayPolicy,
  sentryReplayIntegrations,
} from "../../lib/sentry-replay-policy.ts";

test("production이 아니면 Replay를 켜지 않는다(exact match — 대소문자·유사값 불인정)", () => {
  for (const environment of [
    "",
    "development",
    "preview",
    "staging",
    "test",
    "Production",
    " production",
    "production ",
  ]) {
    assert.deepEqual(
      resolveSentryReplayPolicy(environment),
      {
        enabled: false,
        replaysOnErrorSampleRate: 0,
        replaysSessionSampleRate: 0,
      },
      `unexpected enable for ${JSON.stringify(environment)}`,
    );
  }
});

test("environment 판정은 변환 없는 strict equality다", () => {
  const policySource = readFileSync(
    new URL("../../lib/sentry-replay-policy.ts", import.meta.url),
    "utf8",
  );

  assert.match(policySource, /environment === "production"/);
  assert.doesNotMatch(
    policySource,
    /environment\??\.(?:trim|toLowerCase|toUpperCase)/,
  );
  // 운영 결정(2026-08-21): env opt-in 게이트는 존재하지 않는다.
  assert.doesNotMatch(policySource, /operationalOptIn|OPT_IN|REPLAY_ENABLED/);
});

test("production은 상시 오류 100%·일반 10% Replay를 활성화한다", () => {
  assert.deepEqual(resolveSentryReplayPolicy("production"), {
    enabled: true,
    replaysOnErrorSampleRate: 1,
    replaysSessionSampleRate: 0.1,
  });
});

test("비활성 정책은 integration factory도 호출하지 않고 빈 목록을 반환한다", () => {
  let calls = 0;
  const integrations = sentryReplayIntegrations(
    resolveSentryReplayPolicy("preview"),
    () => {
      calls += 1;
      return { kind: "replay" };
    },
  );

  assert.deepEqual(integrations, []);
  assert.equal(calls, 0);
});

test("활성 정책만 integration을 정확히 한 번 생성한다", () => {
  let calls = 0;
  const integration = { kind: "replay" };
  const integrations = sentryReplayIntegrations(
    resolveSentryReplayPolicy("production"),
    () => {
      calls += 1;
      return integration;
    },
  );

  assert.deepEqual(integrations, [integration]);
  assert.equal(calls, 1);
});

test("클라이언트 init은 일반 화면의 error·trace·feedback을 유지하고 OAuth callback은 완전 차단한다", () => {
  const source = readFileSync(
    new URL("../../instrumentation-client.ts", import.meta.url),
    "utf8",
  );

  const bootstrap = source.indexOf(
    "callbackGlobals[CALLBACK_BOOTSTRAP_QUERY_KEY] =",
  );
  const nativeScrub = source.indexOf(
    "History.prototype.replaceState.call(",
  );
  const sentryInit = source.indexOf("Sentry.init({");
  assert.ok(bootstrap >= 0);
  assert.ok(nativeScrub > bootstrap);
  assert.ok(
    sentryInit > nativeScrub,
    "callback query capture and native URL scrub must finish before Sentry init",
  );
  assert.match(
    source,
    /window\.location\.pathname === "\/auth\/callback" \|\|[\s\S]*window\.location\.pathname\.startsWith\("\/auth\/callback\/"\)/u,
  );
  assert.match(
    source,
    /window\.location\.hash\.startsWith\("#oauth-callback="\)[\s\S]*callbackQuery = decodeURIComponent\([\s\S]*callbackGlobals\[CALLBACK_BOOTSTRAP_QUERY_KEY\] =\s*callbackQuery;/u,
  );
  assert.match(
    source,
    /History\.prototype\.replaceState\.call\(\s*window\.history,\s*null,\s*"",\s*window\.location\.pathname,\s*\);/u,
  );
  assert.match(
    source,
    /callbackUrlScrubbed =\s*window\.location\.search === "" &&\s*window\.location\.hash === "";/u,
  );
  assert.match(
    source,
    /catch \{[\s\S]*callbackUrlScrubbed = false;/u,
    "native history failures must fail closed",
  );
  assert.match(
    source,
    /if \(dsn && callbackUrlScrubbed && !isOAuthCallbackPage\) \{\s*Sentry\.init\(/u,
  );

  // Replay는 env opt-in 없이 environment 정책만 따른다(2026-08-21 운영 결정).
  assert.doesNotMatch(
    source,
    /NEXT_PUBLIC_SENTRY_REPLAY_ENABLED/,
  );
  assert.match(
    source,
    /const replay = resolveSentryReplayPolicy\(env\);/,
  );
  assert.match(
    source,
    /\.\.\.sentryReplayIntegrations\(replay,\s*\(\) =>[\s\S]*Sentry\.replayIntegration\(/,
  );
  assert.match(source, /Sentry\.feedbackAsyncIntegration\(/);
  assert.match(
    source,
    /tracesSampler: \(ctx\) => \{\s*if \(!isProd \|\| isOAuthCallbackPage\) return 0;/u,
  );
  assert.match(
    source,
    /const target = `\$\{ctx\.name \?\? ""\} \$\{[\s\S]*attributes\["http\.route"\][\s\S]*attributes\["url"\] \?\? attributes\["http\.target"\][\s\S]*return target\.includes\("\/auth\/callback"\) \? 0 : 0\.1;/u,
  );
  assert.match(
    source,
    /replaysOnErrorSampleRate: isOAuthCallbackPage\s*\? 0\s*:\s*replay\.replaysOnErrorSampleRate/u,
  );
  assert.match(
    source,
    /replaysSessionSampleRate: isOAuthCallbackPage\s*\? 0\s*:\s*replay\.replaysSessionSampleRate/u,
  );
  assert.match(
    source,
    /integrations: isOAuthCallbackPage\s*\? \[\]\s*:\s*\[/u,
  );

  assert.match(
    source,
    /const serialized = JSON\.stringify\(value\);[\s\S]*if \(typeof serialized !== "string"\) return true;/u,
  );
  assert.match(
    source,
    /serialized\.includes\("\/auth\/callback"\)[\s\S]*serialized\.toLowerCase\(\)\.includes\(\s*"%2fauth%2fcallback",\s*\)/u,
  );
  assert.match(
    source,
    /function containsOAuthCallback[\s\S]*catch \{\s*return true;\s*\}/u,
  );
  assert.match(
    source,
    /beforeSend\(event\) \{\s*if \(containsOAuthCallback\(event\)\) return null;/u,
  );
  assert.match(
    source,
    /beforeSendTransaction\(event\) \{\s*if \(containsOAuthCallback\(event\)\) return null;/u,
  );
  assert.equal(
    source.match(/req\.url = req\.url\.split\("\?"\)\[0\];/gu)
      ?.length ?? 0,
    2,
  );
  assert.equal(
    source.match(/req\.query_string = undefined;/gu)?.length ?? 0,
    2,
  );
  assert.match(
    source,
    /event\.transaction = event\.transaction\.split\(\/\[\?#\]\/u, 1\)\[0\];/u,
  );
  assert.match(
    source,
    /export const onRouterTransitionStart = Sentry\.captureRouterTransitionStart/,
  );
});
