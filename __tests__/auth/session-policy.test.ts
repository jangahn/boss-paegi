import test from "node:test";
import assert from "node:assert/strict";
import {
  requireAnonymousSignInSession,
  requireSuccessfulSessionRead,
} from "../../lib/auth-session-policy.ts";

test("getSession resolved error is not downgraded to a missing session", () => {
  const injected = new Error("session storage unavailable");
  assert.throws(
    () =>
      requireSuccessfulSessionRead({
        data: { session: null },
        error: injected,
      }),
    (error) => error === injected,
  );
});

test("only a successful null session authorizes anonymous bootstrap", () => {
  assert.equal(
    requireSuccessfulSessionRead({ data: { session: null }, error: null }),
    null,
  );
  const session = { user: { id: "anon" } };
  assert.equal(
    requireSuccessfulSessionRead({ data: { session }, error: null }),
    session,
  );
});

test("anonymous sign-in requires a concrete session and propagates errors", () => {
  const injected = new Error("anonymous sign-in failed");
  assert.throws(
    () =>
      requireAnonymousSignInSession({
        data: { session: { user: { id: "unexpected" } } },
        error: injected,
      }),
    (error) => error === injected,
  );
  assert.throws(
    () =>
      requireAnonymousSignInSession({
        data: { session: null },
        error: null,
      }),
    /anonymous_sign_in_missing_session/,
  );
});
