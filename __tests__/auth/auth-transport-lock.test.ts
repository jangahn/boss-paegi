import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  AUTH_TRANSPORT_MAX_RESPONSE_BYTES,
  createAuthTransportFetch,
} from "../../lib/http/auth-transport-fetch.ts";

const SUPABASE_URL = "https://transport-proof.supabase.co";
const AUTH_URL = `${SUPABASE_URL}/auth/v1/user`;

function nextTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function messageIs(expected: string) {
  return (error: unknown) =>
    error instanceof Error && error.message === expected;
}

test("Auth transport composes a Request.signal even without init", async () => {
  const owner = new AbortController();
  let observed: AbortSignal | null = null;
  const fetcher = ((
    _input: RequestInfo | URL,
    init?: RequestInit,
  ) =>
    new Promise<Response>((_resolve, reject) => {
      observed = init?.signal ?? null;
      init?.signal?.addEventListener(
        "abort",
        () => reject(init.signal?.reason),
        { once: true },
      );
    })) as typeof fetch;
  const wrapped = createAuthTransportFetch({
    supabaseUrl: SUPABASE_URL,
    fetcher,
  });
  const request = new Request(AUTH_URL, {
    signal: owner.signal,
  });
  const pending = wrapped(request);

  assert.ok(observed);
  assert.notEqual(observed, request.signal);
  const reason = new Error("request_owner_disposed");
  owner.abort(reason);
  await assert.rejects(
    pending,
    (error: unknown) => error === reason,
  );
  assert.equal(
    (observed as AbortSignal | null)?.aborted,
    true,
  );
});

test("Auth transport handles a synchronous deadline and cancels its returned scheduler", async () => {
  let fetchCalls = 0;
  let cancellations = 0;
  const wrapped = createAuthTransportFetch({
    supabaseUrl: SUPABASE_URL,
    fetcher: (() => {
      fetchCalls += 1;
      return Promise.resolve(new Response());
    }) as typeof fetch,
    schedule: (expire) => {
      expire();
      return () => {
        cancellations += 1;
      };
    },
  });

  await assert.rejects(
    wrapped(AUTH_URL),
    messageIs("auth_transport_timeout"),
  );
  assert.equal(fetchCalls, 0);
  assert.equal(cancellations, 1);
});

test("Auth transport rejects an invalid deadline scheduler before fetch", async () => {
  let fetchCalls = 0;
  const wrapped = createAuthTransportFetch({
    supabaseUrl: SUPABASE_URL,
    fetcher: (() => {
      fetchCalls += 1;
      return Promise.resolve(new Response());
    }) as typeof fetch,
    schedule: (() => undefined) as never,
  });

  await assert.rejects(
    wrapped(AUTH_URL),
    messageIs("invalid_auth_transport_scheduler"),
  );
  assert.equal(fetchCalls, 0);
});

test("Auth transport hard deadline aborts an in-flight fetch and cancels the timer", async () => {
  let expire!: () => void;
  let cancellations = 0;
  let observed: AbortSignal | null = null;
  const wrapped = createAuthTransportFetch({
    supabaseUrl: SUPABASE_URL,
    timeoutMs: 37,
    schedule: (callback, delayMs) => {
      assert.equal(delayMs, 37);
      expire = callback;
      return () => {
        cancellations += 1;
      };
    },
    fetcher: ((
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) =>
      new Promise<Response>((_resolve, reject) => {
        observed = init?.signal ?? null;
        init?.signal?.addEventListener(
          "abort",
          () => reject(init.signal?.reason),
          { once: true },
        );
      })) as typeof fetch,
  });
  const pending = wrapped(AUTH_URL);

  assert.ok(observed);
  expire();
  await assert.rejects(
    pending,
    messageIs("auth_transport_timeout"),
  );
  assert.equal(
    (observed as AbortSignal | null)?.aborted,
    true,
  );
  assert.equal(cancellations, 1);
});

test("Auth transport drains and reconstructs the entire response before releasing its deadline", async () => {
  const encoder = new TextEncoder();
  let body!: ReadableStreamDefaultController<Uint8Array>;
  let cancellations = 0;
  let settled = false;
  const wrapped = createAuthTransportFetch({
    supabaseUrl: SUPABASE_URL,
    schedule: () => () => {
      cancellations += 1;
    },
    fetcher: (async () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            body = controller;
            controller.enqueue(encoder.encode('{"part":'));
          },
        }),
        {
          status: 202,
          statusText: "Accepted",
          headers: {
            "content-encoding": "gzip",
            "content-length": "64",
            "content-type": "application/json",
            "x-proof": "preserved",
          },
        },
      )) as typeof fetch,
  });
  const pending = wrapped(AUTH_URL).then((response) => {
    settled = true;
    return response;
  });

  await nextTurn();
  assert.equal(settled, false);
  assert.equal(cancellations, 0);
  body.enqueue(encoder.encode("true}"));
  body.close();

  const response = await pending;
  assert.equal(await response.text(), '{"part":true}');
  assert.equal(response.status, 202);
  assert.equal(response.statusText, "Accepted");
  assert.equal(response.headers.get("x-proof"), "preserved");
  assert.equal(response.headers.get("content-encoding"), null);
  assert.equal(response.headers.get("content-length"), null);
  assert.equal(cancellations, 1);
});

test("Auth transport enforces its response cap before returning SDK-visible bytes", async () => {
  const wrapped = createAuthTransportFetch({
    supabaseUrl: SUPABASE_URL,
    fetcher: (async () =>
      new Response("x", {
        headers: {
          "content-length": String(
            AUTH_TRANSPORT_MAX_RESPONSE_BYTES + 1,
          ),
        },
      })) as typeof fetch,
  });

  await assert.rejects(
    wrapped(AUTH_URL),
    messageIs("auth_response_too_large"),
  );
});

test("Non-Auth requests preserve the original signal and Response identity", async () => {
  const owner = new AbortController();
  const expected = new Response("rest");
  let observed: AbortSignal | null = null;
  const wrapped = createAuthTransportFetch({
    supabaseUrl: SUPABASE_URL,
    fetcher: (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      observed = init?.signal ?? null;
      return expected;
    }) as typeof fetch,
  });

  const actual = await wrapped(
    `${SUPABASE_URL}/rest/v1/profiles`,
    { signal: owner.signal },
  );
  assert.equal(actual, expected);
  assert.equal(observed, owner.signal);
});

test("A non-OK Auth response is rejected only when the exact auth cookie changes while its body drains", async () => {
  const descriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  let cookie =
    "unrelated=before; sb-transport-proof-auth-token.0=old";
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      get cookie() {
        return cookie;
      },
    },
  });
  try {
    const encoder = new TextEncoder();
    let firstBody!: ReadableStreamDefaultController<Uint8Array>;
    let responseNumber = 0;
    const wrapped = createAuthTransportFetch({
      supabaseUrl: SUPABASE_URL,
      fetcher: (async () => {
        responseNumber += 1;
        if (responseNumber === 1) {
          return new Response('{"error":"first"}', {
            status: 401,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              firstBody = controller;
            },
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" },
          },
        );
      }) as typeof fetch,
    });

    const unrelatedChange = wrapped(AUTH_URL);
    cookie =
      "unrelated=after; sb-transport-proof-auth-token.0=old";
    assert.equal((await unrelatedChange).status, 401);

    const authCookieChange = wrapped(AUTH_URL);
    await nextTurn();
    cookie =
      "unrelated=after; sb-transport-proof-auth-token.0=new";
    firstBody.enqueue(encoder.encode('{"error":"stale"}'));
    firstBody.close();
    await assert.rejects(
      authCookieChange,
      messageIs("auth_session_changed_during_request"),
    );
  } finally {
    if (descriptor) {
      Object.defineProperty(globalThis, "document", descriptor);
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
});

test("Installed auth-js writers and refresh paths hold the exact non-stealing SDK lock", () => {
  const script = String.raw`
    const active = new Map();
    const tails = new Map();
    const lockRequests = [];
    let maxDepth = 0;
    const lockManager = {
      request(name, options, callback) {
        if (options?.signal?.aborted) {
          return Promise.reject(
            options.signal.reason ?? new DOMException("Aborted", "AbortError")
          );
        }
        if (options?.ifAvailable && (active.get(name) ?? 0) > 0) {
          return Promise.resolve(callback(null));
        }
        const prior = tails.get(name) ?? Promise.resolve();
        const running = prior.then(async () => {
          if (options?.signal?.aborted) {
            throw options.signal.reason ??
              new DOMException("Aborted", "AbortError");
          }
          const depth = (active.get(name) ?? 0) + 1;
          active.set(name, depth);
          maxDepth = Math.max(maxDepth, depth);
          lockRequests.push(name);
          try {
            return await callback({ name, mode: "exclusive" });
          } finally {
            if (depth === 1) active.delete(name);
            else active.set(name, depth - 1);
          }
        });
        tails.set(name, running.then(() => undefined, () => undefined));
        return running;
      }
    };
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { locks: lockManager }
    });
    globalThis.document = {
      visibilityState: "hidden",
      cookie: ""
    };
    globalThis.window = {
      document: globalThis.document,
      localStorage: {
        getItem() { return null; },
        setItem() {},
        removeItem() {}
      },
      location: {
        href: "https://app.example.test/",
        origin: "https://app.example.test",
        assign() {}
      },
      addEventListener() {},
      removeEventListener() {}
    };
    globalThis.BroadcastChannel = class {
      addEventListener() {}
      removeEventListener() {}
      postMessage() {}
      close() {}
    };

    const [
      { createClient },
      { failClosedSupabaseAuthLock },
      { createAuthTransportFetch }
    ] =
      await Promise.all([
        import("@supabase/supabase-js"),
        import("./lib/auth-cross-context.ts"),
        import("./lib/http/auth-transport-fetch.ts")
      ]);
    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const jwt = (subject, expiresAt) =>
      encode({ alg: "none", typ: "JWT" }) + "." +
      encode({ sub: subject, exp: expiresAt, aud: "authenticated" }) +
      ".signature";
    const user = (id, anonymous = false) => ({
      id,
      aud: "authenticated",
      role: "authenticated",
      app_metadata: {},
      user_metadata: {},
      identities: [],
      created_at: "2026-01-01T00:00:00.000Z",
      is_anonymous: anonymous
    });
    const session = (id, access, refresh, anonymous = false) => ({
      access_token: access,
      refresh_token: refresh,
      expires_in: 3600,
      expires_at: Math.floor(Date.now() / 1000) + 3600,
      token_type: "bearer",
      user: user(id, anonymous)
    });
    const makeStorage = (initial = {}) => {
      const values = new Map(Object.entries(initial));
      const writes = [];
      return {
        values,
        writes,
        adapter: {
          getItem(key) {
            return values.get(key) ?? null;
          },
          setItem(key, value) {
            writes.push({
              key,
              held: Array.from(active.keys())
            });
            values.set(key, value);
          },
          removeItem(key) {
            writes.push({
              key,
              held: Array.from(active.keys()),
              removed: true
            });
            values.delete(key);
          }
        }
      };
    };
    const authOptions = (storage, storageKey) => ({
      storage,
      storageKey,
      persistSession: true,
      autoRefreshToken: false,
      detectSessionInUrl: false,
      flowType: "pkce",
      lock: failClosedSupabaseAuthLock,
      lockAcquireTimeout: -1
    });

    const writerStorageKey = "sb-sdk-writer-auth-token";
    const writerLock = "lock:" + writerStorageKey;
    const writerStorage = makeStorage();
    const writerFetchHeld = [];
    const writerClient = createClient(
      "https://sdk-writer.supabase.co",
      "public-anon-key",
      {
        auth: authOptions(writerStorage.adapter, writerStorageKey),
        global: {
          fetch: async (input) => {
            const url = String(input);
            writerFetchHeld.push({
              url,
              held: (active.get(writerLock) ?? 0) === 1
            });
            const anonymous = url.endsWith("/signup");
            const current = anonymous
              ? session("anonymous-user", "anon-access", "anon-refresh", true)
              : session("member-user", "member-access", "member-refresh");
            return new Response(JSON.stringify({
              ...current,
              user: current.user
            }), {
              status: 200,
              headers: { "content-type": "application/json" }
            });
          }
        }
      }
    );
    await writerClient.auth.initialize();
    lockRequests.length = 0;
    writerStorage.writes.length = 0;
    const anonymousResult = await failClosedSupabaseAuthLock(
      writerLock,
      -1,
      () => writerClient.auth.signInAnonymously()
    );
    const passwordResult = await failClosedSupabaseAuthLock(
      writerLock,
      -1,
      () => writerClient.auth.signInWithPassword({
        email: "reviewer@example.test",
        password: "not-a-secret"
      })
    );
    const oauthResult = await failClosedSupabaseAuthLock(
      writerLock,
      -1,
      () => writerClient.auth.signInWithOAuth({
        provider: "google",
        options: {
          redirectTo: "https://app.example.test/auth/callback",
          skipBrowserRedirect: true
        }
      })
    );
    const writerLockRequests = lockRequests.splice(0);
    const writerWritesHeld = writerStorage.writes.map((write) => ({
      codeVerifier: write.key.endsWith("-code-verifier"),
      held: write.held.includes(writerLock)
    }));

    const runRefresh = async (kind) => {
      const storageKey = "sb-sdk-refresh-" + kind + "-auth-token";
      const lockName = "lock:" + storageKey;
      const expired = {
        ...session(
          "expired-user",
          jwt("expired-user", Math.floor(Date.now() / 1000) - 60),
          "old-refresh"
        ),
        expires_at: Math.floor(Date.now() / 1000) - 60
      };
      const storage = makeStorage({
        [storageKey]: JSON.stringify(expired)
      });
      const fetchHeld = [];
      const client = createClient(
        "https://sdk-refresh-" + kind + ".supabase.co",
        "public-anon-key",
        {
          auth: authOptions(storage.adapter, storageKey),
          global: {
            fetch: async (input) => {
              fetchHeld.push({
                url: String(input),
                held: (active.get(lockName) ?? 0) === 1
              });
              if (kind === "success") {
                const refreshed = session(
                  "expired-user",
                  "new-access",
                  "new-refresh"
                );
                return new Response(JSON.stringify({
                  ...refreshed,
                  user: refreshed.user
                }), {
                  status: 200,
                  headers: { "content-type": "application/json" }
                });
              }
              return new Response(JSON.stringify({
                error: "invalid_grant",
                error_description: "refresh rejected"
              }), {
                status: 400,
                headers: { "content-type": "application/json" }
              });
            }
          }
        }
      );
      await client.auth.initialize();
      const result = await client.auth.getSession();
      const requests = lockRequests.splice(0);
      const stored = storage.values.get(storageKey);
      await client.auth.dispose();
      return {
        lockName,
        requests,
        fetchHeld,
        writesHeld: storage.writes.map((write) =>
          write.held.includes(lockName)
        ),
        sessionAccess: result.data.session?.access_token ?? null,
        error: result.error?.message ?? null,
        stored: stored ? JSON.parse(stored).access_token : null
      };
    };
    const refreshSuccess = await runRefresh("success");
    const refreshFailure = await runRefresh("failure");

    const staleStorageKey = "sb-sdk-stale-auth-token";
    const staleLockName = "lock:" + staleStorageKey;
    const staleExpired = {
      ...session(
        "stale-user",
        jwt("stale-user", Math.floor(Date.now() / 1000) - 60),
        "stale-refresh"
      ),
      expires_at: Math.floor(Date.now() / 1000) - 60
    };
    const staleStorage = makeStorage({
      [staleStorageKey]: JSON.stringify(staleExpired)
    });
    document.cookie = staleStorageKey + "=old-cookie";
    let staleBody;
    let markStaleFetchStarted;
    const staleFetchStarted = new Promise((resolve) => {
      markStaleFetchStarted = resolve;
    });
    const staleFetchHeld = [];
    const staleTransport = createAuthTransportFetch({
      supabaseUrl: "https://sdk-stale.supabase.co",
      fetcher: async (input) => {
        staleFetchHeld.push({
          url: String(input),
          held: (active.get(staleLockName) ?? 0) === 1
        });
        return new Response(
          new ReadableStream({
            start(controller) {
              staleBody = controller;
              markStaleFetchStarted();
            }
          }),
          {
            status: 401,
            headers: { "content-type": "application/json" }
          }
        );
      }
    });
    const staleClient = createClient(
      "https://sdk-stale.supabase.co",
      "public-anon-key",
      {
        auth: authOptions(
          staleStorage.adapter,
          staleStorageKey
        ),
        global: { fetch: staleTransport }
      }
    );
    await staleClient.auth.initialize();
    const stalePending = staleClient.auth.getSession();
    await staleFetchStarted;
    const newerSession = session(
      "newer-member",
      "newer-access",
      "newer-refresh"
    );
    staleStorage.values.set(
      staleStorageKey,
      JSON.stringify(newerSession)
    );
    document.cookie = staleStorageKey + "=new-cookie";
    const originalDateNow = Date.now;
    Date.now = () => originalDateNow() + 60_000;
    try {
      staleBody.enqueue(
        new TextEncoder().encode(
          '{"error":"stale refresh rejected"}'
        )
      );
      staleBody.close();
      const staleResult = await stalePending;
      var staleProof = {
        requests: lockRequests.splice(0),
        lockName: staleLockName,
        fetchHeld: staleFetchHeld,
        resultSession: staleResult.data.session?.access_token ?? null,
        error: staleResult.error?.message ?? null,
        stored: JSON.parse(
          staleStorage.values.get(staleStorageKey)
        ).access_token
      };
    } finally {
      Date.now = originalDateNow;
    }
    await staleClient.auth.dispose();
    await writerClient.auth.dispose();

    process.stdout.write(JSON.stringify({
      anonymousError: anonymousResult.error?.message ?? null,
      passwordError: passwordResult.error?.message ?? null,
      oauthError: oauthResult.error?.message ?? null,
      oauthUrl: oauthResult.data.url,
      writerLock,
      writerLockRequests,
      writerFetchHeld,
      writerWritesHeld,
      refreshSuccess,
      refreshFailure,
      staleProof,
      maxDepth
    }));
  `;
  const result = spawnSync(
    process.execPath,
    [
      "--experimental-strip-types",
      "--input-type=module",
      "-e",
      script,
    ],
    {
      cwd: new URL("../..", import.meta.url),
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  const proof = JSON.parse(result.stdout) as {
    anonymousError: string | null;
    passwordError: string | null;
    oauthError: string | null;
    oauthUrl: string | null;
    writerLock: string;
    writerLockRequests: string[];
    writerFetchHeld: Array<{ url: string; held: boolean }>;
    writerWritesHeld: Array<{
      codeVerifier: boolean;
      held: boolean;
    }>;
    refreshSuccess: {
      lockName: string;
      requests: string[];
      fetchHeld: Array<{ url: string; held: boolean }>;
      writesHeld: boolean[];
      sessionAccess: string | null;
      error: string | null;
      stored: string | null;
    };
    refreshFailure: {
      lockName: string;
      requests: string[];
      fetchHeld: Array<{ url: string; held: boolean }>;
      writesHeld: boolean[];
      sessionAccess: string | null;
      error: string | null;
      stored: string | null;
    };
    staleProof: {
      lockName: string;
      requests: string[];
      fetchHeld: Array<{ url: string; held: boolean }>;
      resultSession: string | null;
      error: string | null;
      stored: string | null;
    };
    maxDepth: number;
  };

  assert.equal(proof.anonymousError, null);
  assert.equal(proof.passwordError, null);
  assert.equal(proof.oauthError, null);
  assert.match(
    proof.oauthUrl ?? "",
    /^https:\/\/sdk-writer\.supabase\.co\/auth\/v1\/authorize\?/,
  );
  assert.deepEqual(proof.writerLockRequests, [
    proof.writerLock,
    proof.writerLock,
    proof.writerLock,
  ]);
  assert.equal(
    proof.writerFetchHeld.every(({ held }) => held),
    true,
  );
  assert.equal(
    proof.writerWritesHeld.every(({ held }) => held),
    true,
  );
  assert.equal(
    proof.writerWritesHeld.some(
      ({ codeVerifier }) => codeVerifier,
    ),
    true,
  );

  assert.deepEqual(proof.refreshSuccess.requests, [
    proof.refreshSuccess.lockName,
    proof.refreshSuccess.lockName,
  ], JSON.stringify(proof.refreshSuccess));
  assert.equal(
    proof.refreshSuccess.fetchHeld.every(({ held }) => held),
    true,
  );
  assert.equal(
    proof.refreshSuccess.writesHeld.every(Boolean),
    true,
  );
  assert.equal(proof.refreshSuccess.sessionAccess, "new-access");
  assert.equal(proof.refreshSuccess.error, null);
  assert.equal(proof.refreshSuccess.stored, "new-access");

  assert.deepEqual(proof.refreshFailure.requests, [
    proof.refreshFailure.lockName,
    proof.refreshFailure.lockName,
  ], JSON.stringify(proof.refreshFailure));
  assert.equal(
    proof.refreshFailure.fetchHeld.every(({ held }) => held),
    true,
  );
  assert.equal(
    proof.refreshFailure.writesHeld.every(Boolean),
    true,
  );
  assert.equal(proof.refreshFailure.sessionAccess, null);
  assert.match(proof.refreshFailure.error ?? "", /refresh rejected/i);
  assert.equal(proof.refreshFailure.stored, null);

  assert.deepEqual(proof.staleProof.requests, [
    proof.staleProof.lockName,
    proof.staleProof.lockName,
  ]);
  assert.equal(
    proof.staleProof.fetchHeld.every(({ held }) => held),
    true,
  );
  assert.equal(proof.staleProof.resultSession, null);
  assert.match(
    proof.staleProof.error ?? "",
    /auth_session_changed_during_request/,
  );
  assert.equal(proof.staleProof.stored, "newer-access");
  assert.equal(proof.maxDepth, 1);
});
