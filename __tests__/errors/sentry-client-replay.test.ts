import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  resolveSentryReplayPolicy,
  sentryReplayIntegrations,
} from "../../lib/sentry-replay-policy.ts";

test("production에서도 exact literal 1 외 모든 값은 Replay를 fail-closed한다", () => {
  const nonOptIns = [
    undefined,
    "",
    "0",
    "true",
    "TRUE",
    "yes",
    "on",
    "01",
    "2",
    " 1",
    "1 ",
    "\t1",
    "1\n",
  ] as const;

  for (const value of nonOptIns) {
    assert.deepEqual(
      resolveSentryReplayPolicy("production", value),
      {
        enabled: false,
        replaysOnErrorSampleRate: 0,
        replaysSessionSampleRate: 0,
      },
      `unexpected opt-in for ${JSON.stringify(value)}`,
    );
  }
});

test("opt-in parser는 변환 없는 strict equality여서 임의의 다른 문자열을 승인하지 않는다", () => {
  const policySource = readFileSync(
    new URL("../../lib/sentry-replay-policy.ts", import.meta.url),
    "utf8",
  );

  assert.match(policySource, /operationalOptIn === "1"/);
  assert.doesNotMatch(
    policySource,
    /operationalOptIn\??\.(?:trim|toLowerCase|toUpperCase)|Boolean\(|parseInt\(|Number\(/,
  );

  // A finite grammar probes empty, numeric-looking, boolean-looking, and
  // whitespace-padded values. The source assertion above fixes the universal
  // string property: only the one exact string can pass.
  const alphabet = ["0", "1", " ", "\t", "t", "r", "u", "e"] as const;
  const values = new Set<string>([""]);
  for (let length = 1; length <= 4; length += 1) {
    const build = (prefix: string, remaining: number): void => {
      if (remaining === 0) {
        values.add(prefix);
        return;
      }
      for (const token of alphabet) build(prefix + token, remaining - 1);
    };
    build("", length);
  }
  values.delete("1");

  for (const value of values) {
    assert.equal(
      resolveSentryReplayPolicy("production", value).enabled,
      false,
      `unexpected opt-in for ${JSON.stringify(value)}`,
    );
  }
});

test("exact opt-in도 production이 아니면 Replay를 켜지 않는다", () => {
  for (const environment of [
    "",
    "development",
    "preview",
    "staging",
    "test",
    "Production",
  ]) {
    assert.deepEqual(resolveSentryReplayPolicy(environment, "1"), {
      enabled: false,
      replaysOnErrorSampleRate: 0,
      replaysSessionSampleRate: 0,
    });
  }
});

test("production + exact 1만 오류 100%·일반 10% Replay를 활성화한다", () => {
  assert.deepEqual(resolveSentryReplayPolicy("production", "1"), {
    enabled: true,
    replaysOnErrorSampleRate: 1,
    replaysSessionSampleRate: 0.1,
  });
});

test("비활성 정책은 integration factory도 호출하지 않고 빈 목록을 반환한다", () => {
  let calls = 0;
  const integrations = sentryReplayIntegrations(
    resolveSentryReplayPolicy("production", "0"),
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
    resolveSentryReplayPolicy("production", "1"),
    () => {
      calls += 1;
      return integration;
    },
  );

  assert.deepEqual(integrations, [integration]);
  assert.equal(calls, 1);
});

test("클라이언트 init은 Replay gate와 무관하게 error·trace·feedback을 유지한다", () => {
  const source = readFileSync(
    new URL("../../instrumentation-client.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    source,
    /process\.env\.NEXT_PUBLIC_SENTRY_REPLAY_ENABLED/,
  );
  assert.match(
    source,
    /\.\.\.sentryReplayIntegrations\(replay,\s*\(\) =>[\s\S]*Sentry\.replayIntegration\(/,
  );
  assert.match(source, /Sentry\.feedbackAsyncIntegration\(/);
  assert.match(source, /tracesSampleRate:\s*isProd \? 0\.1 : 0/);
  assert.match(source, /beforeSend\(event\)/);
  assert.match(
    source,
    /export const onRouterTransitionStart = Sentry\.captureRouterTransitionStart/,
  );
});
