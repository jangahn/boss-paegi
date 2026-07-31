import assert from "node:assert/strict";
import test from "node:test";
import { createServerClient } from "@supabase/ssr";
import {
  createServerAuthReadFetch,
} from "../../lib/http/server-auth-read-fetch.ts";

const SUPABASE_URL = "https://project.supabase.co";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID =
  "22222222-2222-4222-8222-222222222222";

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString(
    "base64url",
  );
}

function expiredSessionCookie(): string {
  const accessToken = [
    base64UrlJson({ alg: "HS256", typ: "JWT" }),
    base64UrlJson({
      sub: USER_ID,
      session_id: SESSION_ID,
      exp: Math.floor(Date.now() / 1_000) - 60,
    }),
    "signature",
  ].join(".");
  return `base64-${base64UrlJson({
    access_token: accessToken,
    refresh_token: "expired-cookie-refresh-token",
    token_type: "bearer",
    expires_in: 3_600,
    expires_at: Math.floor(Date.now() / 1_000) - 60,
    user: {
      id: USER_ID,
      aud: "authenticated",
      role: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: new Date(0).toISOString(),
    },
  })}`;
}

test("expired SSR auth reads receive one definitive blocked-refresh response", async () => {
  let delegatedCalls = 0;
  let refreshCalls = 0;
  const readOnlyFetch = createServerAuthReadFetch({
    supabaseUrl: SUPABASE_URL,
    fetcher: async () => {
      delegatedCalls += 1;
      throw new Error("the forbidden refresh must not reach Auth");
    },
  });
  const observedFetch: typeof fetch = async (input, init) => {
    const url = new URL(
      input instanceof Request ? input.url : String(input),
    );
    if (
      url.pathname === "/auth/v1/token" &&
      url.searchParams.get("grant_type") === "refresh_token"
    ) {
      refreshCalls += 1;
    }
    return readOnlyFetch(input, init);
  };
  const client = createServerClient(
    SUPABASE_URL,
    "anon-key",
    {
      cookies: {
        getAll: () => [
          {
            name: "sb-project-auth-token",
            value: expiredSessionCookie(),
          },
        ],
        setAll: () => {},
      },
      global: { fetch: observedFetch },
    },
  );

  const originalConsoleError = console.error;
  console.error = () => {};
  let result: Awaited<ReturnType<typeof client.auth.getUser>>;
  try {
    result = await client.auth.getUser();
  } finally {
    console.error = originalConsoleError;
  }
  assert.equal(result.data.user, null);
  assert.equal(result.error?.name, "AuthApiError");
  assert.equal(result.error?.status, 400);
  assert.equal(refreshCalls, 1);
  assert.equal(delegatedCalls, 0);
});

test("only exact GET /auth/v1/user is delegated inside the Auth namespace", async () => {
  const delegated: string[] = [];
  const readOnlyFetch = createServerAuthReadFetch({
    supabaseUrl: SUPABASE_URL,
    fetcher: async (input) => {
      delegated.push(
        input instanceof Request ? input.url : String(input),
      );
      return new Response("{}", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    },
  });

  const allowed = await readOnlyFetch(
    `${SUPABASE_URL}/auth/v1/user`,
    { method: "GET" },
  );
  assert.equal(allowed.status, 200);
  assert.deepEqual(delegated, [
    `${SUPABASE_URL}/auth/v1/user`,
  ]);

  for (const [url, method] of [
    [`${SUPABASE_URL}/auth/v1/user?extra=1`, "GET"],
    [`${SUPABASE_URL}/auth/v1/user`, "POST"],
    [
      `${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`,
      "POST",
    ],
    [`${SUPABASE_URL}/auth/v1/logout`, "POST"],
  ] as const) {
    const blocked = await readOnlyFetch(url, { method });
    assert.equal(blocked.status, 400, `${method} ${url}`);
    assert.equal(
      blocked.headers.get("cache-control"),
      "private, no-store, max-age=0",
    );
    assert.deepEqual(await blocked.json(), {
      error: "server_auth_session_mutation_blocked",
      error_description:
        "server auth session mutation blocked",
    });
  }
  assert.equal(delegated.length, 1);
});
