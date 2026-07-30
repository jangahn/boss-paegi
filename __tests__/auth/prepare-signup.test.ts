import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { decidePrepareSignupUser } from "../../lib/prepare-signup-policy.ts";

const ID = "11111111-1111-4111-8111-111111111111";

test("prepare-signup signs only a concrete exact anonymous Auth user", () => {
  assert.deepEqual(
    decidePrepareSignupUser({
      data: { user: { id: ID, is_anonymous: true } },
      error: null,
    }),
    { ok: true, user: { id: ID, isAnonymous: true } },
  );
  assert.deepEqual(
    decidePrepareSignupUser({
      data: { user: { id: ID, is_anonymous: false } },
      error: null,
    }),
    { ok: true, user: { id: ID, isAnonymous: false } },
  );
});

test("missing/invalid session and dependency failures are distinct failures", () => {
  const missing = decidePrepareSignupUser({
    data: { user: null },
    error: null,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.kind, "unauthorized");

  const invalidSession = { code: "invalid_jwt" };
  assert.deepEqual(
    decidePrepareSignupUser({
      data: { user: null },
      error: invalidSession,
    }),
    { ok: false, kind: "unauthorized", error: invalidSession },
  );

  const dependency = new Error("auth gateway unavailable");
  assert.deepEqual(
    decidePrepareSignupUser({
      data: { user: { id: ID, is_anonymous: true } },
      error: dependency,
    }),
    { ok: false, kind: "unavailable", error: dependency },
  );
});

test("malformed Auth users never authorize cookie creation or skipping it", () => {
  for (const user of [
    {},
    { id: null, is_anonymous: true },
    { id: "not-a-uuid", is_anonymous: true },
    { id: ID },
    { id: ID, is_anonymous: "true" },
    { id: ID, is_anonymous: null },
  ]) {
    const decision = decidePrepareSignupUser({
      data: { user },
      error: null,
    });
    assert.equal(decision.ok, false);
    if (!decision.ok) assert.equal(decision.kind, "unavailable");
  }
});

test("route resolves Auth authority before creating or signing a success response", () => {
  const source = readFileSync(
    new URL("../../app/api/auth/prepare-signup/route.ts", import.meta.url),
    "utf8",
  );
  const getUser = source.indexOf("await supabase.auth.getUser()");
  const decision = source.indexOf("decidePrepareSignupUser(authResult)");
  const success = source.indexOf(
    "const res = NextResponse.json({ ok: true })",
  );
  const sign = source.indexOf("signMigrateValue(decision.user.id)");
  assert.ok(getUser >= 0);
  assert.ok(decision > getUser);
  assert.ok(success > decision);
  assert.ok(sign > success);
  assert.match(source, /kind === "unauthorized" \? 401 : 503/);
  assert.match(source, /catch \(error\)[\s\S]*auth_unavailable/);
});
