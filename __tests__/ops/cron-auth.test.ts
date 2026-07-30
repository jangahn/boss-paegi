import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { cronSecretMatches } = await import("../../lib/ops-auth.ts");
const { discoverOpsRouteNames } = await import("./ops-route-inventory.ts");

test("cron credential comparison accepts only the exact UTF-8 secret", () => {
  const secret = "BP_한글_😀_0123456789abcdef";
  assert.equal(cronSecretMatches(secret, secret), true);
  assert.equal(cronSecretMatches(null, secret), false);
  assert.equal(cronSecretMatches("", secret), false);
  assert.equal(cronSecretMatches(secret, ""), false);

  const units = Array.from(secret);
  for (let index = 0; index < units.length; index += 1) {
    const changed = [...units];
    changed[index] = changed[index] === "x" ? "y" : "x";
    assert.equal(
      cronSecretMatches(changed.join(""), secret),
      false,
      `mutation at code point ${index}`,
    );
  }
  assert.equal(cronSecretMatches(`${secret}x`, secret), false);
  assert.equal(cronSecretMatches(secret.slice(0, -1), secret), false);
  assert.equal(cronSecretMatches("x".repeat(4097), secret), false);
  assert.equal(cronSecretMatches(secret, "x".repeat(4097)), false);
});

test("all scheduler routes use the shared constant-time comparator", () => {
  const routes = discoverOpsRouteNames();
  assert.ok(routes.length > 0, "ops route discovery must not be empty");
  for (const route of routes) {
    const source = readFileSync(
      new URL(
        `../../app/api/ops/${route}/route.ts`,
        import.meta.url,
      ),
      "utf8",
    );
    assert.match(source, /cronSecretMatches\(/, route);
    assert.doesNotMatch(
      source,
      /headers\.get\("x-cron-secret"\)\s*[!=]==?\s*secret/,
      route,
    );
  }
});
