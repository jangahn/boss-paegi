import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServerClient } from "@supabase/ssr";
import { parseServerSignOutAck } from "../../lib/signout-policy.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID = "22222222-2222-4222-8222-222222222222";

test("server signout acknowledgement is exact", () => {
  const ack = {
    ok: true,
    flowId: null,
    userId: USER_ID,
    sessionId: SESSION_ID,
  };
  assert.equal(parseServerSignOutAck(ack), true);
  assert.equal(
    parseServerSignOutAck(ack, {
      flowId: null,
      userId: USER_ID,
      sessionId: SESSION_ID,
    }),
    true,
  );
  for (const value of [
    null,
    {},
    { ok: true },
    { ok: false },
    { ok: 1 },
    { ...ack, flowId: 1 },
    { ...ack, userId: null },
    { ...ack, sessionId: null },
    { ...ack, extra: true },
  ]) {
    assert.equal(parseServerSignOutAck(value), false);
  }
  assert.equal(
    parseServerSignOutAck(ack, {
      flowId: null,
      userId: USER_ID,
      sessionId:
        "33333333-3333-4333-8333-333333333333",
    }),
    false,
  );
});

const AUTH_COOKIE_NAME = "sb-test-auth-token";
const TEST_SESSION = {
  access_token: "header.payload.signature",
  refresh_token: "refresh-token",
  token_type: "bearer",
  expires_in: 3600,
  expires_at: Math.floor(Date.now() / 1000) + 3600,
  user: {
    id: "00000000-0000-4000-8000-000000000001",
    aud: "authenticated",
    role: "authenticated",
    email: "qa@example.com",
    app_metadata: {},
    user_metadata: {},
    created_at: new Date(0).toISOString(),
  },
};

async function runInstalledSdkSignOut(args: {
  cookie?: boolean;
  fetcher: typeof fetch;
}) {
  const writes: Array<{
    name: string;
    value: string;
    options?: { maxAge?: number };
  }> = [];
  const client = createServerClient(
    "https://test.supabase.co",
    "anon-key",
    {
      cookieEncoding: "raw",
      cookies: {
        getAll: () =>
          args.cookie === false
            ? []
            : [
                {
                  name: AUTH_COOKIE_NAME,
                  value: JSON.stringify(TEST_SESSION),
                },
              ],
        setAll: (cookies) => {
          writes.push(...cookies);
        },
      },
      global: { fetch: args.fetcher },
    },
  );
  const result = await client.auth.signOut({ scope: "local" });
  return { result, writes };
}

test("installed Supabase local cleanup preserves cookies on revoke failure", async () => {
  for (const status of [429, 500, 502, 503, 504]) {
    const { result, writes } = await runInstalledSdkSignOut({
      fetcher: async () =>
        new Response(JSON.stringify({ message: "upstream failed" }), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
    });
    assert.ok(result.error, `HTTP ${status} must remain an error`);
    assert.deepEqual(
      writes,
      [],
      `HTTP ${status} must not stage auth-cookie removal`,
    );
  }

  const originalConsoleError = console.error;
  console.error = () => {};
  try {
    const transportFailure = await runInstalledSdkSignOut({
      fetcher: async () => {
        throw new Error("transport unavailable");
      },
    });
    assert.ok(transportFailure.result.error);
    assert.deepEqual(transportFailure.writes, []);
  } finally {
    console.error = originalConsoleError;
  }
});

test("installed Supabase local cleanup treats success and already-absent sessions as terminal", async () => {
  for (const status of [204, 401, 403, 404]) {
    const { result, writes } = await runInstalledSdkSignOut({
      fetcher: async () =>
        new Response(
          status === 204
            ? null
            : JSON.stringify({ message: "session absent" }),
          {
            status,
            headers: { "Content-Type": "application/json" },
          },
        ),
    });
    assert.equal(result.error, null);
    assert.deepEqual(
      writes.map(({ name, value, options }) => ({
        name,
        value,
        maxAge: options?.maxAge,
      })),
      [{ name: AUTH_COOKIE_NAME, value: "", maxAge: 0 }],
    );
  }

  let called = false;
  const absent = await runInstalledSdkSignOut({
    cookie: false,
    fetcher: async () => {
      called = true;
      return new Response(null, { status: 204 });
    },
  });
  assert.equal(absent.result.error, null);
  assert.equal(called, false);
});

test("Route Handler acknowledges only an exact bounded revoke before browser-owned cookie cleanup", () => {
  const server = readFileSync(
    new URL("../../app/api/auth/signout/route.ts", import.meta.url),
    "utf8",
  );
  const handler = server.slice(
    server.indexOf("export async function handleSignoutRequest"),
  );
  const parse = handler.indexOf("const input = parseInput(");
  const raw = handler.indexOf(
    "readSupabaseSessionCookieHeader(",
  );
  const exactSession = handler.indexOf(
    'rawSession.kind !== "present"',
    raw,
  );
  const revoke = handler.indexOf(
    "await revokeSession(rawSession.session.accessToken",
  );
  const success = handler.lastIndexOf(
    "const result = response(",
  );
  const clearMigration = handler.lastIndexOf(
    "clearMigrationCookies(result, request)",
  );
  assert.ok(parse >= 0);
  assert.ok(raw > parse);
  assert.ok(exactSession > raw);
  assert.ok(revoke > exactSession);
  assert.ok(success > revoke);
  assert.ok(clearMigration > success);
  assert.match(server, /SIGNOUT_REVOKE_TIMEOUT_MS = 12_000/);
  assert.match(
    server,
    /"\/auth\/v1\/logout\?scope=local"[\s\S]*?method: "POST"[\s\S]*?authorization: `Bearer \$\{accessToken\}`/,
  );
  assert.match(server, /redirect: "error"/);
  assert.match(
    server,
    /response\.ok \|\|[\s\S]*?isDefinitiveHttpRejectionStatus\(response\.status\)[\s\S]*?isSessionAlreadyAbsentBody\(body\.bytes\)/,
  );
  assert.match(
    server,
    /error\.code === "session_not_found" \|\|[\s\S]*?error\.error_code === "session_not_found"/,
  );
  assert.match(
    handler,
    /AbortSignal\.any\(\[[\s\S]*?request\.signal,[\s\S]*?AbortSignal\.timeout\(SIGNOUT_REVOKE_TIMEOUT_MS\)/,
  );
  const failure = handler.slice(
    handler.indexOf(
      "try {\n    await revokeSession",
    ),
    success,
  );
  assert.match(
    failure,
    /signout_revoke_unavailable[\s\S]*?503[\s\S]*?Retry-After/,
  );
  assert.doesNotMatch(failure, /clearMigrationCookies\(/);
  assert.match(
    handler.slice(success),
    /ok: true,[\s\S]*?flowId: input\.flowId,[\s\S]*?userId: input\.expectedUserId,[\s\S]*?sessionId: input\.expectedSessionId/,
  );
  assert.doesNotMatch(
    server,
    /result\.cookies\.set\([^)]*sb-/,
  );
});

test("client serializes exact server replay before local-only cleanup and redirect", () => {
  const source = readFileSync(
    new URL("../../lib/auth-oauth.ts", import.meta.url),
    "utf8",
  );
  const exactStart = source.indexOf(
    "async function signOutExact",
  );
  const signOutStart = source.indexOf(
    "export async function signOut",
  );
  const signOutSource = source.slice(
    exactStart,
    signOutStart,
  );
  const publicSignOutSource = source.slice(signOutStart);
  const lifecycle = signOutSource.indexOf(
    "runExclusiveAuthLifecycle(",
  );
  const exactAck = signOutSource.indexOf(
    "response.status === 200",
  );
  const serverGuard = signOutSource.indexOf(
    'serverOutcome.kind !== "confirmed"',
  );
  const localOnly = signOutSource.indexOf(
    'auth.signOut({ scope: "local" })',
  );
  const profileClear = signOutSource.indexOf(
    "clearProfileCache()",
  );
  const sentryClear = signOutSource.indexOf(
    "clearSentryIdentity()",
  );
  const redirect = signOutSource.indexOf(
    "clearSentryIdentity()",
  );
  const publicRedirect = publicSignOutSource.indexOf(
    'window.location.href = "/"',
  );
  assert.ok(exactStart >= 0);
  assert.ok(signOutStart >= 0);
  assert.ok(lifecycle >= 0);
  assert.ok(exactAck > lifecycle);
  assert.ok(serverGuard > exactAck);
  assert.ok(localOnly > serverGuard);
  assert.ok(profileClear > localOnly);
  assert.ok(sentryClear > profileClear);
  assert.ok(redirect > profileClear);
  assert.ok(publicRedirect >= 0);
  assert.match(
    publicSignOutSource,
    /await signOutExact\(signal\);[\s\S]*window\.location\.href = "\/"/,
  );
  assert.match(
    signOutSource,
    /attempt: request,[\s\S]*?reconcile: request/,
  );
  assert.match(
    signOutSource,
    /throw new Error\("sign_out_incomplete"\);[\s\S]*?auth\.signOut\(\{ scope: "local" \}\)/,
  );
  assert.doesNotMatch(signOutSource, /auth\.signOut\(\)/);
  assert.doesNotMatch(signOutSource, /resolveSignOutAttempts/);
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
