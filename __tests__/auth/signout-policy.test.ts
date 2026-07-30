import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  parseServerSignOutAck,
  resolveSignOutAttempts,
} from "../../lib/signout-policy.ts";

test("server signout acknowledgement is exact", () => {
  assert.equal(parseServerSignOutAck({ ok: true }), true);
  for (const value of [
    null,
    {},
    { ok: false },
    { ok: 1 },
    { ok: true, extra: true },
  ]) {
    assert.equal(parseServerSignOutAck(value), false);
  }
});

test("server cookie clearing is mandatory while local signout is a fallback cleanup", async () => {
  for (const serverOk of [false, true]) {
    for (const localOk of [false, true]) {
      const result = await resolveSignOutAttempts({
        server: async () => ({
          responseOk: serverOk,
          data: serverOk ? { ok: true } : { error: "failed" },
        }),
        local: async () => ({
          error: localOk ? null : new Error("local failed"),
        }),
      });
      assert.equal(result.ok, serverOk);
      assert.equal(result.server.ok, serverOk);
      assert.equal(result.local.ok, localOk);
    }
  }
});

test("malformed/throwing server and local responses never become success", async () => {
  const malformed = await resolveSignOutAttempts({
    server: async () => ({ responseOk: true, data: null }),
    local: async () => ({}),
  });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.server.ok, false);
  assert.equal(malformed.local.ok, false);

  const thrown = await resolveSignOutAttempts({
    server: async () => {
      throw new Error("server transport failed");
    },
    local: async () => {
      throw new Error("local client failed");
    },
  });
  assert.equal(thrown.ok, false);
  assert.equal(thrown.server.ok, false);
  assert.equal(thrown.local.ok, false);
});

test("client redirects and clears identity only after verified server success", () => {
  const source = readFileSync(
    new URL("../../lib/auth-oauth.ts", import.meta.url),
    "utf8",
  );
  const guard = source.indexOf("if (!result.server.ok)");
  const profileClear = source.indexOf("clearProfileCache()", guard);
  const redirect = source.indexOf('window.location.href = "/"', guard);
  assert.ok(guard >= 0);
  assert.ok(profileClear > guard);
  assert.ok(redirect > profileClear);
  assert.doesNotMatch(
    source,
    /auth\/signout"[\s\S]{0,300}\.catch\(\(\) => \{\}\)/,
  );

  const server = readFileSync(
    new URL("../../app/api/auth/signout/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(server, /requireSupabaseSuccess\("auth\.signout_revoke"/);
});

test("all interactive signout surfaces expose retryable failure instead of dropping rejection", () => {
  const accountMenu = readFileSync(
    new URL("../../components/AccountMenu.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    accountMenu,
    /await signOut\(\);[\s\S]*?catch \{[\s\S]*?setSignOutError\(true\)/,
  );
  assert.match(accountMenu, /role="alert"/);

  const consent = readFileSync(
    new URL("../../app/consent/ConsentForm.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    consent,
    /const logout = async[\s\S]*?await signOut\(\);[\s\S]*?catch \{[\s\S]*?setErr\(/,
  );
  assert.doesNotMatch(consent, /onClick=\{\(\) => void signOut\(\)\}/);
});
