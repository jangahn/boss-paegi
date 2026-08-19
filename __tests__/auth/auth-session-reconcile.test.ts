import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AuthClient } from "@supabase/supabase-js";
import {
  AUTH_RECONCILE_MAX_COOKIE_NAMES_CHARS,
  authReconcileCapabilityDigest,
  authReconcileNonRootCookiePaths,
  authReconcilePath,
  authReconcileSessionCasMatches,
  parseAuthReconcileSearchParams,
  type AuthReconcileInput,
  type AuthReconcileSessionCas,
} from "../../lib/auth-reconcile.ts";
import {
  fingerprintSupabaseAuthCookiePairs,
  readRawSupabaseAuthCookieNames,
  readRawSupabaseAuthCookiePairs,
  readRawSupabaseReconcileCookiePairs,
  readSupabaseAccessTokenExpiresAt,
} from "../../lib/supabase/session-cookie.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_ID =
  "22222222-2222-4222-8222-222222222222";
const CAPABILITY =
  "33333333-3333-4333-8333-333333333333";
const SUPABASE_URL = "https://project-ref.supabase.co";
const AUTH_COOKIE =
  "sb-project-ref-auth-token";
const VERIFIER_COOKIE =
  `${AUTH_COOKIE}-code-verifier`;
const COOKIE_NAMES = [
  AUTH_COOKIE,
  `${AUTH_COOKIE}.64`,
  `${AUTH_COOKIE}.foo`,
] as const;

function roundTrip(input: AuthReconcileInput) {
  const path = new URL(
    authReconcilePath(input),
    "https://boss.example",
  );
  const params = Object.fromEntries(path.searchParams);
  return parseAuthReconcileSearchParams(params);
}

test("reconciliation URLs round-trip only exact safe reason/session shapes", () => {
  const exact: AuthReconcileInput[] = [
    {
      reason: "account_deleted",
      next: "/login?error=account_deleted",
      expectedUserId: USER_ID,
      expectedSessionId: SESSION_ID,
      capability: CAPABILITY,
      cookiePath: "/account",
      cookieNames: COOKIE_NAMES,
    },
    {
      reason: "auth_session_check_required",
      next: "/credits?from=expired",
      expectedUserId: USER_ID,
      expectedSessionId: SESSION_ID,
      capability: CAPABILITY,
      cookiePath: "/credits",
      cookieNames: [AUTH_COOKIE],
    },
    {
      reason: "auth_session_invalid",
      next: "/",
      expectedUserId: null,
      expectedSessionId: null,
      capability: CAPABILITY,
      cookiePath: "/",
      cookieNames: [`${AUTH_COOKIE}.foo`],
    },
  ];
  for (const input of exact) {
    assert.deepEqual(roundTrip(input), input);
  }

  for (const malformed of [
    {},
    { reason: "account_deleted", next: "/" },
    {
      reason: "account_deleted",
      next: "/",
      expectedUser: USER_ID,
      expectedSession: "not-a-session",
      capability: CAPABILITY,
      cookieNames: AUTH_COOKIE,
      cookiePath: "/",
    },
    {
      reason: "auth_session_check_required",
      next: "https://evil.example",
      expectedUser: USER_ID,
      expectedSession: SESSION_ID,
      capability: CAPABILITY,
      cookieNames: AUTH_COOKIE,
      cookiePath: "/",
    },
    {
      reason: "auth_session_invalid",
      next: "/",
      expectedUser: USER_ID,
      capability: CAPABILITY,
      cookieNames: AUTH_COOKIE,
      cookiePath: "/",
    },
    {
      reason: "auth_session_invalid",
      next: "/",
      extra: "1",
      capability: CAPABILITY,
      cookieNames: AUTH_COOKIE,
      cookiePath: "/",
    },
    {
      reason: "auth_session_invalid",
      next: "/",
      capability: CAPABILITY,
      cookieNames: `${AUTH_COOKIE}.foo,${AUTH_COOKIE}.64`,
      cookiePath: "/",
    },
    {
      reason: "auth_session_invalid",
      next: "/",
      capability: CAPABILITY,
      cookieNames: `${AUTH_COOKIE},${AUTH_COOKIE}`,
      cookiePath: "/",
    },
    {
      reason: "auth_session_invalid",
      next: "/",
      capability: CAPABILITY,
      cookieNames: `${AUTH_COOKIE},evil\r\nset-cookie`,
      cookiePath: "/",
    },
    {
      reason: "auth_session_invalid",
      next: "/",
      capability: CAPABILITY,
      cookieNames: AUTH_COOKIE,
      cookiePath: "/account?leak=1",
    },
  ]) {
    assert.equal(
      parseAuthReconcileSearchParams(malformed),
      null,
      JSON.stringify(malformed),
    );
  }
});

test("capability digest binds the exact canonical pathname, intent, and cookie-name set", async () => {
  const input: AuthReconcileInput = {
    reason: "auth_session_check_required",
    next: "/account?tab=credits",
    expectedUserId: USER_ID,
    expectedSessionId: SESSION_ID,
    capability: CAPABILITY,
    cookiePath: "/account/settings/",
    cookieNames: COOKIE_NAMES,
  };
  const digest = await authReconcileCapabilityDigest(input);
  assert.match(digest, /^[0-9a-f]{64}$/u);
  assert.equal(
    await authReconcileCapabilityDigest({ ...input }),
    digest,
  );
  for (const changed of [
    { ...input, cookiePath: "/account" },
    { ...input, next: "/account?tab=profile" },
    {
      ...input,
      cookieNames: [
        AUTH_COOKIE,
        `${AUTH_COOKIE}.64`,
      ],
    },
    {
      ...input,
      expectedSessionId:
        "44444444-4444-4444-8444-444444444444",
    },
    {
      ...input,
      capability:
        "55555555-5555-4555-8555-555555555555",
    },
  ] satisfies AuthReconcileInput[]) {
    assert.notEqual(
      await authReconcileCapabilityDigest(changed),
      digest,
    );
  }
});

test("cookie cleanup paths preserve RFC segment boundaries, repeated slashes, and trailing slash", () => {
  assert.deepEqual(
    authReconcileNonRootCookiePaths(
      "/account/settings/",
    ),
    [
      "/account",
      "/account/",
      "/account/settings",
      "/account/settings/",
    ],
  );
  assert.deepEqual(
    authReconcileNonRootCookiePaths("/account"),
    ["/account"],
  );
  assert.deepEqual(
    authReconcileNonRootCookiePaths("/a//b"),
    ["/a", "/a/", "/a//", "/a//b"],
  );
  assert.deepEqual(authReconcileNonRootCookiePaths("/"), []);
  for (const invalid of [
    "",
    "//account",
    "/account?tab=1",
    "/account#fragment",
    "/account;Path=/",
    "/account\\admin",
  ]) {
    assert.throws(
      () => authReconcileNonRootCookiePaths(invalid),
      /auth_cookie_cleanup_path_invalid/u,
    );
  }
  assert.equal(
    authReconcileNonRootCookiePaths(
      "/account/settings/",
    ).includes("/acc"),
    false,
  );
});

test("raw cookie-name capture includes arbitrary safe suffixes but never values", () => {
  const secretA = "secret-access-token";
  const secretB = "secret-refresh-token";
  const names = readRawSupabaseAuthCookieNames(
    [
      `unrelated=${secretA}`,
      `${AUTH_COOKIE}.foo=${secretA}`,
      `${AUTH_COOKIE}.64=${secretB}`,
      `${AUTH_COOKIE}.foo=duplicate-path-value`,
      `${AUTH_COOKIE}`,
    ].join("; "),
    SUPABASE_URL,
  );
  assert.deepEqual(names, COOKIE_NAMES);
  const serialized = JSON.stringify(names);
  assert.equal(serialized.includes(secretA), false);
  assert.equal(serialized.includes(secretB), false);
  assert.equal(serialized.includes("duplicate-path-value"), false);
});

test("raw reconciliation capability captures auth and verifier base/arbitrary chunks without values", () => {
  const names = readRawSupabaseAuthCookieNames(
    [
      `${VERIFIER_COOKIE}.foo=pkce-secret-a`,
      `${AUTH_COOKIE}.64=access-secret`,
      `${VERIFIER_COOKIE}=pkce-secret-b`,
      `${VERIFIER_COOKIE}.foo=duplicate-scoped`,
      "unrelated=ignored",
      `${AUTH_COOKIE}=refresh-secret`,
    ].join("; "),
    SUPABASE_URL,
  );
  assert.deepEqual(
    names,
    [
      AUTH_COOKIE,
      `${AUTH_COOKIE}.64`,
      VERIFIER_COOKIE,
      `${VERIFIER_COOKIE}.foo`,
    ].sort(),
  );
  const serialized = JSON.stringify(names);
  for (const secret of [
    "pkce-secret-a",
    "access-secret",
    "pkce-secret-b",
    "duplicate-scoped",
    "refresh-secret",
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});

test("session parser stays auth-only while reconciliation proof preserves verifier pairs and malformation", () => {
  const header = [
    `${AUTH_COOKIE}=auth-root`,
    `${VERIFIER_COOKIE}=pkce-root`,
    `${VERIFIER_COOKIE}.foo=pkce-scoped`,
  ].join("; ");
  assert.deepEqual(
    readRawSupabaseAuthCookiePairs(header, SUPABASE_URL),
    {
      kind: "present",
      cookies: [
        { name: AUTH_COOKIE, value: "auth-root" },
      ],
    },
  );
  assert.deepEqual(
    readRawSupabaseReconcileCookiePairs(
      header,
      SUPABASE_URL,
    ),
    {
      kind: "present",
      cookies: [
        { name: AUTH_COOKIE, value: "auth-root" },
        { name: VERIFIER_COOKIE, value: "pkce-root" },
        {
          name: `${VERIFIER_COOKIE}.foo`,
          value: "pkce-scoped",
        },
      ],
    },
  );
  assert.deepEqual(
    readRawSupabaseReconcileCookiePairs(
      `${VERIFIER_COOKIE}.0=%ZZ`,
      SUPABASE_URL,
    ),
    { kind: "invalid" },
  );
});

test("cookie-name capabilities stay below redirect header limits and oversized input fails closed", () => {
  const oversizedNames = Array.from(
    { length: 20 },
    (_, index) =>
      `${AUTH_COOKIE}.${index}${"x".repeat(220)}`,
  ).sort();
  const serialized = oversizedNames.join(",");
  assert.ok(
    serialized.length >
      AUTH_RECONCILE_MAX_COOKIE_NAMES_CHARS,
  );
  assert.equal(
    parseAuthReconcileSearchParams({
      reason: "auth_session_invalid",
      next: "/",
      capability: CAPABILITY,
      cookieNames: serialized,
      cookiePath: "/account",
    }),
    null,
  );
  assert.throws(
    () =>
      authReconcilePath({
        reason: "auth_session_invalid",
        next: "/",
        expectedUserId: null,
        expectedSessionId: null,
        capability: CAPABILITY,
        cookieNames: oversizedNames,
        cookiePath: "/account",
      }),
    /auth_reconcile_cookie_names_invalid/u,
  );
  assert.deepEqual(
    readRawSupabaseAuthCookieNames(
      oversizedNames
        .map((name) => `${name}=opaque`)
        .join("; "),
      SUPABASE_URL,
    ),
    [],
  );
});

test("session reconciliation CAS rejects every newer raw/token/identity state", () => {
  const baseline: AuthReconcileSessionCas = {
    rawCookieBytes: "raw-a",
    cookieFingerprint: "a".repeat(64),
    accessToken: "access-a",
    refreshToken: "refresh-a",
    userId: USER_ID,
    sessionId: SESSION_ID,
  };
  assert.equal(
    authReconcileSessionCasMatches(
      baseline,
      { ...baseline },
    ),
    true,
  );
  assert.equal(
    authReconcileSessionCasMatches(baseline, null),
    false,
  );
  for (const candidate of [
    { ...baseline, rawCookieBytes: "raw-b" },
    {
      ...baseline,
      cookieFingerprint: "b".repeat(64),
    },
    { ...baseline, accessToken: "access-b" },
    { ...baseline, refreshToken: "refresh-b" },
    {
      ...baseline,
      userId: "44444444-4444-4444-8444-444444444444",
    },
    {
      ...baseline,
      sessionId:
        "55555555-5555-4555-8555-555555555555",
    },
  ]) {
    assert.equal(
      authReconcileSessionCasMatches(
        baseline,
        candidate,
      ),
      false,
    );
  }
});

test("non-persisting Auth probe contains auth-js session_not_found without touching storage", async () => {
  const realStorage = new Map([
    [AUTH_COOKIE, "newer-real-session"],
  ]);
  const probeKey = `${AUTH_COOKIE}-reconcile-probe`;
  const removed: string[] = [];
  const probe = new AuthClient({
    url: "https://project-ref.supabase.co/auth/v1",
    headers: {
      apikey: "public-anon-key",
      Authorization: "Bearer public-anon-key",
    },
    storageKey: probeKey,
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("unexpected_probe_storage_write");
      },
      removeItem: (key) => {
        removed.push(key);
      },
    },
    persistSession: false,
    detectSessionInUrl: false,
    autoRefreshToken: false,
    skipAutoInitialize: true,
    fetch: (async () =>
      new Response(
        JSON.stringify({
          error_code: "session_not_found",
          msg: "Session not found",
        }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
          },
        },
      )) as typeof fetch,
  });

  const result = await probe.getUser("stale-access-token");
  assert.equal(result.data.user, null);
  assert.equal(result.error?.name, "AuthSessionMissingError");
  assert.deepEqual(removed, []);
  assert.equal(
    realStorage.get(AUTH_COOKIE),
    "newer-real-session",
  );
});

test("cookie-pair fingerprint is order-independent but retains duplicate multiplicity and values", async () => {
  const root = [
    { name: AUTH_COOKIE, value: "root-session" },
  ];
  const duplicate = [
    ...root,
    { name: AUTH_COOKIE, value: "root-session" },
  ];
  const scoped = [
    { name: `${AUTH_COOKIE}.foo`, value: "scoped" },
    ...root,
  ];
  assert.equal(
    await fingerprintSupabaseAuthCookiePairs(scoped),
    await fingerprintSupabaseAuthCookiePairs(
      [...scoped].reverse(),
    ),
  );
  assert.notEqual(
    await fingerprintSupabaseAuthCookiePairs(root),
    await fingerprintSupabaseAuthCookiePairs(duplicate),
  );
  assert.notEqual(
    await fingerprintSupabaseAuthCookiePairs(root),
    await fingerprintSupabaseAuthCookiePairs(scoped),
  );
});

test("a residual root/HttpOnly verifier changes the server proof fingerprint", async () => {
  const authOnly = [
    { name: AUTH_COOKIE, value: "root-session" },
  ];
  const raw = readRawSupabaseReconcileCookiePairs(
    `${AUTH_COOKIE}=root-session; ${VERIFIER_COOKIE}=http-only-pkce`,
    SUPABASE_URL,
  );
  assert.equal(raw.kind, "present");
  if (raw.kind !== "present") {
    throw new Error("expected_reconcile_cookie_pairs");
  }
  assert.notEqual(
    await fingerprintSupabaseAuthCookiePairs(authOnly),
    await fingerprintSupabaseAuthCookiePairs(raw.cookies),
  );
});

test("proxy routes exact raw-cookie identity to isolated reconciliation before generic gates", () => {
  const source = readFileSync(
    new URL("../../proxy.ts", import.meta.url),
    "utf8",
  );
  const isolated = source.indexOf(
    'path === "/auth/reconcile"',
  );
  const raw = source.indexOf(
    "await readSupabaseSessionCookieHeader(",
  );
  const boundNames = source.indexOf(
    "readRawSupabaseAuthCookieNames(",
  );
  const boundDigest = source.indexOf(
    "await authReconcileCapabilityDigest(input)",
  );
  const update = source.indexOf("await updateSession(request)");
  const invalid = source.indexOf(
    'reason: "auth_session_invalid"',
    raw,
  );
  const refresh = source.indexOf(
    'reason: "auth_session_check_required"',
    raw,
  );
  const deleted = source.indexOf(
    'reason: "account_deleted"',
    refresh,
  );
  assert.ok(isolated >= 0);
  assert.ok(boundNames >= 0);
  assert.ok(boundDigest > boundNames);
  assert.ok(raw > isolated);
  assert.ok(invalid > raw);
  assert.ok(update > invalid);
  assert.ok(refresh > update);
  assert.ok(deleted > refresh);
  // v0.85: 서명 유효 + 만료만이 원인인 공개 GET/HEAD 요청은 격리 복구 대신 익명
  // 통과 — 만료 분류(exp 리더)는 updateSession 뒤·격리 복구 앞에 있어야 하고,
  // 회원 전용 경로·비-GET/HEAD 는 종전대로 격리 복구를 유지해야 한다.
  const expiredRead = source.indexOf(
    "readSupabaseAccessTokenExpiresAt(",
  );
  assert.ok(expiredRead > update);
  assert.ok(expiredRead < refresh);
  assert.match(
    source,
    /const expiredOnly =[\s\S]*?!user &&[\s\S]*?expiresAt \* 1000 <= Date\.now\(\)/u,
  );
  assert.match(
    source,
    /!expiredOnly \|\|[\s\S]*?isMemberOnlyPath\(path\) \|\|[\s\S]*?request\.method !== "GET" && request\.method !== "HEAD"/u,
  );
  assert.match(
    source,
    /expectedUserId: rawAuthSession\.session\.userId,[\s\S]*expectedSessionId:\s*rawAuthSession\.session\.sessionId/u,
  );
  assert.doesNotMatch(
    source,
    /app_metadata\?\.session_id|user_metadata\?\.session_id/u,
  );
});

test("browser reconciliation fences refresh and deleted-account cleanup by the exact UUID pair", () => {
  const client = readFileSync(
    new URL("../../lib/supabase/client.ts", import.meta.url),
    "utf8",
  );
  const reconcile = client.slice(
    client.indexOf(
      "export function reconcileBrowserSupabaseSession",
    ),
    client.indexOf(
      "export function clearBrowserSupabaseAuthStorageExclusive",
    ),
  );
  const lifecycle = reconcile.indexOf(
    "runExclusiveAuthLifecycle(",
  );
  const before = reconcile.indexOf(
    "readBrowserSupabaseSessionSnapshot()",
  );
  const getSession = reconcile.indexOf(
    "await auth.getSession()",
  );
  const getUser = reconcile.indexOf(
    "createAuthReconcileProbeClient().getUser(",
  );
  const definitive = reconcile.indexOf(
    "isInvalidSessionReadError(",
  );
  const storageLock = reconcile.indexOf(
    "await startSupabaseUnlockedSessionWriter(",
  );
  const rejectedCas = reconcile.indexOf(
    "exactBrowserSessionSnapshot(before, committed)",
    storageLock,
  );
  const rejectedClear = reconcile.indexOf(
    "clearBrowserSupabaseAuthStorage()",
    rejectedCas,
  );
  const committed = reconcile.lastIndexOf(
    "readBrowserSupabaseSessionSnapshot()",
  );
  assert.ok(lifecycle >= 0);
  assert.ok(before > lifecycle);
  assert.ok(getSession > before);
  assert.ok(getUser > getSession);
  assert.ok(definitive > getUser);
  assert.ok(storageLock > definitive);
  assert.ok(rejectedCas > storageLock);
  assert.ok(rejectedClear > rejectedCas);
  assert.ok(committed > getUser);
  assert.match(
    reconcile,
    /identity\.userId !== expected\.userId \|\|[\s\S]*identity\.sessionId !== expected\.sessionId/u,
  );
  assert.match(
    reconcile,
    /session\.access_token !== before\.evidence\.accessToken \|\|[\s\S]*session\.refresh_token !== before\.evidence\.refreshToken/u,
  );
  assert.match(
    reconcile,
    /authoritative\.error !== null[\s\S]*!isInvalidSessionReadError\(authoritative\.error\)[\s\S]*throw authoritative\.error/u,
  );

  const probeFactory = client.slice(
    client.indexOf(
      "function createAuthReconcileProbeClient",
    ),
    client.indexOf(
      "function callbackLogicalStorageKey",
    ),
  );
  assert.match(
    probeFactory,
    /storageKey: `\$\{authStorageKey\(\)\}-reconcile-probe`/u,
  );
  assert.match(probeFactory, /persistSession: false/u);
  assert.match(probeFactory, /skipAutoInitialize: true/u);
  assert.match(probeFactory, /removeItem: \(\) => \{\}/u);

  const clear = client.slice(
    client.indexOf(
      "export function clearBrowserSupabaseAuthStorageExclusive",
    ),
    client.indexOf(
      "export function establishAnonymousAuthSession",
    ),
  );
  const exactNames = clear.indexOf(
    "exactObservedAuthCookieNames(cookieNames)",
  );
  const scoped = clear.indexOf(
    "includeRoot: false",
  );
  const verifierRoot = clear.indexOf(
    "[authCodeVerifierKey()]",
    scoped,
  );
  const verifierKnownChunks = clear.indexOf(
    "includeKnownChunkNames: true",
    verifierRoot,
  );
  const verifierRootEnabled = clear.indexOf(
    "includeRoot: true",
    verifierRoot,
  );
  const current = clear.indexOf(
    "readBrowserSupabaseSessionSnapshot()",
  );
  const preserveProbe = clear.indexOf(
    "current.cookieFingerprint",
  );
  const rootTombstones = clear.indexOf(
    "includeKnownChunkNames: true",
    preserveProbe,
  );
  const absentProbe = clear.indexOf(
    "await fingerprintSupabaseAuthCookiePairs([])",
  );
  assert.ok(exactNames >= 0);
  assert.ok(scoped > exactNames);
  assert.ok(verifierRoot > scoped);
  assert.ok(verifierKnownChunks > verifierRoot);
  assert.ok(verifierRootEnabled > verifierKnownChunks);
  assert.ok(current > verifierRootEnabled);
  assert.ok(preserveProbe > current);
  assert.ok(rootTombstones > preserveProbe);
  assert.ok(absentProbe > rootTombstones);
  assert.match(
    clear,
    /additionalPathnames: \[cookiePath\]/u,
  );
  assert.match(
    clear,
    /\[authStorageKey\(\), authCodeVerifierKey\(\)\],[\s\S]*includeCurrentPath: true,[\s\S]*includeRoot: false,[\s\S]*verifyVisibleAbsence: false/u,
  );
  assert.match(
    clear,
    /exactVerifierNames = exactNames\.filter\([\s\S]*authCodeVerifierKey\(\)[\s\S]*clearVisibleBrowserCookiePrefixes\([\s\S]*\[authCodeVerifierKey\(\)\],[\s\S]*explicitNames: exactVerifierNames,[\s\S]*includeRoot: true/u,
  );
  assert.match(
    clear,
    /assertReconciledAuthCookieState\([\s\S]*current\.cookieFingerprint[\s\S]*includeKnownChunkNames: true[\s\S]*assertBrowserSupabaseSessionCleared\(\)[\s\S]*assertReconciledAuthCookieState/u,
  );
  assert.match(
    client,
    /async function assertReconciledAuthCookieState\([\s\S]*originalPathname,[\s\S]*window\.location\.pathname,[\s\S]*for \(const pathname of pathnames\)[\s\S]*assertAuthCookieStateAtPath\(/u,
  );

  const authOAuth = readFileSync(
    new URL("../../lib/auth-oauth.ts", import.meta.url),
    "utf8",
  );
  const exact = authOAuth.slice(
    authOAuth.indexOf("async function signOutExact"),
    authOAuth.indexOf(
      "export async function signOut",
    ),
  );
  const identity = exact.indexOf(
    "readSupabaseAccessTokenIdentity",
  );
  const required = exact.indexOf(
    "requiredSession !== undefined",
  );
  const server = exact.indexOf(
    'fetch("/api/auth/signout"',
  );
  assert.ok(identity >= 0);
  assert.ok(required > identity);
  assert.ok(server > required);
});

test("non-root first pass removes original and reconcile-path cookies while preserving a valid root cookie", () => {
  const originalPaths =
    authReconcileNonRootCookiePaths("/account");
  const reconcilePaths =
    authReconcileNonRootCookiePaths("/auth/reconcile");
  const deletedPaths = new Set([
    ...originalPaths,
    ...reconcilePaths,
  ]);
  assert.equal(deletedPaths.has("/"), false);
  assert.deepEqual(
    ["/", "/account", "/auth", "/auth/reconcile"].filter(
      (path) => !deletedPaths.has(path),
    ),
    ["/"],
  );
  assert.equal(deletedPaths.has("/account"), true);
  assert.equal(deletedPaths.has("/auth"), true);
  assert.equal(deletedPaths.has("/auth/reconcile"), true);
});

test("hostile direct navigation has no cleanup authority and scoped-cookie repair is path-bound", () => {
  const page = readFileSync(
    new URL("../../app/auth/reconcile/page.tsx", import.meta.url),
    "utf8",
  );
  const parsed = page.indexOf(
    "parseAuthReconcileSearchParams(",
  );
  const cookies = page.indexOf(
    ".getAll(AUTH_RECONCILE_CAPABILITY_COOKIE)",
  );
  const exact = page.indexOf(
    "capabilityCookies.length === 1",
  );
  const digest = page.indexOf(
    "await authReconcileCapabilityDigest(parsed)",
  );
  const match = page.indexOf(
    "capabilityCookies[0].value === expected",
  );
  const render = page.indexOf(
    "<AuthReconcileClient input={input}",
  );
  assert.ok(parsed >= 0);
  assert.ok(cookies > parsed);
  assert.ok(exact > cookies);
  assert.ok(digest > exact);
  assert.ok(match > digest);
  assert.ok(render > match);

  const proxy = readFileSync(
    new URL("../../proxy.ts", import.meta.url),
    "utf8",
  );
  const nonce = proxy.indexOf(
    "const capability = crypto.randomUUID()",
  );
  const path = proxy.indexOf(
    "cookiePath: request.nextUrl.pathname",
  );
  const names = proxy.indexOf(
    "readRawSupabaseAuthCookieNames(",
    path,
  );
  const digestCookie = proxy.indexOf(
    "await authReconcileCapabilityDigest(input)",
    names,
  );
  const cookie = proxy.indexOf(
    "AUTH_RECONCILE_CAPABILITY_COOKIE",
    nonce,
  );
  assert.ok(nonce >= 0);
  assert.ok(path > nonce);
  assert.ok(names > path);
  assert.ok(digestCookie > names);
  assert.ok(cookie > digestCookie);
  assert.match(
    proxy.slice(cookie),
    /httpOnly: true,[\s\S]*sameSite: "lax",[\s\S]*path: "\/auth\/reconcile",[\s\S]*maxAge: 90/u,
  );
  assert.match(
    proxy,
    /request\.method !== "HEAD"[\s\S]*sec-fetch-site"\) !== "same-origin"[\s\S]*readRawSupabaseReconcileCookiePairs\([\s\S]*fingerprintSupabaseAuthCookiePairs\([\s\S]*status: matched \? 204 : 409/u,
  );
  assert.match(
    proxy,
    /request\.method === "GET" \|\| request\.method === "HEAD"[\s\S]*\? 307[\s\S]*: 303/u,
  );
});


function unsignedJwt(payload: unknown): string {
  const b64 = (value: string) =>
    Buffer.from(value, "utf8")
      .toString("base64")
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/u, "");
  return `${b64('{"alg":"HS256"}')}.${b64(JSON.stringify(payload))}.sig`;
}

test("access token exp reader classifies expiry without trusting shape drift", () => {
  assert.equal(
    readSupabaseAccessTokenExpiresAt(
      unsignedJwt({ exp: 1_700_000_000, sub: USER_ID }),
    ),
    1_700_000_000,
  );
  for (const bad of [
    "",
    "not-a-jwt",
    "a.b",
    unsignedJwt({}),
    unsignedJwt({ exp: "1700000000" }),
    unsignedJwt({ exp: 1.5 }),
    unsignedJwt({ exp: 0 }),
    unsignedJwt({ exp: -10 }),
    unsignedJwt([1, 2]),
    `${"x".repeat(70 * 1024)}.y.z`,
  ]) {
    assert.equal(readSupabaseAccessTokenExpiresAt(bad), null, bad.slice(0, 24));
  }
});
