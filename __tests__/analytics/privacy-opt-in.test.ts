import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { recordTrackEvent } = await import("../../lib/analytics/server.ts");

const SHARE_ROW = {
  kind: "share" as const,
  surface: "game_over" as const,
  target: "score" as const,
  score_tier: 1,
  result: "attempt" as const,
};

test("first-party acquisition collection is exact opt-in in every environment", () => {
  const envSource = readFileSync(
    new URL("../../lib/env.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    envSource,
    /ANALYTICS_ENABLED:\s*process\.env\.NEXT_PUBLIC_ANALYTICS_ENABLED === "1"/,
  );
  assert.doesNotMatch(
    envSource,
    /ANALYTICS_ENABLED:[\s\S]{0,160}NODE_ENV\s*===\s*"production"/,
  );
});

test("server collection gate suppresses even a direct route/RPC caller", async () => {
  let calls = 0;
  const result = await recordTrackEvent(
    SHARE_ROW,
    "anon",
    "0".repeat(64),
    {
      collectionEnabled: false,
      rpc: async () => {
        calls += 1;
        return { data: { accepted: true }, error: null };
      },
    },
  );
  assert.equal(result, null);
  assert.equal(calls, 0);
});

test("explicit opt-in retains the bounded RPC path", async () => {
  let calls = 0;
  const result = await recordTrackEvent(
    SHARE_ROW,
    "anon",
    "0".repeat(64),
    {
      collectionEnabled: true,
      rpc: async () => {
        calls += 1;
        return { data: { accepted: true }, error: null };
      },
    },
  );
  assert.deepEqual(result, { accepted: true });
  assert.equal(calls, 1);
});

test("public track route performs the opt-in check before parsing or identity work", () => {
  const routeSource = readFileSync(
    new URL("../../app/api/track/route.ts", import.meta.url),
    "utf8",
  );
  const gate = routeSource.indexOf("if (!PUBLIC_ENV.ANALYTICS_ENABLED)");
  assert.ok(gate >= 0);
  assert.ok(gate < routeSource.indexOf("readTrackJsonRequest(req)"));
  assert.ok(gate < routeSource.indexOf("createClient()"));
});
