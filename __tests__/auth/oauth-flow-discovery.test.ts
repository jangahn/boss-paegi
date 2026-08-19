import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  browserHasOAuthFlowDurableBarrier,
  clearOAuthFlowBrowserBarrier,
  OAUTH_FLOW_BROWSER_BARRIER_KEY,
  readOAuthFlowBrowserBarrier,
  reconcileOAuthFlowBrowserBarrier,
  stageOAuthFlowBrowserBarrier,
} from "../../lib/oauth-flow-browser-barrier.ts";
import {
  resolveOAuthFlowBrowserRecoveryPath,
} from "../../lib/oauth-flow-browser-recovery.ts";
import {
  runAuthCrossContextExclusive,
  runSignalAwareSupabaseAuthLock,
  type AuthLockManager,
} from "../../lib/auth-cross-context.ts";
import {
  parseOAuthFlowDiscoveredAuthority,
  parseOAuthFlowDiscoveredStatus,
  parseOAuthFlowDiscoveryAbsent,
} from "../../lib/oauth-flow-status.ts";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const FLOW_A = "11111111-1111-4111-8111-111111111111";
const FLOW_B = "22222222-2222-4222-8222-222222222222";
const SOURCE_USER =
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_SESSION =
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TARGET_USER =
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const TARGET_SESSION =
  "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

function source(relativePath: string): string {
  return readFileSync(
    path.join(repositoryRoot, relativePath),
    "utf8",
  );
}

function installWindowStorage(storage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): unknown;
  removeItem(key: string): unknown;
}): () => void {
  const previous = Object.getOwnPropertyDescriptor(
    globalThis,
    "window",
  );
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: storage },
  });
  return () => {
    if (previous) {
      Object.defineProperty(globalThis, "window", previous);
    } else {
      Reflect.deleteProperty(globalThis, "window");
    }
  };
}

class QueueingLockManager implements AuthLockManager {
  private readonly held = new Set<string>();
  private readonly queued = new Map<
    string,
    Array<{
      signal: AbortSignal;
      callback: (lock: Lock | null) => Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      abort: () => void;
    }>
  >();

  request<T>(
    name: string,
    options: {
      mode: "exclusive";
      signal: AbortSignal;
    },
    callback: (lock: Lock | null) => Promise<T>,
  ): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const entry = {
        signal: options.signal,
        callback: callback as (
          lock: Lock | null,
        ) => Promise<unknown>,
        resolve: resolve as (value: unknown) => void,
        reject,
        abort: () => {
          const queue = this.queued.get(name);
          const index = queue?.indexOf(entry) ?? -1;
          if (index >= 0) queue!.splice(index, 1);
          reject(
            options.signal.reason ??
              new DOMException("Aborted", "AbortError"),
          );
        },
      };
      if (this.held.has(name)) {
        if (options.signal.aborted) {
          entry.abort();
          return;
        }
        const queue = this.queued.get(name) ?? [];
        queue.push(entry);
        this.queued.set(name, queue);
        options.signal.addEventListener("abort", entry.abort, {
          once: true,
        });
        return;
      }
      this.start(name, entry);
    });
  }

  private start(
    name: string,
    entry: {
      signal: AbortSignal;
      callback: (lock: Lock | null) => Promise<unknown>;
      resolve: (value: unknown) => void;
      reject: (reason?: unknown) => void;
      abort: () => void;
    },
  ): void {
    if (entry.signal.aborted) {
      entry.reject(
        entry.signal.reason ??
          new DOMException("Aborted", "AbortError"),
      );
      return;
    }
    entry.signal.removeEventListener("abort", entry.abort);
    this.held.add(name);
    void entry
      .callback({ name } as Lock)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.held.delete(name);
        const queue = this.queued.get(name);
        const next = queue?.shift();
        if (queue?.length === 0) this.queued.delete(name);
        if (next) this.start(name, next);
      });
  }
}

function claimedStatus(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ok: true,
    flowId: FLOW_A,
    provider: "google",
    sourceIsAnonymous: true,
    requestedNext: "/arena?mode=ranked",
    state: "claimed",
    active: true,
    outcome: null,
    targetUserId: TARGET_USER,
    targetSessionId: TARGET_SESSION,
    destination: null,
    action: null,
    createdAt: "2026-07-31T00:00:00.000Z",
    expiresAt: "2026-07-31T00:10:00.000Z",
    claimedAt: "2026-07-31T00:01:00.000Z",
    revokeConfirmedAt: null,
    finishedAt: null,
    releasedAt: null,
    migrationConsumedAt: null,
    ...overrides,
  };
}

test("proof-only discovery accepts exactly one signed flow and rejects every ambiguous cookie shape", () => {
  const script = String.raw`
    import assert from "node:assert/strict";
    import { register } from "node:module";
    import { pathToFileURL } from "node:url";
    register(
      "./__tests__/telemetry/node-loader.mjs",
      pathToFileURL(process.cwd() + "/")
    );

    const {
      discoverOAuthFlowRouteAuthority
    } = await import("./lib/oauth-flow-route.ts");
    const {
      oauthFlowProofCookieName,
      signOAuthFlowProof
    } = await import("./lib/oauth-flow-proof.ts");
    const {
      oauthFlowCookieName
    } = await import("./lib/oauth-flow-lease.ts");

    const flowA =
      "11111111-1111-4111-8111-111111111111";
    const flowB =
      "22222222-2222-4222-8222-222222222222";
    const sourceUserId =
      "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const sourceSessionId =
      "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const secret = "oauth-discovery-test-secret";
    const signed = signOAuthFlowProof(
      {
        flowId: flowA,
        sourceUserId,
        sourceSessionId,
        sourceIsAnonymous: true,
        provider: "google"
      },
      secret
    );
    const proofNameA = oauthFlowProofCookieName(flowA);
    const proofNameB = oauthFlowProofCookieName(flowB);
    const markerNameA = oauthFlowCookieName(flowA);
    const markerNameB = oauthFlowCookieName(flowB);
    const discover = (cookieHeader) =>
      discoverOAuthFlowRouteAuthority({
        cookieHeader,
        recovery: true,
        secret
      });

    const proofOnly = discover(
      proofNameA + "=" + signed.value
    );
    assert.deepEqual(proofOnly, {
      markerPresent: false,
      proof: signed.proof,
      proofValue: signed.value
    });
    assert.deepEqual(
      discover(
        markerNameA + "=" + flowA + "; " +
        proofNameA + "=" + signed.value
      ),
      {
        markerPresent: true,
        proof: signed.proof,
        proofValue: signed.value
      }
    );
    assert.deepEqual(
      discover(
        "unrelated=%; " + proofNameA + "=" + signed.value
      ),
      {
        markerPresent: false,
        proof: signed.proof,
        proofValue: signed.value
      }
    );

    const tampered =
      signed.value.slice(0, -1) +
      (signed.value.endsWith("A") ? "B" : "A");
    for (const malformed of [
      null,
      "",
      markerNameA + "=" + flowA,
      proofNameA + "=%",
      proofNameA + "=" + tampered,
      proofNameB + "=" + signed.value,
      markerNameB + "=" + flowB + "; " +
        proofNameA + "=" + signed.value,
      proofNameA + "=" + signed.value + "; " +
        proofNameB + "=" + signed.value,
      proofNameA + "=" + signed.value + "; " +
        proofNameA + "=" + signed.value,
      markerNameA + "=" + flowA + "; " +
        markerNameA + "=" + flowA + "; " +
        proofNameA + "=" + signed.value,
      markerNameA + "=not-the-flow; " +
        proofNameA + "=" + signed.value
    ]) {
      assert.equal(discover(malformed), null, malformed ?? "null");
    }
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
});

test("discovery absence parser is privacy-minimal and exact", () => {
  assert.deepEqual(
    parseOAuthFlowDiscoveryAbsent({
      ok: true,
      state: "absent",
      active: false,
    }),
    { state: "absent", active: false },
  );

  for (const malformed of [
    null,
    [],
    {},
    { ok: true, state: "absent" },
    { ok: true, active: false },
    { state: "absent", active: false },
    { ok: false, state: "absent", active: false },
    { ok: true, state: "absent", active: true },
    { ok: true, state: "completed", active: false },
    {
      ok: true,
      flowId: FLOW_A,
      state: "absent",
      active: false,
    },
    {
      ok: true,
      state: "absent",
      active: false,
      destination: "/",
    },
  ]) {
    assert.equal(
      parseOAuthFlowDiscoveryAbsent(malformed),
      null,
      JSON.stringify(malformed),
    );
  }
});

test("lost-all-hints discovery retains every exact flow that still needs convergence authority", () => {
  const status = claimedStatus();
  const expectedStatus = Object.fromEntries(
    Object.entries(status).filter(([key]) => key !== "ok"),
  );
  assert.deepEqual(
    parseOAuthFlowDiscoveredStatus(status),
    expectedStatus,
  );

  const authority = {
    ...status,
    sourceUserId: SOURCE_USER,
    sourceSessionId: SOURCE_SESSION,
  };
  const recovered =
    parseOAuthFlowDiscoveredAuthority(authority);
  assert.equal(recovered?.sourceUserId, SOURCE_USER);
  assert.equal(recovered?.sourceSessionId, SOURCE_SESSION);
  assert.equal(recovered?.status.flowId, FLOW_A);
  assert.equal(recovered?.status.state, "claimed");
  assert.equal(recovered?.status.active, true);

  const unreleasedContinue = {
    ...authority,
    state: "completed",
    active: false,
    outcome: "completed",
    destination: "/",
    action: "continue",
    finishedAt: "2026-07-31T00:02:00.000Z",
  };
  assert.equal(
    parseOAuthFlowDiscoveredAuthority(unreleasedContinue)
      ?.status.releasedAt,
    null,
  );

  const releasedUnconsumedAnonymous = {
    ...unreleasedContinue,
    releasedAt: "2026-07-31T00:03:00.000Z",
  };
  const releasedRecovery = parseOAuthFlowDiscoveredAuthority(
    releasedUnconsumedAnonymous,
  );
  assert.equal(
    releasedRecovery?.status.releasedAt,
    releasedUnconsumedAnonymous.releasedAt,
  );
  assert.equal(releasedRecovery?.status.migrationConsumedAt, null);
  assert.equal(releasedRecovery?.status.sourceIsAnonymous, true);

  for (const malformed of [
    { ...authority, flowId: "not-a-uuid" },
    { ...authority, sourceUserId: "not-a-uuid" },
    { ...authority, state: "claimed", active: false },
    { ...authority, state: "completed", active: true },
    {
      ...releasedUnconsumedAnonymous,
      migrationConsumedAt: "2026-07-31T00:04:00.000Z",
    },
    {
      ...releasedUnconsumedAnonymous,
      sourceIsAnonymous: false,
    },
    {
      ...releasedUnconsumedAnonymous,
      revokeConfirmedAt: "2026-07-31T00:02:30.000Z",
    },
    { ...unreleasedContinue, action: "signout" },
    { ...authority, extra: true },
    { ...status, extra: true },
  ]) {
    assert.equal(
      parseOAuthFlowDiscoveredAuthority(malformed),
      null,
      JSON.stringify(malformed),
    );
  }
});

test("malformed or unavailable browser storage remains an ordinary-auth barrier", () => {
  const values = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  };
  const restore = installWindowStorage(storage);
  try {
    assert.equal(browserHasOAuthFlowDurableBarrier(), false);

    values.set(OAUTH_FLOW_BROWSER_BARRIER_KEY, "{");
    assert.equal(browserHasOAuthFlowDurableBarrier(), true);
    assert.throws(
      () => stageOAuthFlowBrowserBarrier(FLOW_A),
      /oauth_flow_browser_barrier_invalid/,
    );
    assert.throws(
      () => clearOAuthFlowBrowserBarrier(FLOW_A),
      /oauth_flow_browser_barrier_invalid/,
    );
    assert.equal(
      values.get(OAUTH_FLOW_BROWSER_BARRIER_KEY),
      "{",
      "unknown durable bytes remain fail-closed after queryless absence",
    );

    // Only the post-receipt reconciliation primitive may repair malformed
    // bytes. Ordinary stage/clear operations above must remain fail-closed.
    values.set(OAUTH_FLOW_BROWSER_BARRIER_KEY, "{");
    reconcileOAuthFlowBrowserBarrier(FLOW_A, true);
    assert.equal(readOAuthFlowBrowserBarrier(), FLOW_A);
    assert.equal(browserHasOAuthFlowDurableBarrier(), true);
    assert.equal(readOAuthFlowBrowserBarrier(), FLOW_A);
    assert.throws(
      () => reconcileOAuthFlowBrowserBarrier(FLOW_B, true),
      /oauth_flow_browser_barrier_changed/,
    );
    assert.equal(readOAuthFlowBrowserBarrier(), FLOW_A);

    reconcileOAuthFlowBrowserBarrier(FLOW_A, false);
    assert.equal(readOAuthFlowBrowserBarrier(), null);
    assert.equal(browserHasOAuthFlowDurableBarrier(), false);
  } finally {
    restore();
  }

  const unavailableRestore = installWindowStorage({
    getItem() {
      throw new Error("storage_disabled");
    },
    setItem() {
      throw new Error("storage_disabled");
    },
    removeItem() {
      throw new Error("storage_disabled");
    },
  });
  try {
    assert.equal(browserHasOAuthFlowDurableBarrier(), true);
    assert.throws(
      () => reconcileOAuthFlowBrowserBarrier(FLOW_A, true),
      /storage_disabled/,
    );
    assert.throws(
      () => readOAuthFlowBrowserBarrier(),
      /storage_disabled/,
    );
  } finally {
    unavailableRestore();
  }
});

test("live recovery resolver routes exact hints and sends ambiguity through null-flow discovery", () => {
  const values = new Map<string, string>();
  const restore = installWindowStorage({
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  });
  try {
    assert.equal(resolveOAuthFlowBrowserRecoveryPath(""), null);
    stageOAuthFlowBrowserBarrier(FLOW_A);
    assert.equal(
      resolveOAuthFlowBrowserRecoveryPath(""),
      `/auth/flow-pending?flow=${FLOW_A}`,
    );
    assert.equal(
      resolveOAuthFlowBrowserRecoveryPath(
        `boss-paegi-oauth-flow-${FLOW_B}=${FLOW_B}`,
      ),
      "/auth/flow-pending",
    );
    clearOAuthFlowBrowserBarrier(FLOW_A);
    assert.equal(
      resolveOAuthFlowBrowserRecoveryPath(
        `boss-paegi-oauth-flow-${FLOW_B}=${FLOW_B}`,
      ),
      `/auth/flow-pending?flow=${FLOW_B}`,
    );

    values.set(OAUTH_FLOW_BROWSER_BARRIER_KEY, "{");
    assert.equal(
      resolveOAuthFlowBrowserRecoveryPath(""),
      "/auth/flow-pending",
    );
  } finally {
    restore();
  }
});

test("H-held recovery aborts while queued for S without running late SDK work and releases H", async () => {
  const values = new Map<string, string>();
  const restore = installWindowStorage({
    getItem(key) {
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      values.set(key, value);
    },
    removeItem(key) {
      values.delete(key);
    },
  });
  const manager = new QueueingLockManager();
  const storageLockName = "lock:boss-paegi-auth";
  const holder = new AbortController();
  let releaseStorageLock!: () => void;
  const storageReleased = new Promise<void>((resolve) => {
    releaseStorageLock = resolve;
  });
  let storageHeld!: () => void;
  const storageAcquired = new Promise<void>((resolve) => {
    storageHeld = resolve;
  });
  const heldStorage = manager.request(
    storageLockName,
    { mode: "exclusive", signal: holder.signal },
    async () => {
      storageHeld();
      await storageReleased;
    },
  );

  try {
    await storageAcquired;
    const recovery = new AbortController();
    let acquiredH!: () => void;
    const hAcquired = new Promise<void>((resolve) => {
      acquiredH = resolve;
    });
    let sdkWorkStarted = false;
    const running = runAuthCrossContextExclusive(
      recovery.signal,
      async () => {
        acquiredH();
        return runSignalAwareSupabaseAuthLock(
          storageLockName,
          recovery.signal,
          async () => {
            sdkWorkStarted = true;
          },
          manager,
        );
      },
      manager,
    );
    await hAcquired;

    const reason = new Error("recovery_disposed_while_waiting_for_s");
    recovery.abort(reason);
    await assert.rejects(
      running,
      (error: unknown) => error === reason,
    );
    assert.equal(sdkWorkStarted, false);

    let laterHStarted = false;
    await runAuthCrossContextExclusive(
      new AbortController().signal,
      async () => {
        laterHStarted = true;
      },
      manager,
    );
    assert.equal(laterHStarted, true);
  } finally {
    releaseStorageLock();
    await heldStorage;
    restore();
  }
});

test("full-receipt recovery distinguishes structural Auth-cookie corruption from browser IO failure", () => {
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

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: {
          hostname: "app.example.test",
          pathname: "/auth/flow-pending",
          protocol: "https:"
        }
      }
    });
    let cookieValue =
      "sb-project-auth-token=%7Bstructurally-broken";
    const documentValue = {};
    Object.defineProperty(documentValue, "cookie", {
      configurable: true,
      get() {
        return cookieValue;
      }
    });
    Object.defineProperty(globalThis, "document", {
      configurable: true,
      value: documentValue
    });

    const {
      BrowserSupabaseSessionCorruptError,
      readBrowserSupabaseSessionSnapshot
    } = await import("./lib/supabase/client.ts");
    await assert.rejects(
      readBrowserSupabaseSessionSnapshot(),
      (error) =>
        error instanceof BrowserSupabaseSessionCorruptError
    );

    const ioFailure = new DOMException(
      "cookie access denied",
      "SecurityError"
    );
    Object.defineProperty(documentValue, "cookie", {
      configurable: true,
      get() {
        throw ioFailure;
      }
    });
    await assert.rejects(
      readBrowserSupabaseSessionSnapshot(),
      (error) =>
        error === ioFailure &&
        !(error instanceof BrowserSupabaseSessionCorruptError)
    );
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

  const pending = source(
    "app/auth/flow-pending/FlowPendingClient.tsx",
  );
  assert.match(
    pending,
    /catch \(error\) \{[\s\S]*?error instanceof BrowserSupabaseSessionCorruptError[\s\S]*?clearExactTargetSession\(\)[\s\S]*?snapshot = null/,
  );
});

test("every ordinary browser Auth writer consults the durable barrier before network work", () => {
  const client = source("lib/supabase/client.ts");
  const lifecycle = client.slice(
    client.indexOf("async function runExclusiveAuthLifecycle"),
    client.indexOf(
      "export function runSupabaseUnlockedSessionWriter",
    ),
  );
  const barrier = lifecycle.indexOf(
    "browserHasOAuthFlowDurableBarrier()",
  );
  const operation = lifecycle.indexOf(
    "return operation(createClient().auth)",
  );
  assert.ok(barrier >= 0);
  assert.ok(operation > barrier);

  const transport = source("lib/http/auth-transport-fetch.ts");
  const marker = transport.slice(
    transport.indexOf(
      "export function browserHasOAuthFlowMarker",
    ),
    transport.indexOf(
      "function exactVisibleOAuthFlow",
    ),
  );
  assert.match(
    marker,
    /browserHasVisibleOAuthFlowMarker\(\)[\s\S]*?browserHasOAuthFlowDurableBarrier\(\)/,
  );
});

test("null-flow status discovery validates current Auth before the active-flow RPC and returns exact receipts", () => {
  const route = source("app/api/auth/oauth-flow/status/route.ts");
  const post = route.slice(route.indexOf("export async function POST"));

  assert.match(
    post,
    /const requestedFlowId = body\.value\.flowId[\s\S]*?keys\.length !== 1[\s\S]*?keys\[0\] !== "flowId"[\s\S]*?requestedFlowId !== null[\s\S]*?!isOAuthFlowId\(requestedFlowId\)/,
  );

  const header = post.indexOf(
    'const header = request.headers.get("cookie")',
  );
  const proofDiscovery = post.indexOf(
    "discoverOAuthFlowRouteAuthority({",
  );
  const existingBranch = post.indexOf("if (existing)");
  const proofLedgerRead = post.indexOf(
    "readOAuthFlowStatusStrict(",
    existingBranch,
  );
  const raw = post.indexOf(
    "readSupabaseSessionCookieHeader(",
  );
  const rawInvalidFence = post.indexOf(
    'raw.kind === "invalid"',
    existingBranch,
  );
  const noFlowBranch = post.indexOf("if (flowId === null)");
  const auth = post.indexOf(
    "readServerAuthUser({",
    noFlowBranch,
  );
  const unavailableFence = post.indexOf(
    'auth.kind === "unavailable"',
    auth,
  );
  const validIdentityFence = post.indexOf(
    'auth.kind === "valid"',
    unavailableFence,
  );
  const recoverActive = post.indexOf(
    "recoverActiveByObservedSession({",
    validIdentityFence,
  );
  const activeRpc = route.indexOf(
    '"recover_active_oauth_flow_by_observed_session"',
  );
  const absentParse = post.indexOf(
    "parseOAuthFlowDiscoveryAbsent(",
    recoverActive,
  );
  const exactAbsent = post.indexOf(
    '{ ok: true, state: "absent", active: false }',
    absentParse,
  );
  const recovered = post.indexOf(
    "parseOAuthFlowDiscoveredAuthority(",
    recoverActive,
  );
  const validRoleFence = post.indexOf(
    "auth.user.is_anonymous",
    recovered,
  );
  const expiredEvidence = post.indexOf(
    "expiredObservedEvidenceMatches({",
    validRoleFence,
  );
  const sign = post.indexOf(
    "signOAuthFlowRecoveryProof(",
    expiredEvidence,
  );
  const full = post.indexOf(
    "return fullStatusResponse(",
    sign,
  );

  assert.ok(header >= 0);
  assert.ok(proofDiscovery > header);
  assert.ok(existingBranch > raw);
  assert.ok(proofLedgerRead > proofDiscovery);
  assert.ok(raw > proofDiscovery);
  assert.ok(
    proofLedgerRead < rawInvalidFence,
    "a valid proof must remain recoverable even when the unrelated raw Auth cookie is malformed",
  );
  assert.ok(noFlowBranch > raw);
  assert.ok(auth > noFlowBranch);
  assert.ok(unavailableFence > auth);
  assert.ok(validIdentityFence > unavailableFence);
  assert.ok(recoverActive > validIdentityFence);
  assert.ok(activeRpc >= 0);
  assert.ok(absentParse > recoverActive);
  assert.ok(exactAbsent > absentParse);
  assert.ok(recovered > recoverActive);
  assert.ok(validRoleFence > recovered);
  assert.ok(expiredEvidence > validRoleFence);
  assert.ok(sign > expiredEvidence);
  assert.ok(full > sign);

  const discoveryBranch = post.slice(noFlowBranch, full);
  assert.match(
    discoveryBranch,
    /raw\.kind === "invalid"[\s\S]*?raw\.kind === "absent"[\s\S]*?readServerAuthUser\(\{[\s\S]*?accessToken: raw\.session\.accessToken/,
  );
  assert.match(
    discoveryBranch,
    /auth\.user\.id !== raw\.session\.userId[\s\S]*?return response\(\{ error: "auth_session_changed" \}, 409\)/,
  );
  assert.doesNotMatch(
    post.slice(exactAbsent, recovered),
    /\bflowId\b/,
    "the privacy-minimal absent response must not disclose a flow ID",
  );
});

test("FlowPending repairs local state only after an exact null-flow server receipt", () => {
  const client = source(
    "app/auth/flow-pending/FlowPendingClient.tsx",
  );
  const resolve = client.slice(
    client.indexOf("function resolveRecoveryFlow("),
    client.indexOf("function ensureDurableBarrier("),
  );
  assert.match(
    resolve,
    /return candidates\[0\] \?\? null/,
  );
  assert.match(
    resolve,
    /candidates\.every\([\s\S]*?candidate === candidates\[0\][\s\S]*?!isOAuthFlowId\(candidates\[0\]\)[\s\S]*?oauth_recovery_flow_ambiguous/,
  );

  const run = client.slice(
    client.indexOf("async function runRecovery("),
    client.indexOf("export function FlowPendingClient("),
  );
  const resolveCall = run.indexOf("resolveRecoveryFlow(");
  const statusPost = run.indexOf(
    '"/api/auth/oauth-flow/status"',
  );
  const absent = run.indexOf(
    "parseOAuthFlowDiscoveryAbsent(",
    statusPost,
  );
  const absentRepair = run.indexOf(
    "terminalNavigateAfterDiscoveryAbsent()",
    absent,
  );
  const discovered = run.indexOf(
    "parseOAuthFlowDiscoveredStatus(",
    absent,
  );
  const recoveredFlow = run.indexOf(
    "const recoveredFlowId =",
    discovered,
  );
  const exactStatusFence = run.indexOf(
    "if (!status)",
    recoveredFlow,
  );
  const activeRepair = run.indexOf(
    "ensureDurableBarrier(",
    exactStatusFence,
  );
  const minimal = run.indexOf(
    "const minimal = parseOAuthFlowMinimalRecovery(",
    statusPost,
  );
  const minimalSnapshot = run.indexOf(
    "readBrowserSupabaseSessionSnapshot()",
    minimal,
  );
  const invalidSessionRepair = run.indexOf(
    "clearExactTargetSession()",
    minimalSnapshot,
  );
  const minimalTerminal = run.indexOf(
    "terminalNavigate(",
    invalidSessionRepair,
  );

  assert.ok(resolveCall >= 0);
  assert.ok(statusPost > resolveCall);
  assert.match(
    run.slice(resolveCall, absent),
    /\{ flowId \}/,
    "null must be sent as the sole discovery body field",
  );
  assert.ok(absent > statusPost);
  assert.ok(absentRepair > absent);
  assert.ok(discovered > absent);
  assert.ok(recoveredFlow > discovered);
  assert.ok(exactStatusFence > recoveredFlow);
  assert.ok(activeRepair > exactStatusFence);
  assert.ok(minimal > statusPost);
  assert.ok(minimalSnapshot > minimal);
  assert.ok(invalidSessionRepair > minimalSnapshot);
  assert.ok(minimalTerminal > invalidSessionRepair);
  assert.doesNotMatch(
    run.slice(statusPost, absent),
    /reconcileOAuthFlowBrowserBarrier|ensureDurableBarrier/,
  );
  assert.doesNotMatch(
    run.slice(discovered, exactStatusFence),
    /reconcileOAuthFlowBrowserBarrier|ensureDurableBarrier/,
  );
  assert.match(
    run.slice(minimal, minimalTerminal),
    /try \{[\s\S]*?readBrowserSupabaseSessionSnapshot\(\)[\s\S]*?\} catch \(error\) \{[\s\S]*?error instanceof[\s\S]*?BrowserSupabaseSessionCorruptError[\s\S]*?throw error[\s\S]*?clearExactTargetSession\(\)/,
  );

  const absentTerminal = client.slice(
    client.indexOf(
      "function terminalNavigateAfterDiscoveryAbsent()",
    ),
    client.indexOf("function clearExactTargetSession()"),
  );
  assert.match(
    absentTerminal,
    /readExactVisibleOAuthCallbackFlow\(\) !== null[\s\S]*?readOAuthFlowBrowserBarrier\(\) !== null[\s\S]*?clearBrowserSupabaseOAuthVerifierStorage\(\)[\s\S]*?assertBrowserSupabaseOAuthVerifierStorageCleared\(\)[\s\S]*?window\.location\.replace\("\/"\)/,
  );
  assert.doesNotMatch(
    absentTerminal,
    /clearMalformedOAuthFlowBrowserBarrierAfterAbsent/,
  );
});

test("SessionBootstrap confirms discovery before ordinary Auth and redirects active flows without ensureAuth", () => {
  const bootstrap = source("components/SessionBootstrap.tsx");
  const effect = bootstrap.slice(
    bootstrap.indexOf("useEffect(() => {"),
  );
  const liveResolver = effect.indexOf(
    "resolveOAuthFlowBrowserRecoveryPath(document.cookie)",
  );
  const knownRedirect = effect.indexOf(
    "window.location.replace(",
    liveResolver,
  );
  const discovery = effect.indexOf(
    "await discoverOAuthFlowBeforeBootstrap(",
    knownRedirect,
  );
  const discoveredFlowFence = effect.indexOf(
    "discoveredFlow !== null",
    discovery,
  );
  const discoveryRedirect = effect.indexOf(
    "window.location.replace(",
    discoveredFlowFence,
  );
  const client = effect.indexOf(
    "const sb = createClient()",
    discoveryRedirect,
  );
  const ensure = effect.indexOf(
    "await ensureAuth(controller.signal)",
    client,
  );

  assert.ok(liveResolver >= 0);
  assert.ok(knownRedirect > liveResolver);
  assert.ok(discovery > knownRedirect);
  assert.ok(discoveredFlowFence > discovery);
  assert.ok(discoveryRedirect > discoveredFlowFence);
  assert.ok(client > discoveryRedirect);
  assert.ok(ensure > client);
  assert.match(
    effect.slice(discovery, client),
    /await discoverOAuthFlowBeforeBootstrap\([\s\S]*?if \(discoveredFlow !== null\)[\s\S]*?\/auth\/flow-pending\?flow=[\s\S]*?return;/,
  );
  const catchAfterEnsure = effect.indexOf(
    "resolveOAuthFlowBrowserRecoveryPath(document.cookie)",
    ensure,
  );
  const catchRedirect = effect.indexOf(
    "window.location.replace(liveRecoveryPath)",
    catchAfterEnsure,
  );
  const releaseOwner = effect.indexOf(
    "reconciliation?.release()",
    catchRedirect,
  );
  const clearOwner = effect.indexOf(
    "reconciliation = null",
    releaseOwner,
  );
  const scheduleRetry = effect.indexOf(
    "retry = setTimeout(",
    clearOwner,
  );
  assert.ok(catchAfterEnsure > ensure);
  assert.ok(catchRedirect > catchAfterEnsure);
  assert.ok(releaseOwner > catchRedirect);
  assert.ok(clearOwner > releaseOwner);
  assert.ok(scheduleRetry > clearOwner);
  assert.doesNotMatch(
    effect.slice(catchAfterEnsure, scheduleRetry),
    /failBootstrap\(|location\.reload\(|\.inert\s*=/,
  );

  // A transient bootstrap failure owns only local cleanup+retry. It must not
  // enter the stable-identity invalidation path, which makes the document
  // inert and reloads it.
  const retryWitness = {
    reloads: 0,
    bodyInert: false,
    ownerReleases: 0,
    retries: 0,
  };
  retryWitness.ownerReleases += 1;
  retryWitness.retries += 1;
  assert.deepEqual(retryWitness, {
    reloads: 0,
    bodyInert: false,
    ownerReleases: 1,
    retries: 1,
  });

  const discoveryHelperStart = bootstrap.indexOf(
    "async function discoverOAuthFlowBeforeBootstrap(",
  );
  const effectOwner = bootstrap.indexOf(
    "function SessionBootstrapEffects({",
  );
  assert.ok(discoveryHelperStart >= 0);
  assert.ok(effectOwner > discoveryHelperStart);
  const helper = bootstrap.slice(
    discoveryHelperStart,
    effectOwner,
  );
  const post = helper.indexOf(
    '"/api/auth/oauth-flow/status"',
  );
  const nullBody = helper.indexOf(
    "JSON.stringify({ flowId: null })",
    post,
  );
  const absentParse = helper.indexOf(
    "parseOAuthFlowDiscoveryAbsent(",
    nullBody,
  );
  const absentReturn = helper.indexOf(
    "return null",
    absentParse,
  );
  const fullParse = helper.indexOf(
    "parseOAuthFlowDiscoveredStatus(",
    absentReturn,
  );
  const markerFence = helper.indexOf(
    "readExactVisibleOAuthCallbackFlow() !== flowId",
    fullParse,
  );
  const barrierRepair = helper.indexOf(
    "reconcileOAuthFlowBrowserBarrier(flowId, true)",
    markerFence,
  );

  // v0.84: 로컬 플로우 마커(콜백 쿠키·durable barrier)가 둘 다 없으면 서버 discovery
  // 왕복을 생략한다 — 스킵 판정이 POST 이전에 와야 하며, 두 마커 리더를 모두 본다.
  const localSkip = helper.indexOf(
    "readExactVisibleOAuthCallbackFlow() === null",
  );
  const localSkipBarrier = helper.indexOf(
    "readOAuthFlowBrowserBarrier() === null",
    localSkip,
  );
  assert.ok(localSkip >= 0);
  assert.ok(localSkipBarrier > localSkip);
  assert.ok(localSkip < post);

  assert.ok(post >= 0);
  assert.ok(nullBody > post);
  assert.ok(absentParse > nullBody);
  assert.ok(absentReturn > absentParse);
  assert.ok(fullParse > absentReturn);
  assert.ok(markerFence > fullParse);
  assert.ok(barrierRepair > markerFence);
  assert.match(
    helper,
    /credentials: "same-origin"[\s\S]*?cache: "no-store"[\s\S]*?redirect: "error"/,
  );
  assert.match(
    helper,
    /runAuthCrossContextExclusive\([\s\S]*?startSupabaseUnlockedSessionWriter\([\s\S]*?fetch\(/,
  );
  assert.doesNotMatch(
    helper,
    /ensureAuth\(|createClient\(|auth\.getSession\(/,
  );
});

test("root SSR stays visible while every ordinary client effect remains behind selective hydration", () => {
  const layout = source("app/layout.tsx");
  const bootstrap = source("components/SessionBootstrap.tsx");
  const gateOpen = layout.indexOf("<SessionBootstrap>");
  const analytics = layout.indexOf(
    "<AnalyticsVisitTracker />",
    gateOpen,
  );
  const navigation = layout.indexOf("<AppNav />", gateOpen);
  const providers = layout.indexOf(
    "<SiteContentProvider",
    gateOpen,
  );
  const routeChildren = layout.indexOf("{children}", providers);
  const footer = layout.indexOf("<SiteFooter", routeChildren);
  const gateClose = layout.indexOf(
    "</SessionBootstrap>",
    footer,
  );

  assert.ok(gateOpen >= 0);
  assert.ok(analytics > gateOpen);
  assert.ok(navigation > analytics);
  assert.ok(providers > navigation);
  assert.ok(routeChildren > providers);
  assert.ok(footer > routeChildren);
  assert.ok(gateClose > footer);

  const ordinaryEffects = bootstrap.indexOf(
    "function SessionBootstrapEffects({",
  );
  const discovery = bootstrap.indexOf(
    "await discoverOAuthFlowBeforeBootstrap(",
    ordinaryEffects,
  );
  const ensure = bootstrap.indexOf(
    "await ensureAuth(controller.signal)",
    discovery,
  );
  const readyRelease = bootstrap.indexOf("onReady()", ensure);
  const fence = bootstrap.indexOf(
    "function OrdinaryHydrationFence({",
    readyRelease,
  );
  const browserSuspend = bootstrap.indexOf(
    'if (typeof window !== "undefined" && !gate.ready)',
    fence,
  );
  const pendingThrow = bootstrap.indexOf(
    "throw gate.pending",
    browserSuspend,
  );
  const serverChildren = bootstrap.indexOf(
    "return <>{children}</>",
    pendingThrow,
  );
  const ordinaryOwner = bootstrap.indexOf(
    "function OrdinarySessionBootstrap({",
    serverChildren,
  );
  const effectMount = bootstrap.indexOf(
    "<SessionBootstrapEffects onReady={gate.release} />",
    ordinaryOwner,
  );
  const suspenseOpen = bootstrap.indexOf(
    "<Suspense fallback={null}>",
    effectMount,
  );
  const fencedChildren = bootstrap.indexOf(
    "<OrdinaryHydrationFence gate={gate}>",
    suspenseOpen,
  );
  const suspenseClose = bootstrap.indexOf(
    "</Suspense>",
    fencedChildren,
  );

  assert.ok(ordinaryEffects >= 0);
  assert.ok(discovery > ordinaryEffects);
  assert.ok(ensure > discovery);
  assert.ok(readyRelease > ensure);
  assert.ok(fence > readyRelease);
  assert.ok(browserSuspend > fence);
  assert.ok(pendingThrow > browserSuspend);
  assert.ok(serverChildren > pendingThrow);
  assert.ok(ordinaryOwner > serverChildren);
  assert.ok(effectMount > ordinaryOwner);
  assert.ok(suspenseOpen > effectMount);
  assert.ok(fencedChildren > suspenseOpen);
  assert.ok(suspenseClose > fencedChildren);
  assert.match(
    bootstrap,
    /function createOrdinaryHydrationGate\(\): OrdinaryHydrationGate \{[\s\S]*?const pending = new Promise<void>[\s\S]*?get ready\(\)[\s\S]*?release\(\)[\s\S]*?ready = true;[\s\S]*?resolvePending\?\.\(\);/,
  );
  assert.match(
    bootstrap.slice(fence, ordinaryOwner),
    /if \(typeof window !== "undefined" && !gate\.ready\) \{[\s\S]*?throw gate\.pending;[\s\S]*?\}[\s\S]*?return <>\{children\}<\/>;/,
  );
  assert.match(
    bootstrap.slice(ordinaryOwner),
    /const \[gate\] = useState\(createOrdinaryHydrationGate\);[\s\S]*?<SessionBootstrapEffects onReady=\{gate\.release\} \/>[\s\S]*?<Suspense fallback=\{null\}>[\s\S]*?<OrdinaryHydrationFence gate=\{gate\}>[\s\S]*?\{children\}[\s\S]*?<\/OrdinaryHydrationFence>[\s\S]*?<\/Suspense>/,
  );
  assert.match(
    bootstrap,
    /if \(isAuthSubtreePath\(pathname\)\) return <>\{children\}<\/>;/,
  );

  // State-machine witness: server rendering always exposes content; the first
  // browser pass retains that completed HTML but schedules zero descendant
  // effects; only the post-discovery+Auth release hydrates those descendants.
  const renderBoundary = ({
    browser,
    ready,
  }: {
    browser: boolean;
    ready: boolean;
  }) => ({
    initialHtmlVisible: true,
    descendantEffects: browser && ready ? 1 : 0,
    suspended: browser && !ready,
  });
  assert.deepEqual(renderBoundary({ browser: false, ready: false }), {
    initialHtmlVisible: true,
    descendantEffects: 0,
    suspended: false,
  });
  assert.deepEqual(renderBoundary({ browser: true, ready: false }), {
    initialHtmlVisible: true,
    descendantEffects: 0,
    suspended: true,
  });
  assert.deepEqual(renderBoundary({ browser: true, ready: true }), {
    initialHtmlVisible: true,
    descendantEffects: 1,
    suspended: false,
  });
});
