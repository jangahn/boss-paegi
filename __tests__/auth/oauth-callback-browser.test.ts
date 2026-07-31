import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { AuthClient } from "@supabase/supabase-js";
import {
  armOAuthCallbackPkceTransport,
  armOAuthRecoveryRefreshTransport,
  beginOAuthCallbackTransportScope,
  createAuthTransportFetch,
  endOAuthCallbackTransportScope,
  oauthCallbackExchangeSafety,
} from "../../lib/http/auth-transport-fetch.ts";
import {
  isDefinitiveHttpRejectionStatus,
} from "../../lib/http/definitive-http-rejection.ts";

const repositoryRoot = new URL("../..", import.meta.url);
const flowId = "11111111-1111-4111-8111-111111111111";

function jwtFor(userId: string, sessionId: string): string {
  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return (
    `${encode({ alg: "none" })}.` +
    `${encode({
      sub: userId,
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1_000) + 3_600,
    })}.signature`
  );
}

function tokenResponse() {
  const userId = "22222222-2222-4222-8222-222222222222";
  const sessionId =
    "33333333-3333-4333-8333-333333333333";
  const user = {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    is_anonymous: false,
  };
  return {
    access_token: jwtFor(userId, sessionId),
    refresh_token: "refresh-token",
    expires_in: 3_600,
    token_type: "bearer",
    user,
  };
}

test("definitive HTTP rejection classifier exhausts the finite status-code domain", () => {
  for (let status = 0; status <= 999; status += 1) {
    const expected =
      status >= 400 &&
      status < 500 &&
      ![408, 425, 429, 460, 499].includes(status);
    assert.equal(
      isDefinitiveHttpRejectionStatus(status),
      expected,
      String(status),
    );
  }
  for (const malformed of [
    Number.NaN,
    Number.POSITIVE_INFINITY,
    400.5,
    -1,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.equal(
      isDefinitiveHttpRejectionStatus(malformed),
      false,
    );
  }
});

test("PKCE success bytes are withheld until exact target binding is durable", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "https://app.example.test/auth/callback",
        origin: "https://app.example.test",
      },
      localStorage: {
        getItem() {
          return null;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      cookie:
        `boss-paegi-oauth-flow-${flowId}=${flowId}`,
    },
  });
  const responseBody = tokenResponse();
  let releaseBinding!: () => void;
  let markBindingStarted!: () => void;
  const bindingGate = new Promise<void>((resolve) => {
    releaseBinding = resolve;
  });
  const bindingStarted = new Promise<void>((resolve) => {
    markBindingStarted = resolve;
  });
  const evidenceRef: {
    current: {
      userId: string;
      sessionId: string;
      accessTokenDigest: string;
      refreshTokenDigest: string;
    } | null;
  } = { current: null };
  const wrapped = createAuthTransportFetch({
    supabaseUrl: "https://project.supabase.co",
    fetcher: async () =>
      new Response(JSON.stringify(responseBody), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const capability =
    beginOAuthCallbackTransportScope(flowId);
  try {
    await armOAuthCallbackPkceTransport(
      capability,
      "code_123",
      "v".repeat(43),
      async (target) => {
        evidenceRef.current = target;
        markBindingStarted();
        await bindingGate;
      },
    );
    let returned = false;
    const pending = wrapped(
      "https://project.supabase.co/auth/v1/token?grant_type=pkce",
      {
        method: "POST",
        headers: {
          "content-type":
            "application/json;charset=UTF-8",
        },
        body: JSON.stringify({
          auth_code: "code_123",
          code_verifier: "v".repeat(43),
        }),
      },
    ).then((response) => {
      returned = true;
      return response;
    });
    await bindingStarted;
    assert.equal(returned, false);
    assert.ok(evidenceRef.current);
    assert.match(
      evidenceRef.current.accessTokenDigest,
      /^[0-9a-f]{64}$/u,
    );
    assert.match(
      evidenceRef.current.refreshTokenDigest,
      /^[0-9a-f]{64}$/u,
    );
    releaseBinding();
    assert.equal((await pending).status, 200);
    assert.equal(
      oauthCallbackExchangeSafety(capability),
      "ambiguous_or_committed",
    );
  } finally {
    endOAuthCallbackTransportScope(capability);
    if (originalWindow) {
      Object.defineProperty(
        globalThis,
        "window",
        originalWindow,
      );
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    if (originalDocument) {
      Object.defineProperty(
        globalThis,
        "document",
        originalDocument,
      );
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
});

test("PKCE binding accepts Auth-valid users with omitted optional profile fields", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "https://app.example.test/auth/callback",
        origin: "https://app.example.test",
      },
      localStorage: {
        getItem() {
          return null;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      cookie:
        `boss-paegi-oauth-flow-${flowId}=${flowId}`,
    },
  });
  const responseBody = tokenResponse();
  Reflect.deleteProperty(responseBody.user, "role");
  Reflect.deleteProperty(responseBody.user, "identities");
  const capability =
    beginOAuthCallbackTransportScope(flowId);
  let bound = false;
  try {
    await armOAuthCallbackPkceTransport(
      capability,
      "code_123",
      "v".repeat(43),
      async (binding) => {
        bound = true;
        assert.equal(
          binding.accessToken,
          responseBody.access_token,
        );
        assert.equal(
          binding.refreshToken,
          responseBody.refresh_token,
        );
        assert.match(
          binding.accessTokenDigest,
          /^[0-9a-f]{64}$/u,
        );
        assert.match(
          binding.refreshTokenDigest,
          /^[0-9a-f]{64}$/u,
        );
      },
    );
    const wrapped = createAuthTransportFetch({
      supabaseUrl: "https://project.supabase.co",
      fetcher: async () =>
        new Response(JSON.stringify(responseBody), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
    });
    assert.equal(
      (
        await wrapped(
          "https://project.supabase.co/auth/v1/token?grant_type=pkce",
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json;charset=UTF-8",
            },
            body: JSON.stringify({
              auth_code: "code_123",
              code_verifier: "v".repeat(43),
            }),
          },
        )
      ).status,
      200,
    );
    assert.equal(bound, true);
  } finally {
    endOAuthCallbackTransportScope(capability);
    if (originalWindow) {
      Object.defineProperty(
        globalThis,
        "window",
        originalWindow,
      );
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    if (originalDocument) {
      Object.defineProperty(
        globalThis,
        "document",
        originalDocument,
      );
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
});

test("a session changed during PKCE is bound for cleanup but never exposed to auth-js", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const documentValue = {
    cookie:
      `boss-paegi-oauth-flow-${flowId}=${flowId}; ` +
      "sb-project-auth-token=source",
  };
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "https://app.example.test/auth/callback",
        origin: "https://app.example.test",
      },
      localStorage: {
        getItem() {
          return null;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: documentValue,
  });
  const capability =
    beginOAuthCallbackTransportScope(flowId);
  let bound = false;
  try {
    await armOAuthCallbackPkceTransport(
      capability,
      "code_123",
      "v".repeat(43),
      async () => {
        bound = true;
        documentValue.cookie =
          `boss-paegi-oauth-flow-${flowId}=${flowId}; ` +
          "sb-project-auth-token=unrelated";
      },
    );
    const wrapped = createAuthTransportFetch({
      supabaseUrl: "https://project.supabase.co",
      fetcher: async () =>
        new Response(JSON.stringify(tokenResponse()), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        }),
    });
    await assert.rejects(
      wrapped(
        "https://project.supabase.co/auth/v1/token?grant_type=pkce",
        {
          method: "POST",
          headers: {
            "content-type":
              "application/json;charset=UTF-8",
          },
          body: JSON.stringify({
            auth_code: "code_123",
            code_verifier: "v".repeat(43),
          }),
        },
      ),
      /auth_session_changed_during_request/u,
    );
    assert.equal(bound, true);
    assert.equal(
      oauthCallbackExchangeSafety(capability),
      "ambiguous_or_committed",
    );
  } finally {
    endOAuthCallbackTransportScope(capability);
    if (originalWindow) {
      Object.defineProperty(
        globalThis,
        "window",
        originalWindow,
      );
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    if (originalDocument) {
      Object.defineProperty(
        globalThis,
        "document",
        originalDocument,
      );
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
});

test("preflight proves the exact source before claim while post-PKCE bind proves the target independently", async () => {
  const preflight = await readFile(
    new URL(
      "app/api/auth/oauth-flow/preflight/route.ts",
      repositoryRoot,
    ),
    "utf8",
  );
  const claim = preflight.indexOf(
    '.rpc("claim_oauth_flow_intent"',
  );
  const sourceRead = preflight.indexOf(
    "readSupabaseSessionCookieHeader(",
  );
  const sourceFence = preflight.indexOf(
    'source.kind !== "present"',
    sourceRead,
  );
  assert.ok(sourceRead >= 0);
  assert.ok(sourceFence > sourceRead);
  assert.ok(claim > sourceFence);
  assert.match(
    preflight.slice(claim),
    /p_source_access_token_sha256: tokenDigest\([\s\S]*?source\.session\.accessToken[\s\S]*?p_source_refresh_token_sha256: tokenDigest\([\s\S]*?source\.session\.refreshToken/,
  );
  assert.match(
    preflight.slice(claim),
    /ok: true,[\s\S]*?flowId,[\s\S]*?sourceUserId: authority\.proof\.sourceUserId,[\s\S]*?sourceSessionId: authority\.proof\.sourceSessionId/,
  );

  const bind = await readFile(
    new URL(
      "app/api/auth/oauth-flow/bind-target/route.ts",
      repositoryRoot,
    ),
    "utf8",
  );
  const targetJwt = bind.indexOf(
    "readSupabaseAccessTokenIdentity(",
  );
  const targetUser = bind.indexOf(
    "readServerAuthUser({",
    targetJwt,
  );
  const bindRpc = bind.indexOf(
    '.rpc("bind_oauth_flow_intent_target"',
  );
  assert.ok(targetJwt >= 0);
  assert.ok(targetUser > targetJwt);
  assert.ok(bindRpc > targetUser);
  assert.doesNotMatch(
    bind,
    /readSupabaseSessionCookieHeader/,
  );
  assert.match(
    bind.slice(bindRpc),
    /p_access_token_sha256: tokenDigest\([\s\S]*?input\.accessToken[\s\S]*?p_refresh_token_sha256: tokenDigest\([\s\S]*?input\.refreshToken/,
  );
  assert.doesNotMatch(
    bind.slice(bindRpc),
    /p_access_token:\s*input\.accessToken|p_refresh_token:\s*input\.refreshToken/,
  );

  const callback = await readFile(
    new URL(
      "app/auth/callback/OAuthCallbackClient.tsx",
      repositoryRoot,
    ),
    "utf8",
  );
  assert.match(
    callback,
    /function parsePreflightAck\([\s\S]*?exactRecord\(value, \[[\s\S]*?"sourceUserId"[\s\S]*?"sourceSessionId"[\s\S]*?isOAuthFlowId\(value\.sourceUserId\)[\s\S]*?isOAuthFlowId\(value\.sourceSessionId\)/,
  );
  const lifecycle = await readFile(
    new URL("lib/supabase/client.ts", repositoryRoot),
    "utf8",
  );
  const preflightCall = lifecycle.indexOf(
    "await options.preflight(options.signal)",
  );
  const firstSourceFence = lifecycle.indexOf(
    "await assertOAuthCallbackSourceSession(",
    preflightCall,
  );
  const arm = lifecycle.indexOf(
    "await armOAuthCallbackPkceTransport(",
    firstSourceFence,
  );
  const secondSourceFence = lifecycle.lastIndexOf(
    "await assertOAuthCallbackSourceSession(",
    arm,
  );
  assert.ok(preflightCall >= 0);
  assert.ok(firstSourceFence > preflightCall);
  assert.ok(secondSourceFence > firstSourceFence);
  assert.ok(arm > secondSourceFence);
});

test("lost target-binding acknowledgement never reaches auth-js storage", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const originalBroadcastChannel = Object.getOwnPropertyDescriptor(
    globalThis,
    "BroadcastChannel",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "https://app.example.test/auth/callback",
        origin: "https://app.example.test",
      },
      localStorage: {
        getItem() {
          return null;
        },
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      visibilityState: "hidden",
      cookie:
        `boss-paegi-oauth-flow-${flowId}=${flowId}`,
    },
  });
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: class {
      addEventListener() {}
      removeEventListener() {}
      postMessage() {}
      close() {}
    },
  });
  const logicalStorageKey =
    "sb-project-auth-token-oauth-callback-" + flowId;
  const values = new Map<string, string>([
    [
      `${logicalStorageKey}-code-verifier`,
      JSON.stringify("v".repeat(43)),
    ],
  ]);
  const capability =
    beginOAuthCallbackTransportScope(flowId);
  const transport = createAuthTransportFetch({
    supabaseUrl: "https://project.supabase.co",
    fetcher: async () =>
      new Response(JSON.stringify(tokenResponse()), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  const client = new AuthClient({
    url: "https://project.supabase.co/auth/v1",
    headers: {
      Authorization: "Bearer public-anon-key",
      apikey: "public-anon-key",
    },
    storageKey: logicalStorageKey,
    storage: {
      getItem: (key) => values.get(key) ?? null,
      setItem: (key, value) => {
        values.set(key, value);
      },
      removeItem: (key) => {
        values.delete(key);
      },
    },
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    flowType: "pkce",
    skipAutoInitialize: true,
    fetch: transport,
  });
  try {
    await armOAuthCallbackPkceTransport(
      capability,
      "code_123",
      "v".repeat(43),
      async () => {
        throw new Error("bind_target_ack_lost");
      },
    );
    const exchanged =
      await client.exchangeCodeForSession("code_123");
    assert.equal(exchanged.data.session, null);
    assert.ok(exchanged.error);
    assert.equal(values.has(logicalStorageKey), false);
    assert.equal(
      oauthCallbackExchangeSafety(capability),
      "ambiguous_or_committed",
    );
  } finally {
    await client.dispose();
    endOAuthCallbackTransportScope(capability);
    if (originalWindow) {
      Object.defineProperty(
        globalThis,
        "window",
        originalWindow,
      );
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    if (originalDocument) {
      Object.defineProperty(
        globalThis,
        "document",
        originalDocument,
      );
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    if (originalBroadcastChannel) {
      Object.defineProperty(
        globalThis,
        "BroadcastChannel",
        originalBroadcastChannel,
      );
    } else {
      Reflect.deleteProperty(globalThis, "BroadcastChannel");
    }
  }
});

test("PKCE transport distinguishes definitive HTTP rejection from every adjacent uncertain class", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "https://app.example.test/auth/callback",
        origin: "https://app.example.test",
      },
      localStorage: {
        getItem() {
          return null;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      cookie:
        `boss-paegi-oauth-flow-${flowId}=${flowId}`,
    },
  });
  try {
    for (const [status, safety] of [
      [399, "ambiguous_or_committed"],
      [400, "definitively_rejected"],
      [407, "definitively_rejected"],
      [408, "ambiguous_or_committed"],
      [409, "definitively_rejected"],
      [424, "definitively_rejected"],
      [425, "ambiguous_or_committed"],
      [426, "definitively_rejected"],
      [428, "definitively_rejected"],
      [429, "ambiguous_or_committed"],
      [430, "definitively_rejected"],
      [459, "definitively_rejected"],
      [460, "ambiguous_or_committed"],
      [461, "definitively_rejected"],
      [499, "ambiguous_or_committed"],
      [500, "ambiguous_or_committed"],
    ] as const) {
      const capability =
        beginOAuthCallbackTransportScope(flowId);
      try {
        await armOAuthCallbackPkceTransport(
          capability,
          "code_123",
          "v".repeat(43),
          async () => {
            throw new Error(
              "non_200_pkce_must_not_bind_target",
            );
          },
        );
        const wrapped = createAuthTransportFetch({
          supabaseUrl: "https://project.supabase.co",
          fetcher: async () =>
            new Response(
              JSON.stringify({
                error: "invalid_grant",
              }),
              {
                status,
                headers: {
                  "content-type": "application/json",
                },
              },
            ),
        });
        assert.equal(
          (
            await wrapped(
              "https://project.supabase.co/auth/v1/token?grant_type=pkce",
              {
                method: "POST",
                headers: {
                  "content-type":
                    "application/json;charset=UTF-8",
                },
                body: JSON.stringify({
                  auth_code: "code_123",
                  code_verifier: "v".repeat(43),
                }),
              },
            )
          ).status,
          status,
        );
        assert.equal(
          oauthCallbackExchangeSafety(capability),
          safety,
        );
      } finally {
        endOAuthCallbackTransportScope(capability);
      }
    }
  } finally {
    if (originalWindow) {
      Object.defineProperty(
        globalThis,
        "window",
        originalWindow,
      );
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    if (originalDocument) {
      Object.defineProperty(
        globalThis,
        "document",
        originalDocument,
      );
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
});

test("refresh transport classifies exact rejection and every uncertain outcome", async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "https://app.example.test/auth/flow-pending",
        origin: "https://app.example.test",
      },
      localStorage: {
        getItem() {
          return null;
        },
      },
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      cookie:
        `boss-paegi-oauth-flow-${flowId}=${flowId}`,
    },
  });
  const refreshToken = "r".repeat(43);
  try {
    for (const [status, safety] of [
      [400, "definitively_rejected"],
      [408, "ambiguous_or_committed"],
      [429, "ambiguous_or_committed"],
      [500, "ambiguous_or_committed"],
    ] as const) {
      const capability =
        beginOAuthCallbackTransportScope(flowId);
      try {
        await armOAuthRecoveryRefreshTransport(
          capability,
          refreshToken,
        );
        const wrapped = createAuthTransportFetch({
          supabaseUrl: "https://project.supabase.co",
          fetcher: async () =>
            new Response(
              JSON.stringify({
                error: "invalid_grant",
              }),
              {
                status,
                headers: {
                  "content-type": "application/json",
                },
              },
            ),
        });
        assert.equal(
          (
            await wrapped(
              "https://project.supabase.co/auth/v1/token?grant_type=refresh_token",
              {
                method: "POST",
                headers: {
                  "content-type":
                    "application/json;charset=UTF-8",
                },
                body: JSON.stringify({
                  refresh_token: refreshToken,
                }),
              },
            )
          ).status,
          status,
        );
        assert.equal(
          oauthCallbackExchangeSafety(capability),
          safety,
        );
      } finally {
        endOAuthCallbackTransportScope(capability);
      }
    }

    const capability =
      beginOAuthCallbackTransportScope(flowId);
    try {
      await armOAuthRecoveryRefreshTransport(
        capability,
        refreshToken,
      );
      const wrapped = createAuthTransportFetch({
        supabaseUrl: "https://project.supabase.co",
        fetcher: async () => {
          throw new TypeError("response_lost_after_commit");
        },
      });
      await assert.rejects(
        wrapped(
          "https://project.supabase.co/auth/v1/token?grant_type=refresh_token",
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json;charset=UTF-8",
            },
            body: JSON.stringify({
              refresh_token: refreshToken,
            }),
          },
        ),
        /response_lost_after_commit/u,
      );
      assert.equal(
        oauthCallbackExchangeSafety(capability),
        "ambiguous_or_committed",
      );
    } finally {
      endOAuthCallbackTransportScope(capability);
    }
  } finally {
    if (originalWindow) {
      Object.defineProperty(
        globalThis,
        "window",
        originalWindow,
      );
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    if (originalDocument) {
      Object.defineProperty(
        globalThis,
        "document",
        originalDocument,
      );
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
  }
});

test("callback terminal ACK releases the durable browser barrier before navigation", async () => {
  const source = await readFile(
    new URL(
      "app/auth/callback/OAuthCallbackClient.tsx",
      repositoryRoot,
    ),
    "utf8",
  );
  const postAction = source.indexOf(
    'receipt.action === "signout"',
  );
  const release = source.indexOf(
    "terminalBrowserBarrierRelease(flowId)",
  );
  const terminalReceiptMemo = source.indexOf(
    "memory.terminalDestination = destination",
    postAction,
  );
  const terminalCleanup = source.indexOf(
    "completeTerminalBrowserState(",
    terminalReceiptMemo,
  );
  const destinationCommit = source.indexOf(
    "memory.destination = destination",
    terminalCleanup,
  );
  const navigation = source.indexOf(
    "window.location.replace(destination)",
    destinationCommit,
  );

  assert.ok(postAction >= 0);
  assert.ok(release >= 0);
  assert.ok(terminalReceiptMemo > postAction);
  assert.ok(terminalCleanup > terminalReceiptMemo);
  assert.ok(destinationCommit > terminalCleanup);
  assert.ok(navigation > destinationCommit);
  const verifierClear = source.indexOf(
    "clearBrowserSupabaseOAuthVerifierStorage()",
  );
  const verifierProof = source.indexOf(
    "assertBrowserSupabaseOAuthVerifierStorageCleared()",
    verifierClear,
  );
  assert.ok(verifierClear >= 0);
  assert.ok(verifierProof > verifierClear);
  assert.ok(release > verifierProof);
  assert.match(
    source,
    /if \(browserHasVisibleOAuthFlowMarker\(\)\)[\s\S]*clearOAuthFlowBrowserBarrier\(flowId\);[\s\S]*readOAuthFlowBrowserBarrier\(\) !== null/u,
  );
  assert.match(
    source,
    /if \(!flowId \|\| !provider\) \{[\s\S]*pendingRecoveryDestination\(flowId\)/u,
  );
  assert.doesNotMatch(
    source,
    /window\.location\.replace\("\/login\?error=oauth_flow"\)/u,
  );
  assert.doesNotMatch(
    source,
    /retained === undefined[\s\S]*window\.location\.search/u,
  );
  assert.match(
    source,
    /if \(memory\.terminalDestination !== null\) \{[\s\S]*resumeOAuthCallbackTerminalCleanup\(\{[\s\S]*completeTerminalBrowserState\(/u,
  );
  assert.match(
    source,
    /readExactVisibleOAuthCallbackFlow\(\) === null &&\s*readOAuthFlowBrowserBarrier\(\) === flowId/u,
  );
});

test("definitive preflight rejection and duplicate callback lease loss converge through recovery", async () => {
  const source = await readFile(
    new URL(
      "app/auth/callback/OAuthCallbackClient.tsx",
      repositoryRoot,
    ),
    "utf8",
  );
  assert.match(
    source,
    /class OAuthCallbackDefinitiveHttpError extends Error[\s\S]*?isDefinitiveHttpRejectionStatus\([\s\S]*?new OAuthCallbackDefinitiveHttpError\(/u,
  );
  assert.match(
    source,
    /error instanceof[\s\S]*?OAuthCallbackExchangeAmbiguousError \|\|[\s\S]*?error instanceof OAuthCallbackDefinitiveHttpError \|\|[\s\S]*?error instanceof OAuthFlowLeaseError[\s\S]*?memory\.recoveryRequired = true/u,
  );
  assert.match(
    source,
    /response\.status === 408[\s\S]*?response\.status === 425[\s\S]*?response\.status === 429[\s\S]*?response\.status >= 500/u,
  );
  assert.match(
    source,
    /callbackMemory\(\)\.get\(flowId\)[\s\S]*?\.recoveryRequired[\s\S]*?window\.location\.replace\([\s\S]*?pendingRecoveryDestination\(flowId\)/u,
  );
});

test("recovery refresh requires an exact one-use server authority and never trusts local expiry", async () => {
  const clientSource = await readFile(
    new URL("lib/supabase/client.ts", repositoryRoot),
    "utf8",
  );
  const pendingSource = await readFile(
    new URL(
      "app/auth/flow-pending/FlowPendingClient.tsx",
      repositoryRoot,
    ),
    "utf8",
  );
  const refreshStart = clientSource.indexOf(
    "export async function refreshBrowserSupabaseSessionForOAuthRecovery",
  );
  const transportStart = clientSource.indexOf(
    "const flowId = readExactVisibleOAuthCallbackFlow()",
    refreshStart,
  );
  assert.ok(refreshStart >= 0);
  assert.ok(transportStart > refreshStart);
  const refreshGate = clientSource.slice(
    refreshStart,
    transportStart,
  );
  assert.match(
    refreshGate,
    /authority: OAuthRecoveryRefreshAuthority/u,
  );
  assert.match(
    refreshGate,
    /consumeOAuthRecoveryRefreshAuthority\(authority\)/u,
  );
  assert.doesNotMatch(
    refreshGate,
    /accessTokenExpiry|oauth_recovery_refresh_not_expired|Date\.now|\bexp\b/u,
  );
  const rotateTarget = pendingSource.indexOf(
    '"/api/auth/oauth-flow/rotate-target"',
  );
  const parseAuthority = pendingSource.indexOf(
    "parseOAuthRecoveryRefreshAuthority(",
    rotateTarget,
  );
  const refresh = pendingSource.indexOf(
    "refreshBrowserSupabaseSessionForOAuthRecovery(",
    parseAuthority,
  );
  assert.ok(rotateTarget >= 0);
  assert.ok(parseAuthority > rotateTarget);
  assert.ok(refresh > parseAuthority);
  assert.match(
    pendingSource.slice(parseAuthority, refresh),
    /result\.response,\s*result\.value/u,
  );

  const script = String.raw`
    import assert from "node:assert/strict";
    import { register } from "node:module";
    import { pathToFileURL } from "node:url";
    register(
      "./__tests__/telemetry/node-loader.mjs",
      pathToFileURL(process.cwd() + "/")
    );
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
      "public-anon-key";

    const flowId =
      "11111111-1111-4111-8111-111111111111";
    const userId =
      "22222222-2222-4222-8222-222222222222";
    const sessionId =
      "33333333-3333-4333-8333-333333333333";
    const authKey = "sb-project-auth-token";
    const verifierKey = authKey + "-code-verifier";
    const markerKey = "boss-paegi-oauth-flow-" + flowId;
    const barrierKey = "boss-paegi:oauth-flow-barrier:v1";
    const cookies = new Map([
      [markerKey, flowId]
    ]);
    const localValues = new Map([
      [
        barrierKey,
        JSON.stringify({ version: 1, flowId })
      ]
    ]);
    const localStorage = {
      getItem: (key) => localValues.get(key) ?? null,
      setItem: (key, value) => localValues.set(key, value),
      removeItem: (key) => localValues.delete(key)
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "https://app.example.test/auth/flow-pending",
          origin: "https://app.example.test",
          pathname: "/auth/flow-pending",
          hostname: "app.example.test",
          protocol: "https:"
        },
        localStorage,
        addEventListener() {},
        removeEventListener() {}
      }
    });
    const documentValue = { visibilityState: "hidden" };
    Object.defineProperty(documentValue, "cookie", {
      configurable: true,
      get() {
        return [...cookies]
          .map(([name, value]) => name + "=" + value)
          .join("; ");
      },
      set(serialized) {
        const fields = String(serialized)
          .split(";")
          .map((part) => part.trim());
        const equals = fields[0].indexOf("=");
        const name = fields[0].slice(0, equals);
        const value = fields[0].slice(equals + 1);
        const deleting =
          value === "" ||
          fields.some((field) =>
            /^Max-Age=0$/i.test(field)
          );
        if (deleting) cookies.delete(name);
        else cookies.set(name, value);
      }
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: documentValue
    });

    const encode = (value) =>
      Buffer.from(JSON.stringify(value)).toString("base64url");
    const jwt = (expiry) =>
      encode({ alg: "none" }) + "." +
      encode({
        sub: userId,
        session_id: sessionId,
        exp: expiry
      }) +
      ".signature";
    const user = {
      id: userId,
      aud: "authenticated",
      app_metadata: {},
      user_metadata: {},
      created_at: "2026-01-01T00:00:00.000Z",
      is_anonymous: false
    };
    let refreshCalls = 0;
    let userCalls = 0;
    globalThis.fetch = async (input, init) => {
      const url =
        input instanceof Request ? input.url : String(input);
      if (url.includes("grant_type=refresh_token")) {
        refreshCalls += 1;
        const submitted = JSON.parse(String(init?.body));
        assert.match(submitted.refresh_token, /^old-refresh-/);
        return new Response(
          JSON.stringify({
            access_token:
              jwt(Math.floor(Date.now() / 1000) + 3600),
            refresh_token: "new-refresh-" + refreshCalls,
            expires_in: 3600,
            token_type: "bearer",
            user
          }),
          {
            status: 200,
            headers: { "content-type": "application/json" }
          }
        );
      }
      if (url.endsWith("/auth/v1/user")) {
        userCalls += 1;
        return new Response(JSON.stringify(user), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      throw new Error("unexpected_fetch:" + url);
    };

    const client = await import("./lib/supabase/client.ts");
    const exactResponse = () =>
      new Response(
        JSON.stringify({
          error: "auth_session_refresh_required"
        }),
        {
          status: 409,
          headers: { "content-type": "application/json" }
        }
      );
    const authority = () =>
      client.parseOAuthRecoveryRefreshAuthority(
        exactResponse(),
        { error: "auth_session_refresh_required" }
      );
    for (const [response, body] of [
      [
        new Response("{}", {
          status: 200,
          headers: { "content-type": "application/json" }
        }),
        { error: "auth_session_refresh_required" }
      ],
      [
        new Response("text", {
          status: 409,
          headers: { "content-type": "text/plain" }
        }),
        { error: "auth_session_refresh_required" }
      ],
      [
        exactResponse(),
        {
          error: "auth_session_refresh_required",
          extra: true
        }
      ],
      [
        exactResponse(),
        { error: "auth_unavailable" }
      ]
    ]) {
      assert.equal(
        client.parseOAuthRecoveryRefreshAuthority(
          response,
          body
        ),
        null
      );
    }

    const originalDateNow = Date.now;
    const runCase = async (expiry, localNow, suffix) => {
      Date.now = () => localNow;
      cookies.set(
        authKey,
        JSON.stringify({
          access_token: jwt(expiry),
          refresh_token: "old-refresh-" + suffix
        })
      );
      cookies.delete(verifierKey);
      const grant = authority();
      assert.ok(grant);
      const result =
        await client
          .refreshBrowserSupabaseSessionForOAuthRecovery(
            { userId, sessionId },
            grant,
            new AbortController().signal
          );
      assert.equal(result.userId, userId);
      assert.equal(result.sessionId, sessionId);
      assert.match(result.accessTokenSha256, /^[0-9a-f]{64}$/);
      assert.match(result.refreshTokenSha256, /^[0-9a-f]{64}$/);
      await assert.rejects(
        client.refreshBrowserSupabaseSessionForOAuthRecovery(
          { userId, sessionId },
          grant,
          new AbortController().signal
        ),
        /oauth_recovery_refresh_authority_invalid/
      );
    };
    try {
      // Revoked/unusable according to the server while still locally
      // unexpired. The old local-exp gate rejected this before any request.
      await runCase(4_000_000_000, 1_800_000_000_000, "revoked");
      // Actually expired against server time, but the client clock is slow.
      await runCase(1_750_000_000, 1_600_000_000_000, "skew");
      await assert.rejects(
        client.refreshBrowserSupabaseSessionForOAuthRecovery(
          { userId, sessionId },
          { reason: "auth_session_refresh_required" },
          new AbortController().signal
        ),
        /oauth_recovery_refresh_authority_invalid/
      );
    } finally {
      Date.now = originalDateNow;
    }
    assert.equal(refreshCalls, 2);
    assert.equal(userCalls, 2);
    process.stdout.write(JSON.stringify({
      refreshCalls,
      userCalls
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
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    refreshCalls: 2,
    userCalls: 2,
  });
});

test("purpose-built callback clients dispose every channel and preserve primary failures", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { register } from "node:module";
    import { pathToFileURL } from "node:url";
    register(
      "./__tests__/telemetry/node-loader.mjs",
      pathToFileURL(process.cwd() + "/")
    );
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
      "public-anon-key";

    const flowId =
      "11111111-1111-4111-8111-111111111111";
    const marker =
      "boss-paegi-oauth-flow-" + flowId + "=" + flowId;
    const barrierKey = "boss-paegi:oauth-flow-barrier:v1";
    const localValues = new Map([
      [
        barrierKey,
        JSON.stringify({ version: 1, flowId })
      ]
    ]);
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "https://app.example.test/auth/callback",
          origin: "https://app.example.test",
          pathname: "/auth/callback",
          hostname: "app.example.test",
          protocol: "https:"
        },
        localStorage: {
          getItem: (key) => localValues.get(key) ?? null,
          setItem: (key, value) => localValues.set(key, value),
          removeItem: (key) => localValues.delete(key)
        },
        addEventListener() {},
        removeEventListener() {}
      }
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: {
        visibilityState: "hidden",
        cookie: marker
      }
    });
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: async (name, _options, callback) =>
            callback({ name })
        }
      }
    });
    let created = 0;
    let closed = 0;
    let active = 0;
    let throwOnClose = false;
    class CountingBroadcastChannel {
      constructor(name) {
        this.name = name;
        this.listeners = new Set();
        this.closed = false;
        created += 1;
        active += 1;
      }
      addEventListener(type, listener) {
        if (type === "message") this.listeners.add(listener);
      }
      removeEventListener(type, listener) {
        if (type === "message") this.listeners.delete(listener);
      }
      postMessage() {}
      close() {
        if (this.closed) return;
        this.closed = true;
        this.listeners.clear();
        closed += 1;
        active -= 1;
        if (throwOnClose) {
          throw new Error("broadcast_close_failed");
        }
      }
    }
    Object.defineProperty(globalThis, "BroadcastChannel", {
      configurable: true,
      value: CountingBroadcastChannel
    });
    globalThis.fetch = async () => {
      throw new Error("unexpected_fetch");
    };

    const client = await import("./lib/supabase/client.ts");
    const attempts = 6;
    for (let index = 0; index < attempts; index += 1) {
      const primary = new Error("primary-" + index);
      await assert.rejects(
        client.runOAuthCallbackAuthLifecycle({
          signal: new AbortController().signal,
          flowId,
          code: null,
          preflight: async () => {},
          bindTarget: async () => {
            throw new Error("unexpected_bind");
          },
          finish: async (_lifecycle, auth) => {
            auth();
            throw primary;
          }
        }),
        (error) => error === primary
      );
      assert.equal(active, 0);
      assert.equal(created, index + 1);
      assert.equal(closed, index + 1);
    }

    // A cleanup exception must not replace the callback's primary failure,
    // and the transport scope must still end so another lifecycle can enter.
    throwOnClose = true;
    const primary = new Error("primary-with-cleanup-failure");
    await assert.rejects(
      client.runOAuthCallbackAuthLifecycle({
        signal: new AbortController().signal,
        flowId,
        code: null,
        preflight: async () => {},
        bindTarget: async () => {
          throw new Error("unexpected_bind");
        },
        finish: async (_lifecycle, auth) => {
          auth();
          throw primary;
        }
      }),
      (error) => error === primary
    );
    throwOnClose = false;
    const enteredAgain =
      await client.runOAuthCallbackAuthLifecycle({
        signal: new AbortController().signal,
        flowId,
        code: null,
        preflight: async () => {},
        bindTarget: async () => {
          throw new Error("unexpected_bind");
        },
        finish: async () => "entered"
      });
    assert.equal(enteredAgain, "entered");
    process.stdout.write(JSON.stringify({
      created,
      closed,
      active
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
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    created: 7,
    closed: 7,
    active: 0,
  });
});

test("same-process terminal cleanup re-enters H then S after the visible marker is gone", async () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { register } from "node:module";
    import { pathToFileURL } from "node:url";
    register(
      "./__tests__/telemetry/node-loader.mjs",
      pathToFileURL(process.cwd() + "/")
    );
    process.env.NEXT_PUBLIC_SUPABASE_URL =
      "https://project.supabase.co";
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY =
      "public-anon-key";

    const flowId =
      "11111111-1111-4111-8111-111111111111";
    const authKey = "sb-project-auth-token";
    const verifierKey = authKey + "-code-verifier";
    const markerKey = "boss-paegi-oauth-flow-" + flowId;
    const barrierKey = "boss-paegi:oauth-flow-barrier:v1";
    const cookies = new Map([
      [verifierKey, JSON.stringify("v".repeat(43))]
    ]);
    const localValues = new Map([
      [
        barrierKey,
        JSON.stringify({ version: 1, flowId })
      ]
    ]);
    const localStorage = {
      getItem: (key) => localValues.get(key) ?? null,
      setItem: (key, value) => localValues.set(key, value),
      removeItem: (key) => localValues.delete(key)
    };
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          href: "https://app.example.test/auth/callback",
          origin: "https://app.example.test",
          pathname: "/auth/callback",
          hostname: "app.example.test",
          protocol: "https:"
        },
        localStorage,
        addEventListener() {},
        removeEventListener() {}
      }
    });
    const documentValue = { visibilityState: "hidden" };
    Object.defineProperty(documentValue, "cookie", {
      configurable: true,
      get() {
        return [...cookies]
          .map(([name, value]) => name + "=" + value)
          .join("; ");
      },
      set(serialized) {
        const fields = String(serialized)
          .split(";")
          .map((part) => part.trim());
        const equals = fields[0].indexOf("=");
        const name = fields[0].slice(0, equals);
        const value = fields[0].slice(equals + 1);
        const deleting =
          value === "" ||
          fields.some((field) =>
            /^Max-Age=0$/i.test(field)
          );
        if (deleting) cookies.delete(name);
        else cookies.set(name, value);
      }
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: documentValue
    });
    const lockNames = [];
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: {
        locks: {
          request: async (name, _options, callback) => {
            lockNames.push(name);
            return callback({ name });
          }
        }
      }
    });
    globalThis.fetch = async () => {
      throw new Error("unexpected_fetch");
    };

    const client = await import("./lib/supabase/client.ts");
    const barrier =
      await import("./lib/oauth-flow-browser-barrier.ts");
    let cleanupCalls = 0;
    const value =
      await client.resumeOAuthCallbackTerminalCleanup({
        signal: new AbortController().signal,
        flowId,
        cleanup: () => {
          cleanupCalls += 1;
          client.clearBrowserSupabaseOAuthVerifierStorage();
          client
            .assertBrowserSupabaseOAuthVerifierStorageCleared();
          barrier.clearOAuthFlowBrowserBarrier(flowId);
          return "clean";
        }
      });
    assert.equal(value, "clean");
    assert.equal(cleanupCalls, 1);
    assert.equal(cookies.has(verifierKey), false);
    assert.equal(localValues.has(barrierKey), false);
    assert.deepEqual(lockNames, [
      "boss-paegi:auth-session-establishment:v1",
      "lock:sb-project-auth-token"
    ]);

    // Without the exact marker-absent + durable-flow state, no cleanup code
    // is allowed to run.
    localValues.set(
      barrierKey,
      JSON.stringify({ version: 1, flowId })
    );
    cookies.set(markerKey, flowId);
    let blockedCleanupCalls = 0;
    await assert.rejects(
      client.resumeOAuthCallbackTerminalCleanup({
        signal: new AbortController().signal,
        flowId,
        cleanup: () => {
          blockedCleanupCalls += 1;
        }
      }),
      /oauth_callback_terminal_cleanup_barrier_invalid/
    );
    assert.equal(blockedCleanupCalls, 0);
    process.stdout.write(JSON.stringify({
      cleanupCalls,
      blockedCleanupCalls
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
      cwd: repositoryRoot,
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    cleanupCalls: 1,
    blockedCleanupCalls: 0,
  });
});

test("all callback failure decisions converge on verifier proof before barrier release", async () => {
  const source = await readFile(
    new URL(
      "app/auth/callback/OAuthCallbackClient.tsx",
      repositoryRoot,
    ),
    "utf8",
  );
  for (const failureCode of [
    "identity_already_exists",
    "provider_error",
    "missing_code",
    "exchange_error",
  ]) {
    assert.match(source, new RegExp(`"${failureCode}"`, "u"));
  }
  const decision = source.indexOf(
    "const decision = memory.decision",
  );
  const terminalAction = source.indexOf(
    "receipt.action === \"signout\"",
    decision,
  );
  const terminalMemo = source.indexOf(
    "memory.terminalDestination = destination",
    terminalAction,
  );
  const commonCleanup = source.indexOf(
    "completeTerminalBrowserState(",
    terminalMemo,
  );
  assert.ok(decision >= 0);
  assert.ok(terminalAction > decision);
  assert.ok(terminalMemo > terminalAction);
  assert.ok(commonCleanup > terminalMemo);
  assert.doesNotMatch(
    source.slice(terminalMemo, commonCleanup),
    /exchangeOutcome|failureCode/u,
  );
});

test("installed auth-js callback storage key cannot broadcast an unfinalized session to ordinary subscribers", async () => {
  const source = await readFile(
    new URL("lib/supabase/client.ts", repositoryRoot),
    "utf8",
  );
  assert.match(
    source,
    /return `\$\{authStorageKey\(\)\}-oauth-callback-\$\{capabilityId\}`/u,
  );
  assert.match(
    source,
    /storageKey,\s*storage: createOAuthCallbackCookieStorage\(storageKey\)/u,
  );
  assert.match(
    source,
    /\[logicalStorageKey, authStorageKey\(\)\]/u,
  );
  assert.match(
    source,
    /`\$\{logicalStorageKey\}-code-verifier`,\s*authCodeVerifierKey\(\)/u,
  );

  const originalWindow = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  const originalDocument = Object.getOwnPropertyDescriptor(
    globalThis,
    "document",
  );
  const originalBroadcastChannel = Object.getOwnPropertyDescriptor(
    globalThis,
    "BroadcastChannel",
  );
  const channelInstances = new Map<
    string,
    Set<InMemoryBroadcastChannel>
  >();
  const sentChannels: string[] = [];

  class InMemoryBroadcastChannel {
    readonly name: string;
    private readonly listeners = new Set<
      (event: { data: unknown }) => void
    >();

    constructor(name: string) {
      this.name = name;
      const instances =
        channelInstances.get(name) ??
        new Set<InMemoryBroadcastChannel>();
      instances.add(this);
      channelInstances.set(name, instances);
    }

    addEventListener(
      type: string,
      listener: (event: { data: unknown }) => void,
    ) {
      if (type === "message") this.listeners.add(listener);
    }

    removeEventListener(
      type: string,
      listener: (event: { data: unknown }) => void,
    ) {
      if (type === "message") this.listeners.delete(listener);
    }

    postMessage(data: unknown) {
      sentChannels.push(this.name);
      for (const channel of channelInstances.get(this.name) ?? []) {
        if (channel === this) continue;
        for (const listener of channel.listeners) {
          listener({ data });
        }
      }
    }

    close() {
      channelInstances.get(this.name)?.delete(this);
    }
  }

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      location: {
        href: "https://app.example.test/",
        origin: "https://app.example.test",
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { visibilityState: "hidden" },
  });
  Object.defineProperty(globalThis, "BroadcastChannel", {
    configurable: true,
    value: InMemoryBroadcastChannel,
  });

  const makeStorage = (initial: Record<string, string> = {}) => {
    const values = new Map(Object.entries(initial));
    return {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    };
  };
  const ordinaryKey = "sb-project-auth-token";
  const callbackKey =
    `${ordinaryKey}-oauth-callback-` +
    "11111111-1111-4111-8111-111111111111";
  const base = {
    url: "https://project.supabase.co/auth/v1",
    headers: {
      Authorization: "Bearer public-anon-key",
      apikey: "public-anon-key",
    },
    persistSession: true,
    autoRefreshToken: false,
    detectSessionInUrl: false,
    flowType: "pkce" as const,
    skipAutoInitialize: true,
  };
  const ordinary = new AuthClient({
    ...base,
    storageKey: ordinaryKey,
    storage: makeStorage(),
    fetch: async () => {
      throw new Error("unexpected_ordinary_fetch");
    },
  });
  const ordinaryEvents: string[] = [];
  ordinary.onAuthStateChange((event) => {
    ordinaryEvents.push(event);
  });

  const encode = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const userId = "22222222-2222-4222-8222-222222222222";
  const sessionId =
    "33333333-3333-4333-8333-333333333333";
  const accessToken =
    `${encode({ alg: "none" })}.` +
    `${encode({
      sub: userId,
      session_id: sessionId,
      exp: Math.floor(Date.now() / 1000) + 3_600,
    })}.signature`;
  const user = {
    id: userId,
    aud: "authenticated",
    role: "authenticated",
    app_metadata: {},
    user_metadata: {},
    identities: [],
    created_at: "2026-01-01T00:00:00.000Z",
    is_anonymous: false,
  };
  const session = {
    access_token: accessToken,
    refresh_token: "refresh-token",
    expires_in: 3_600,
    expires_at: Math.floor(Date.now() / 1000) + 3_600,
    token_type: "bearer",
    user,
  };
  const callback = new AuthClient({
    ...base,
    storageKey: callbackKey,
    storage: makeStorage({
      [`${callbackKey}-code-verifier`]: JSON.stringify(
        "v".repeat(43),
      ),
    }),
    fetch: async () =>
      new Response(JSON.stringify({ ...session, user }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });

  try {
    await new Promise((resolve) => setImmediate(resolve));
    ordinaryEvents.length = 0;
    sentChannels.length = 0;

    const exchanged =
      await callback.exchangeCodeForSession("code_123");
    assert.equal(exchanged.error, null);
    const signedOut = await callback.signOut({
      scope: "local",
    });
    assert.equal(signedOut.error, null);
    assert.ok(sentChannels.length >= 2);
    assert.ok(
      sentChannels.every((name) => name === callbackKey),
    );
    assert.deepEqual(ordinaryEvents, []);
  } finally {
    await callback.dispose();
    await ordinary.dispose();
    if (originalWindow) {
      Object.defineProperty(
        globalThis,
        "window",
        originalWindow,
      );
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
    if (originalDocument) {
      Object.defineProperty(
        globalThis,
        "document",
        originalDocument,
      );
    } else {
      Reflect.deleteProperty(globalThis, "document");
    }
    if (originalBroadcastChannel) {
      Object.defineProperty(
        globalThis,
        "BroadcastChannel",
        originalBroadcastChannel,
      );
    } else {
      Reflect.deleteProperty(globalThis, "BroadcastChannel");
    }
  }
});
