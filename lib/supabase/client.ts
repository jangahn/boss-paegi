"use client";

import {
  combineChunks,
  createBrowserClient,
  createChunks,
  DEFAULT_COOKIE_OPTIONS,
  serializeCookieHeader,
  stringFromBase64URL,
  stringToBase64URL,
} from "@supabase/ssr";
import { PUBLIC_ENV } from "@/lib/env";
import { supabaseAuthCookieOptions } from "@/lib/supabase/auth-cookie-options";
import {
  AuthClient,
  type LockFunc,
  type Session,
} from "@supabase/supabase-js";
import {
  requireAnonymousSignInSession,
  requireSuccessfulSessionRead,
} from "@/lib/auth-session-policy";
import {
  isInvalidSessionReadError,
} from "@/lib/auth-read-policy";
import {
  failClosedSupabaseAuthLock,
  runAuthCrossContextExclusive,
  runSignalAwareSupabaseAuthLock,
} from "@/lib/auth-cross-context";
import {
  browserHasOAuthFlowDurableBarrier,
  readOAuthFlowBrowserBarrier,
} from "@/lib/oauth-flow-browser-barrier";
import {
  armOAuthCallbackPkceTransport,
  armOAuthCallbackUserTransport,
  armOAuthRecoveryRefreshTransport,
  assertOAuthCallbackTransportConsumed,
  beginOAuthCallbackTransportScope,
  browserHasOAuthFlowMarker,
  createAuthTransportFetch,
  endOAuthCallbackTransportScope,
  oauthCallbackExchangeSafety,
  oauthCallbackFlowBarrierMatches,
  oauthCallbackLockAcquireTimeout,
  poisonOAuthCallbackTransportScope,
  readExactVisibleOAuthCallbackFlow,
  type OAuthCallbackTargetBinding,
  type OAuthCallbackTargetEvidence,
} from "@/lib/http/auth-transport-fetch";
import {
  isOAuthFlowId,
  OAuthFlowLeaseError,
} from "@/lib/oauth-flow-lease";
import {
  getOrCreateSynchronousFetchScope,
  type SynchronousFetchScope,
} from "@/lib/http/synchronous-fetch-scope";
import {
  fingerprintSupabaseAuthCookiePairs,
  readSupabaseAccessTokenIdentity,
  readSupabaseSessionCookie,
  type SupabaseSessionCookieEvidence,
} from "@/lib/supabase/session-cookie";
import {
  AUTH_RECONCILE_MAX_COOKIE_NAMES_CHARS,
  AUTH_RECONCILE_PROBE_ACK_HEADER,
  AUTH_RECONCILE_PROBE_HEADER,
  authReconcileNonRootCookiePaths,
  authReconcileSessionCasMatches,
} from "@/lib/auth-reconcile";
import {
  readBoundedResponseBytes,
} from "@/lib/http/bounded-response";

// @supabase/ssr keeps its browser singleton through Fast Refresh. Keep the
// fetch scope equally stable so that a refreshed caller and the retained
// client's custom fetch always share the same operation state.
const AUTH_REQUEST_SCOPE_KEY = Symbol.for(
  "boss-paegi.supabase.auth-request-scope.v1",
);
// Deriving the storage key parses PUBLIC_ENV.SUPABASE_URL. Defer that parse to
// first use so an env-less server prerender can evaluate this module, while a
// real use without the configured URL still fails closed.
let cachedAuthStorageKey: string | null = null;
function authStorageKey(): string {
  if (cachedAuthStorageKey === null) {
    cachedAuthStorageKey =
      `sb-${new URL(PUBLIC_ENV.SUPABASE_URL).hostname.split(".")[0]}-auth-token`;
  }
  return cachedAuthStorageKey;
}
function authCodeVerifierKey(): string {
  return `${authStorageKey()}-code-verifier`;
}
export function authSdkLockName(): string {
  return `lock:${authStorageKey()}`;
}
const exactSupabaseAuthLock: LockFunc = (
  name,
  acquireTimeout,
  operation,
) => {
  if (name !== authSdkLockName()) {
    return Promise.reject(
      new Error("unexpected_supabase_auth_lock_name"),
    );
  }
  return failClosedSupabaseAuthLock(
    name,
    oauthCallbackLockAcquireTimeout(acquireTimeout),
    operation,
  );
};
const globalScopes = globalThis as unknown as Record<symbol, unknown>;
const retainedScope = globalScopes[AUTH_REQUEST_SCOPE_KEY] as
  | Record<string, unknown>
  | undefined;
const requiresAuthClientReload =
  typeof window !== "undefined" &&
  retainedScope !== undefined &&
  (typeof retainedScope.runExclusive !== "function" ||
    typeof retainedScope.updateFetcher !== "function");
if (requiresAuthClientReload) {
  // The pre-upgrade singleton still owns the old fetch closure. It cannot be
  // rewired safely in place, so fail closed and replace the JS realm once.
  queueMicrotask(() => window.location.reload());
}
// Creating the transport parses PUBLIC_ENV.SUPABASE_URL, so defer scope
// creation to first use. The globalThis-retained scope keeps the singleton
// stable across Fast Refresh exactly as before.
let cachedAuthRequestScope: SynchronousFetchScope | null = null;
function authRequestScope(): SynchronousFetchScope {
  if (cachedAuthRequestScope === null) {
    cachedAuthRequestScope = getOrCreateSynchronousFetchScope(
      globalScopes,
      AUTH_REQUEST_SCOPE_KEY,
      createAuthTransportFetch({
        supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
      }),
    );
  }
  return cachedAuthRequestScope;
}
export function createClient() {
  if (requiresAuthClientReload) {
    throw new Error("auth_client_upgrade_reload_required");
  }
  return createBrowserClient(
    PUBLIC_ENV.SUPABASE_URL,
    PUBLIC_ENV.SUPABASE_ANON_KEY,
    {
      cookieOptions: supabaseAuthCookieOptions(),
      // @supabase/ssr's default is singleton only in a real browser. Omitting
      // isSingleton preserves that default and prevents an accidental
      // server-pre-render call from entering its module-global client cache.
      auth: {
        storageKey: authStorageKey(),
        lock: exactSupabaseAuthLock,
        // The callback page performs one explicitly H/S-serialized PKCE
        // exchange. Automatic URL detection would consume the code during
        // singleton initialization before that capability is armed.
        detectSessionInUrl: false,
        // Never cache a poisoned initializePromise merely because another
        // tab's legitimate refresh/retry held the SDK lock longer than one
        // request deadline. auth-js passes 0 for best-effort auto-refresh
        // ticks, so those still skip a busy lock without stealing it.
        lockAcquireTimeout: -1,
      },
      global: { fetch: authRequestScope().fetch },
    },
  );
}

/**
 * `AuthClient.getUser(jwt)` removes its configured storage when GoTrue returns
 * `session_not_found`, even when the JWT was supplied explicitly. Reconcile
 * must classify that response before mutating the real browser session, so the
 * authoritative probe owns an isolated non-persisting storage adapter.
 */
function createAuthReconcileProbeClient() {
  return new AuthClient({
    url: new URL(
      "/auth/v1",
      PUBLIC_ENV.SUPABASE_URL,
    ).href,
    headers: {
      Authorization: `Bearer ${PUBLIC_ENV.SUPABASE_ANON_KEY}`,
      apikey: PUBLIC_ENV.SUPABASE_ANON_KEY,
    },
    storageKey: `${authStorageKey()}-reconcile-probe`,
    storage: {
      getItem: () => null,
      setItem: () => {
        throw new Error("auth_reconcile_probe_storage_write");
      },
      // Auth-js clears its own isolated adapter on session_not_found. This is
      // deliberately a no-op; the real cookie is cleared only after exact CAS
      // while H→S is held below.
      removeItem: () => {},
    },
    persistSession: false,
    detectSessionInUrl: false,
    autoRefreshToken: false,
    skipAutoInitialize: true,
    fetch: authRequestScope().fetch,
  });
}

function callbackLogicalStorageKey(capabilityId: string): string {
  if (!isOAuthFlowId(capabilityId)) {
    throw new Error("oauth_callback_storage_key_invalid");
  }
  return `${authStorageKey()}-oauth-callback-${capabilityId}`;
}

function createOAuthCallbackClient(capabilityId: string) {
  const storageKey = callbackLogicalStorageKey(capabilityId);
  return new AuthClient({
    url: new URL(
      "/auth/v1",
      PUBLIC_ENV.SUPABASE_URL,
    ).href,
    headers: {
      Authorization: `Bearer ${PUBLIC_ENV.SUPABASE_ANON_KEY}`,
      apikey: PUBLIC_ENV.SUPABASE_ANON_KEY,
    },
    // auth-js broadcasts every persisted session on a channel named after
    // storageKey. A capability-unique logical key prevents the unfinalized
    // callback target from reaching ordinary auth-storage-key subscribers.
    // The adapter below maps only the SDK's three logical keys back to the
    // established physical SSR cookie names.
    storageKey,
    storage: createOAuthCallbackCookieStorage(storageKey),
    persistSession: true,
    flowType: "pkce",
    detectSessionInUrl: false,
    autoRefreshToken: false,
    // No SupabaseClient wrapper is constructed: its unconditional
    // onAuthStateChange listener emits INITIAL_SESSION and can refresh/remove
    // the source cookie even when AuthClient auto-initialize is disabled.
    // This purpose-built AuthClient has neither that listener nor an internal
    // S lock; the callback owns one outer exact S for its full lifecycle.
    skipAutoInitialize: true,
    fetch: authRequestScope().fetch,
  });
}

export type OAuthCallbackAuthClient =
  ReturnType<typeof createOAuthCallbackClient>;

const DOCUMENT_COOKIE_MAX_CHARS = 1024 * 1024;
const AUTH_USER_MAX_RESPONSE_BYTES = 256 * 1024;
const AUTH_REFRESH_MAX_RESPONSE_BYTES = 256 * 1024;
const AUTH_TOKEN_MAX_CHARS = 64 * 1024;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type BrowserSupabaseSessionSnapshot = {
  rawCookieBytes: string;
  cookieFingerprint: string;
  evidence: SupabaseSessionCookieEvidence;
};

export class BrowserSupabaseSessionCorruptError extends Error {
  constructor() {
    super("browser_supabase_session_corrupt");
    this.name = "BrowserSupabaseSessionCorruptError";
  }
}

function rawNameCouldDecodeToPrefix(
  rawName: string,
  prefix: string,
): boolean {
  let decodedPrefix = "";
  for (
    let index = 0;
    index < rawName.length &&
    decodedPrefix.length < prefix.length;
    index += 1
  ) {
    if (rawName[index] !== "%") {
      decodedPrefix += rawName[index];
      continue;
    }
    const hex = rawName.slice(index + 1, index + 3);
    if (!/^[0-9a-f]{2}$/iu.test(hex)) {
      // An invalid escape cannot complete a still-partial target prefix.
      // Treat it as ours only after the valid prefix bytes are complete.
      return decodedPrefix.startsWith(prefix);
    }
    decodedPrefix += String.fromCharCode(
      Number.parseInt(hex, 16),
    );
    index += 2;
  }
  return (
    decodedPrefix.startsWith(prefix) ||
    prefix.startsWith(decodedPrefix)
  );
}

function currentDocumentCookieHeader(): string {
  if (typeof document === "undefined") {
    throw new Error("browser_cookie_unavailable");
  }
  const cookieHeader = document.cookie;
  if (
    typeof cookieHeader !== "string" ||
    cookieHeader.length > DOCUMENT_COOKIE_MAX_CHARS
  ) {
    throw new Error("browser_cookie_unavailable");
  }
  return cookieHeader;
}

function rawDocumentCookieEntriesForPrefix(
  prefix: string,
  cookieHeader = currentDocumentCookieHeader(),
): {
  decoded: { name: string; value: string }[];
  rawCookieBytes: string;
} {
  const decoded: { name: string; value: string }[] = [];
  const raw: string[] = [];
  for (const entry of cookieHeader.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const rawName =
      equals < 0 ? trimmed : trimmed.slice(0, equals);
    let name: string;
    try {
      name = decodeURIComponent(rawName);
    } catch {
      if (rawNameCouldDecodeToPrefix(rawName, prefix)) {
        throw new Error("browser_cookie_name_invalid");
      }
      continue;
    }
    if (name !== prefix && !name.startsWith(`${prefix}.`)) {
      continue;
    }
    if (equals < 0) {
      throw new Error("browser_cookie_value_invalid");
    }
    const rawValue = trimmed.slice(equals + 1);
    let value: string;
    try {
      value = decodeURIComponent(rawValue);
    } catch {
      throw new Error("browser_cookie_value_invalid");
    }
    decoded.push({ name, value });
    // Delimit lengths as well as bytes so no name/value boundary can collide.
    raw.push(
      `${rawName.length}:${rawName}:${rawValue.length}:${rawValue}`,
    );
  }
  return {
    decoded,
    rawCookieBytes: raw.sort().join("|"),
  };
}

async function readExactBrowserStorageJson(
  key: string,
  maxChunks: number,
  maxChars: number,
): Promise<string | null> {
  const matching =
    rawDocumentCookieEntriesForPrefix(key).decoded;
  if (matching.length === 0) return null;
  const names = new Set(matching.map(({ name }) => name));
  if (names.size !== matching.length) {
    throw new Error("browser_storage_cookie_invalid");
  }
  const hasBase = names.has(key);
  const chunkIndexes = [...names]
    .filter((name) => name !== key)
    .map((name) => {
      const suffix = name.slice(key.length + 1);
      return /^(?:0|[1-9][0-9]*)$/u.test(suffix) &&
        suffix.length <= 3
        ? Number(suffix)
        : Number.NaN;
    })
    .sort((left, right) => left - right);
  if (
    (hasBase && chunkIndexes.length !== 0) ||
    (!hasBase &&
      (chunkIndexes.length === 0 ||
        chunkIndexes.length > maxChunks ||
        chunkIndexes.some(
          (value, index) =>
            !Number.isSafeInteger(value) ||
            value !== index,
        )))
  ) {
    throw new Error("browser_storage_cookie_invalid");
  }
  const values = new Map(
    matching.map(({ name, value }) => [name, value]),
  );
  const combined = await combineChunks(
    key,
    (name) => values.get(name),
  );
  if (
    !combined ||
    combined.length > maxChars
  ) {
    throw new Error("browser_storage_cookie_invalid");
  }
  let json: string;
  try {
    json = combined.startsWith("base64-")
      ? stringFromBase64URL(
          combined.slice("base64-".length),
        )
      : combined;
    JSON.parse(json);
  } catch {
    throw new Error("browser_storage_cookie_invalid");
  }
  return json;
}

export async function readBrowserSupabaseSessionSnapshot():
Promise<BrowserSupabaseSessionSnapshot | null> {
  let selected: ReturnType<
    typeof rawDocumentCookieEntriesForPrefix
  >;
  try {
    selected =
      rawDocumentCookieEntriesForPrefix(authStorageKey());
  } catch (error) {
    if (
      error instanceof Error &&
      (
        error.message === "browser_cookie_name_invalid" ||
        error.message === "browser_cookie_value_invalid"
      )
    ) {
      throw new BrowserSupabaseSessionCorruptError();
    }
    throw error;
  }
  if (selected.decoded.length === 0) return null;
  const evidence = await readSupabaseSessionCookie(
    selected.decoded,
    PUBLIC_ENV.SUPABASE_URL,
  );
  if (!evidence) {
    throw new BrowserSupabaseSessionCorruptError();
  }
  return {
    rawCookieBytes: selected.rawCookieBytes,
    cookieFingerprint:
      await fingerprintSupabaseAuthCookiePairs(
        selected.decoded,
      ),
    evidence,
  };
}

export function assertBrowserSupabaseSessionCleared(): void {
  const cookieHeader = currentDocumentCookieHeader();
  const authCookies =
    rawDocumentCookieEntriesForPrefix(
      authStorageKey(),
      cookieHeader,
    );
  const verifierCookies =
    rawDocumentCookieEntriesForPrefix(
      authCodeVerifierKey(),
      cookieHeader,
    );
  if (
    authCookies.decoded.length !== 0 ||
    verifierCookies.decoded.length !== 0
  ) {
    throw new Error("oauth_callback_auth_cookie_not_cleared");
  }
}

export function assertBrowserSupabaseOAuthVerifierStorageCleared():
void {
  if (
    rawDocumentCookieEntriesForPrefix(
      authCodeVerifierKey(),
    ).decoded.length !== 0
  ) {
    throw new Error("oauth_callback_verifier_cookie_not_cleared");
  }
}

function visibleCookieNamesForPrefixes(
  prefixes: readonly string[],
): string[] {
  const cookieHeader = currentDocumentCookieHeader();
  const names = new Set<string>();
  for (const entry of cookieHeader.split(";")) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const equals = trimmed.indexOf("=");
    const rawName =
      equals < 0 ? trimmed : trimmed.slice(0, equals);
    let decodedName: string | null = null;
    let malformedTarget = false;
    try {
      decodedName = decodeURIComponent(rawName);
    } catch {
      malformedTarget = prefixes.some((prefix) =>
          rawNameCouldDecodeToPrefix(rawName, prefix),
        );
      if (!malformedTarget) {
        continue;
      }
    }
    const matches = (name: string) =>
      prefixes.some(
        (prefix) =>
          name === prefix ||
          name.startsWith(`${prefix}.`),
      );
    if (
      malformedTarget ||
      matches(rawName) ||
      (decodedName !== null && matches(decodedName))
    ) {
      names.add(rawName);
      if (decodedName !== null) names.add(decodedName);
    }
  }
  return [...names];
}

function visibleCookieDeletionPaths(
  additionalPathnames: readonly string[] = [],
  options: {
    includeRoot?: boolean;
    includeCurrentPath?: boolean;
  } = {},
): string[] {
  const paths = new Set<string>();
  if (options.includeRoot !== false) paths.add("/");
  for (const pathname of [
    ...(
      options.includeCurrentPath === false
        ? []
        : [window.location.pathname]
    ),
    ...additionalPathnames,
  ]) {
    if (
      pathname.length === 0 ||
      pathname.length > 2_048 ||
      !pathname.startsWith("/") ||
      /[;?#\\\u0000-\u001f\u007f]/u.test(pathname)
    ) {
      throw new Error("auth_cookie_cleanup_path_invalid");
    }
    for (const path of authReconcileNonRootCookiePaths(
      pathname,
    )) {
      paths.add(path);
    }
  }
  return [...paths];
}

function visibleCookieDeletionDomains(): (string | null)[] {
  const hostname = window.location.hostname.toLowerCase();
  const domains = new Set<string | null>([null]);
  if (
    hostname.length > 0 &&
    /^[a-z0-9.-]+$/u.test(hostname)
  ) {
    const labels = hostname.split(".").filter(Boolean);
    for (
      let index = 0;
      index < Math.max(1, labels.length - 1);
      index += 1
    ) {
      domains.add(labels.slice(index).join("."));
    }
  }
  return [...domains];
}

function clearVisibleBrowserCookiePrefixes(
  prefixes: readonly string[],
  options: {
    additionalPathnames?: readonly string[];
    explicitNames?: readonly string[];
    includeCurrentPath?: boolean;
    includeKnownChunkNames?: boolean;
    includeRoot?: boolean;
    verifyVisibleAbsence?: boolean;
  } = {},
): void {
  const names = new Set(
    visibleCookieNamesForPrefixes(prefixes),
  );
  for (const name of options.explicitNames ?? []) {
    names.add(name);
  }
  if (options.includeKnownChunkNames === true) {
    for (const prefix of prefixes) {
      names.add(prefix);
      for (
        let index = 0;
        index < 64;
        index += 1
      ) {
        names.add(`${prefix}.${index}`);
      }
    }
  }
  const paths = visibleCookieDeletionPaths(
    options.additionalPathnames,
    {
      includeCurrentPath: options.includeCurrentPath,
      includeRoot: options.includeRoot,
    },
  );
  const domains = visibleCookieDeletionDomains();
  for (const name of names) {
    if (
      name.length === 0 ||
      /[;=\s\u0000-\u001f\u007f]/u.test(name)
    ) {
      throw new Error("oauth_callback_auth_cookie_name_invalid");
    }
    for (const path of paths) {
      for (const domain of domains) {
        document.cookie =
          `${name}=; Max-Age=0; ` +
          "Expires=Thu, 01 Jan 1970 00:00:00 GMT; " +
          `Path=${path}; SameSite=Lax` +
          (domain === null ? "" : `; Domain=${domain}`) +
          (window.location.protocol === "https:"
            ? "; Secure"
            : "");
      }
    }
  }
  if (options.verifyVisibleAbsence === false) return;
  const cookieHeader = currentDocumentCookieHeader();
  for (const prefix of prefixes) {
    if (
      rawDocumentCookieEntriesForPrefix(
        prefix,
        cookieHeader,
      ).decoded.length !== 0
    ) {
      throw new Error("oauth_callback_auth_cookie_not_cleared");
    }
  }
}

/**
 * Clears browser-owned @supabase/ssr auth and verifier cookies while the
 * caller holds H→S. It tries every visible path/domain tuple because
 * document.cookie does not expose those attributes, then proves strict raw
 * absence. The server route revokes the exact remote session first and never
 * writes delayed auth-cookie tombstones.
 */
export function clearBrowserSupabaseAuthStorage(): void {
  clearVisibleBrowserCookiePrefixes([
    authStorageKey(),
    authCodeVerifierKey(),
  ]);
  assertBrowserSupabaseSessionCleared();
}

export function clearBrowserSupabaseOAuthVerifierStorage():
void {
  clearVisibleBrowserCookiePrefixes([
    authCodeVerifierKey(),
  ]);
  assertBrowserSupabaseOAuthVerifierStorageCleared();
}

function createOAuthCallbackCookieStorage(
  logicalStorageKey: string,
) {
  const physicalKeys = new Map([
    [logicalStorageKey, authStorageKey()],
    [
      `${logicalStorageKey}-code-verifier`,
      authCodeVerifierKey(),
    ],
    [
      `${logicalStorageKey}-user`,
      `${authStorageKey()}-user`,
    ],
  ]);
  const physicalKey = (key: string): string => {
    const mapped = physicalKeys.get(key);
    if (mapped === undefined) {
      throw new Error("oauth_callback_storage_key_invalid");
    }
    return mapped;
  };
  return {
    getItem: async (key: string): Promise<string | null> => {
      const physical = physicalKey(key);
      return readExactBrowserStorageJson(
        physical,
        physical === authCodeVerifierKey() ? 16 : 64,
        physical === authCodeVerifierKey()
          ? 4_096
          : 128 * 1024,
      );
    },
    setItem: async (
      key: string,
      value: string,
    ): Promise<void> => {
      const physical = physicalKey(key);
      if (
        value.length === 0 ||
        value.length > 128 * 1024
      ) {
        throw new Error("oauth_callback_storage_value_invalid");
      }
      try {
        JSON.parse(value);
      } catch {
        throw new Error("oauth_callback_storage_value_invalid");
      }
      clearVisibleBrowserCookiePrefixes([physical]);
      const chunks = createChunks(
        physical,
        `base64-${stringToBase64URL(value)}`,
      );
      if (
        chunks.length === 0 ||
        chunks.length > 64
      ) {
        throw new Error("oauth_callback_storage_value_invalid");
      }
      const cookieOptions = {
        ...DEFAULT_COOKIE_OPTIONS,
        ...supabaseAuthCookieOptions(),
      };
      for (const chunk of chunks) {
        document.cookie = serializeCookieHeader(
          chunk.name,
          chunk.value,
          cookieOptions,
        );
      }
      const committed = await readExactBrowserStorageJson(
        physical,
        64,
        128 * 1024,
      );
      if (committed !== value) {
        throw new Error("oauth_callback_storage_commit_mismatch");
      }
    },
    removeItem: async (key: string): Promise<void> => {
      clearVisibleBrowserCookiePrefixes([physicalKey(key)]);
    },
  };
}

function exactBrowserSessionSnapshot(
  before: BrowserSupabaseSessionSnapshot,
  after: BrowserSupabaseSessionSnapshot | null,
): after is BrowserSupabaseSessionSnapshot {
  const flatten = (
    snapshot: BrowserSupabaseSessionSnapshot,
  ) => ({
    rawCookieBytes: snapshot.rawCookieBytes,
    cookieFingerprint: snapshot.cookieFingerprint,
    accessToken: snapshot.evidence.accessToken,
    refreshToken: snapshot.evidence.refreshToken,
    userId: snapshot.evidence.userId,
    sessionId: snapshot.evidence.sessionId,
  });
  return authReconcileSessionCasMatches(
    flatten(before),
    after === null ? null : flatten(after),
  );
}

function parseOAuthRecoveryRefreshSession(
  value: unknown,
  expected: { userId: string; sessionId: string },
): Session | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const accessToken = record.access_token;
  const refreshToken = record.refresh_token;
  const expiresIn = record.expires_in;
  const user = record.user;
  if (
    typeof accessToken !== "string" ||
    typeof refreshToken !== "string" ||
    refreshToken.length === 0 ||
    refreshToken.length > AUTH_TOKEN_MAX_CHARS ||
    /[\s\u0000-\u001f\u007f]/u.test(refreshToken) ||
    typeof expiresIn !== "number" ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn <= 0 ||
    expiresIn > 31_536_000 ||
    record.token_type !== "bearer" ||
    user === null ||
    typeof user !== "object" ||
    Array.isArray(user)
  ) {
    return null;
  }
  const identity =
    readSupabaseAccessTokenIdentity(accessToken);
  const userRecord = user as Record<string, unknown>;
  if (
    !identity ||
    identity.userId !== expected.userId ||
    identity.sessionId !== expected.sessionId ||
    userRecord.id !== expected.userId ||
    userRecord.is_anonymous !== false ||
    typeof userRecord.aud !== "string" ||
    userRecord.app_metadata === null ||
    typeof userRecord.app_metadata !== "object" ||
    Array.isArray(userRecord.app_metadata) ||
    userRecord.user_metadata === null ||
    typeof userRecord.user_metadata !== "object" ||
    Array.isArray(userRecord.user_metadata) ||
    typeof userRecord.created_at !== "string" ||
    userRecord.created_at.length === 0
  ) {
    return null;
  }
  const expiresAt =
    Math.floor(Date.now() / 1_000) + expiresIn;
  if (!Number.isSafeInteger(expiresAt)) return null;
  return {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_in: expiresIn,
    expires_at: expiresAt,
    token_type: "bearer",
    user: user as Session["user"],
  };
}

const DEFINITIVE_REFRESH_REJECTION_CODES = new Set([
  "bad_jwt",
  "invalid_grant",
  "refresh_token_already_used",
  "refresh_token_not_found",
  "session_expired",
  "session_not_found",
  "user_banned",
  "user_not_found",
]);

function definitiveRefreshRejection(
  status: number,
  contentType: string | undefined,
  value: unknown,
): boolean {
  if (
    ![400, 401, 403, 422].includes(status) ||
    contentType !== "application/json" ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const record = value as Record<string, unknown>;
  const candidates = [
    record.code,
    record.error_code,
    record.error,
  ];
  return candidates.some(
    (candidate) =>
      typeof candidate === "string" &&
      DEFINITIVE_REFRESH_REJECTION_CODES.has(candidate),
  );
}

async function readAuthoritativeOAuthUser(
  accessToken: string,
  expectedUserId: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await authRequestScope().fetch(
    new URL("/auth/v1/user", PUBLIC_ENV.SUPABASE_URL),
    {
      method: "GET",
      headers: {
        accept: "application/json",
        apikey: PUBLIC_ENV.SUPABASE_ANON_KEY,
        authorization: `Bearer ${accessToken}`,
      },
      credentials: "omit",
      cache: "no-store",
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal,
    },
  );
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  const body = await readBoundedResponseBytes(
    response,
    AUTH_USER_MAX_RESPONSE_BYTES,
    signal,
  );
  if (
    response.status !== 200 ||
    contentType !== "application/json" ||
    !body.ok
  ) {
    throw new Error("oauth_callback_user_response_invalid");
  }
  let value: unknown;
  try {
    const text = new TextDecoder("utf-8", {
      fatal: true,
    }).decode(body.bytes);
    value = JSON.parse(text) as unknown;
  } catch {
    throw new Error("oauth_callback_user_response_invalid");
  }
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (value as Record<string, unknown>).id !== expectedUserId ||
    (value as Record<string, unknown>).is_anonymous !== false
  ) {
    throw new Error("oauth_callback_user_mismatch");
  }
}

export async function readBrowserSupabaseOAuthVerifier():
Promise<string> {
  const matching = rawDocumentCookieEntriesForPrefix(
    authCodeVerifierKey(),
  ).decoded;
  const names = new Set(matching.map(({ name }) => name));
  if (names.size !== matching.length || names.size === 0) {
    throw new Error("oauth_code_verifier_cookie_invalid");
  }
  const hasBase = names.has(authCodeVerifierKey());
  const chunkIndexes = [...names]
    .filter((name) => name !== authCodeVerifierKey())
    .map((name) => {
      const suffix = name.slice(
        authCodeVerifierKey().length + 1,
      );
      return /^(?:0|[1-9][0-9]*)$/u.test(suffix)
        ? Number(suffix)
        : Number.NaN;
    })
    .sort((left, right) => left - right);
  if (
    (hasBase && chunkIndexes.length !== 0) ||
    (!hasBase &&
      (chunkIndexes.some(
        (value, index) => value !== index,
      ) ||
        chunkIndexes.length > 16))
  ) {
    throw new Error("oauth_code_verifier_cookie_invalid");
  }
  const values = new Map(
    matching.map(({ name, value }) => [name, value]),
  );
  const combined = await combineChunks(
    authCodeVerifierKey(),
    (name) => values.get(name),
  );
  if (!combined || combined.length > 4_096) {
    throw new Error("oauth_code_verifier_cookie_invalid");
  }
  let json: string;
  try {
    json = combined.startsWith("base64-")
      ? stringFromBase64URL(
          combined.slice("base64-".length),
        )
      : combined;
  } catch {
    throw new Error("oauth_code_verifier_cookie_invalid");
  }
  let stored: unknown;
  try {
    stored = JSON.parse(json) as unknown;
  } catch {
    throw new Error("oauth_code_verifier_cookie_invalid");
  }
  if (
    typeof stored !== "string" ||
    !/^[A-Za-z0-9._~-]{32,512}$/u.test(stored)
  ) {
    throw new Error("oauth_code_verifier_cookie_invalid");
  }
  return stored;
}

async function runExclusiveAuthLifecycle<T>(
  signal: AbortSignal,
  operation: (
    auth: ReturnType<typeof createClient>["auth"],
  ) => Promise<T>,
): Promise<T> {
  return authRequestScope().runExclusive(signal, () =>
    runAuthCrossContextExclusive(
      signal,
      () => {
        if (
          typeof document !== "undefined" &&
          (
            browserHasOAuthFlowMarker() ||
            browserHasOAuthFlowDurableBarrier()
          )
        ) {
          throw new OAuthFlowLeaseError(
            "oauth_flow_already_active",
          );
        }
        return operation(createClient().auth);
      },
    ),
  );
}

/**
 * auth-js v2 does not put signInAnonymously, signInWithPassword, or the PKCE
 * verifier write in its storage lock. Wrap only those known non-locking
 * writers with the exact SDK lock name; wrapping methods that already call
 * `_acquireLock` would deadlock and is intentionally forbidden.
 */
export function runSupabaseUnlockedSessionWriter<T>(
  operation: () => Promise<T>,
): Promise<T> {
  return exactSupabaseAuthLock(
    authSdkLockName(),
    -1,
    operation,
  );
}

export function startSupabaseUnlockedSessionWriter<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return runSignalAwareSupabaseAuthLock(
    authSdkLockName(),
    signal,
    () => authRequestScope().start(signal, operation),
  );
}

export type BrowserSessionReconcileResult =
  | {
      kind: "active";
      userId: string;
      sessionId: string;
    }
  | { kind: "absent" };

/**
 * Reconciles one exact browser session after the read-only server boundary
 * refused to refresh it. The browser owns H, auth-js owns its exact S lock,
 * and every pre/post observation is fenced by raw bytes, both tokens, and the
 * user+session UUID pair so a newer login can never be adopted or overwritten
 * by the stale navigation.
 */
export function reconcileBrowserSupabaseSession(
  expected: { userId: string; sessionId: string },
  signal: AbortSignal,
): Promise<BrowserSessionReconcileResult> {
  if (
    !isOAuthFlowId(expected.userId) ||
    !isOAuthFlowId(expected.sessionId) ||
    signal.aborted
  ) {
    return Promise.reject(
      signal.reason ??
        new Error("auth_reconcile_expected_invalid"),
    );
  }
  return runExclusiveAuthLifecycle(signal, async (auth) => {
    const before =
      await readBrowserSupabaseSessionSnapshot();
    if (before === null) return { kind: "absent" };
    if (
      before.evidence.userId !== expected.userId ||
      before.evidence.sessionId !== expected.sessionId
    ) {
      throw new Error("auth_reconcile_session_changed");
    }

    const current = await auth.getSession();
    if (current.error || current.data.session === null) {
      const after =
        await readBrowserSupabaseSessionSnapshot();
      if (after === null) return { kind: "absent" };
      if (
        after.evidence.userId !== expected.userId ||
        after.evidence.sessionId !== expected.sessionId
      ) {
        throw new Error("auth_reconcile_session_changed");
      }
      throw (
        current.error ??
        new Error("auth_reconcile_session_unavailable")
      );
    }

    const session = current.data.session;
    const identity =
      readSupabaseAccessTokenIdentity(session.access_token);
    if (
      !identity ||
      identity.userId !== expected.userId ||
      identity.sessionId !== expected.sessionId ||
      session.user.id !== expected.userId ||
      session.access_token !== before.evidence.accessToken ||
      session.refresh_token !== before.evidence.refreshToken
    ) {
      throw new Error("auth_reconcile_session_changed");
    }

    const authoritative =
      await createAuthReconcileProbeClient().getUser(
        session.access_token,
      );
    if (
      authoritative.error !== null ||
      authoritative.data.user === null
    ) {
      if (
        authoritative.error !== null &&
        !isInvalidSessionReadError(authoritative.error)
      ) {
        throw authoritative.error;
      }
      await startSupabaseUnlockedSessionWriter(
        signal,
        async () => {
          const committed =
            await readBrowserSupabaseSessionSnapshot();
          if (
            !exactBrowserSessionSnapshot(before, committed)
          ) {
            throw new Error("auth_reconcile_session_changed");
          }
          clearBrowserSupabaseAuthStorage();
          if (
            await readBrowserSupabaseSessionSnapshot() !== null
          ) {
            throw new Error(
              "auth_reconcile_session_clear_unverified",
            );
          }
        },
      );
      return { kind: "absent" };
    }
    if (authoritative.data.user.id !== expected.userId) {
      throw new Error("auth_reconcile_user_mismatch");
    }
    const committed =
      await readBrowserSupabaseSessionSnapshot();
    if (
      !exactBrowserSessionSnapshot(before, committed)
    ) {
      throw new Error("auth_reconcile_session_changed");
    }
    return {
      kind: "active",
      userId: expected.userId,
      sessionId: expected.sessionId,
    };
  });
}

/**
 * A structurally corrupt cookie has no session identity that a server can
 * safely revoke. The proxy capability supplies the exact safe names observed
 * at the original pathname. Delete those names at every original RFC
 * path-match boundary and every currently visible auth/verifier name at the
 * reconciliation pathname's boundaries, always excluding `/`, then re-read
 * root-only storage: preserve a valid root session, or clear a corrupt/absent
 * root. HEAD probes of both the original and reconciliation pathnames compare
 * the full name/value multiset before H→S is released, so an undeleted scoped
 * duplicate or HttpOnly verifier fails visibly instead of entering a redirect
 * loop.
 */
function exactObservedAuthCookieNames(
  cookieNames: readonly string[],
): string[] {
  if (
    cookieNames.length > 144 ||
    cookieNames.some(
      (name) =>
        name.length === 0 ||
        name.length > 256 ||
        (
          (
            name !== authStorageKey() &&
            !name.startsWith(`${authStorageKey()}.`)
          ) &&
          (
            name !== authCodeVerifierKey() &&
            !name.startsWith(
              `${authCodeVerifierKey()}.`,
            )
          )
        ) ||
        !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(name),
    )
  ) {
    throw new Error(
      "auth_reconcile_cookie_names_invalid",
    );
  }
  const canonical = [...cookieNames].sort();
  if (
    canonical.some(
      (name, index) =>
        index > 0 && name === canonical[index - 1],
    ) ||
    canonical.some(
      (name, index) => name !== cookieNames[index],
    ) ||
    canonical.join(",").length >
      AUTH_RECONCILE_MAX_COOKIE_NAMES_CHARS
  ) {
    throw new Error(
      "auth_reconcile_cookie_names_invalid",
    );
  }
  return canonical;
}

async function assertAuthCookieStateAtPath(
  pathname: string,
  expectedFingerprint: string,
  signal: AbortSignal,
): Promise<void> {
  if (
    signal.aborted ||
    !/^[0-9a-f]{64}$/u.test(expectedFingerprint)
  ) {
    throw (
      signal.reason ??
      new Error("auth_reconcile_probe_invalid")
    );
  }
  const response = await fetch(pathname, {
    method: "HEAD",
    credentials: "same-origin",
    headers: {
      [AUTH_RECONCILE_PROBE_HEADER]: expectedFingerprint,
    },
    cache: "no-store",
    redirect: "manual",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (
    response.status !== 204 ||
    response.headers.get(
      AUTH_RECONCILE_PROBE_ACK_HEADER,
    ) !== "1"
  ) {
    throw new Error(
      "auth_reconcile_scoped_cookie_cleanup_unverified",
    );
  }
}

async function assertReconciledAuthCookieState(
  originalPathname: string,
  expectedFingerprint: string,
  signal: AbortSignal,
): Promise<void> {
  const pathnames = new Set([
    originalPathname,
    window.location.pathname,
  ]);
  for (const pathname of pathnames) {
    await assertAuthCookieStateAtPath(
      pathname,
      expectedFingerprint,
      signal,
    );
  }
}

export function clearBrowserSupabaseAuthStorageExclusive(
  signal: AbortSignal,
  cookiePath: string,
  cookieNames: readonly string[],
): Promise<void> {
  return runAuthCrossContextExclusive(signal, () => {
    if (
      browserHasOAuthFlowMarker() ||
      browserHasOAuthFlowDurableBarrier()
    ) {
      throw new OAuthFlowLeaseError(
        "oauth_flow_already_active",
      );
    }
    return startSupabaseUnlockedSessionWriter(
      signal,
      async () => {
        const exactNames =
          exactObservedAuthCookieNames(cookieNames);
        const exactVerifierNames = exactNames.filter(
          (name) =>
            name === authCodeVerifierKey() ||
            name.startsWith(
              `${authCodeVerifierKey()}.`,
            ),
        );
        clearVisibleBrowserCookiePrefixes(
          [authStorageKey(), authCodeVerifierKey()],
          {
            additionalPathnames: [cookiePath],
            explicitNames: exactNames,
            includeCurrentPath: true,
            includeRoot: false,
            verifyVisibleAbsence: false,
          },
        );

        // No OAuth marker/barrier exists above, so no live PKCE operation may
        // own a root verifier. Remove its original/current/root variants
        // before deciding whether the root auth session itself is preservable.
        clearVisibleBrowserCookiePrefixes(
          [authCodeVerifierKey()],
          {
            additionalPathnames: [cookiePath],
            explicitNames: exactVerifierNames,
            includeCurrentPath: true,
            includeKnownChunkNames: true,
            includeRoot: true,
          },
        );

        let current:
          | BrowserSupabaseSessionSnapshot
          | null = null;
        try {
          current =
            await readBrowserSupabaseSessionSnapshot();
          if (current !== null) {
            await assertReconciledAuthCookieState(
              cookiePath,
              current.cookieFingerprint,
              signal,
            );
            return;
          }
        } catch (error) {
          if (
            !(error instanceof BrowserSupabaseSessionCorruptError)
          ) {
            throw error;
          }
        }

        clearVisibleBrowserCookiePrefixes(
          [authStorageKey(), authCodeVerifierKey()],
          {
            additionalPathnames: [cookiePath],
            explicitNames: exactNames,
            includeKnownChunkNames: true,
          },
        );
        assertBrowserSupabaseSessionCleared();
        await assertReconciledAuthCookieState(
          cookiePath,
          await fingerprintSupabaseAuthCookiePairs([]),
          signal,
        );
      },
    );
  });
}

export function establishAnonymousAuthSession(
  signal: AbortSignal,
): Promise<Session> {
  return runExclusiveAuthLifecycle(signal, async (auth) => {
    // Re-read only after both the tab-local queue and origin-wide lock have
    // been acquired. Another tab/HMR generation may have established a
    // session after the caller's optimistic read.
    const current = requireSuccessfulSessionRead(
      await auth.getSession(),
    );
    if (current) {
      const authoritative = await auth.getUser();
      if (
        authoritative.error === null &&
        authoritative.data.user?.id === current.user.id
      ) {
        const committed = requireSuccessfulSessionRead(
          await auth.getSession(),
        );
        if (
          !committed ||
          committed.user.id !== authoritative.data.user.id
        ) {
          throw new Error("auth_session_commit_mismatch");
        }
        return committed;
      }
      // A non-retryable Auth rejection removes the exact invalid session
      // under the SDK lock. Only that proven absence may become a new anon;
      // retryable dependency failures retain the old session and fail closed.
      const afterFailure = requireSuccessfulSessionRead(
        await auth.getSession(),
      );
      if (afterFailure) {
        throw (
          authoritative.error ??
          new Error("auth_user_read_mismatch")
        );
      }
    }
    const established = requireAnonymousSignInSession(
      await startSupabaseUnlockedSessionWriter(signal, () =>
        auth.signInAnonymously(),
      ),
    );
    const committed = requireSuccessfulSessionRead(
      await auth.getSession(),
    );
    if (
      !committed ||
      committed.user.id !== established.user.id ||
      committed.user.is_anonymous !== true
    ) {
      throw new Error("anonymous_session_commit_mismatch");
    }
    return committed;
  });
}

/**
 * Replaces exactly the session the caller observed. The origin-wide lock and
 * in-lock user-id check prevent a second tab's password login from overwriting
 * a newer account session.
 */
export function signInReviewer(
  signal: AbortSignal,
  expectedUserId: string,
  email: string,
  password: string,
): Promise<Session> {
  const normalizedEmail = email.trim().toLowerCase();
  return runExclusiveAuthLifecycle(signal, async (auth) => {
    const current = requireSuccessfulSessionRead(
      await auth.getSession(),
    );
    if (!current || current.user.id !== expectedUserId) {
      throw new Error("auth_session_changed");
    }
    const result = await startSupabaseUnlockedSessionWriter(
      signal,
      () =>
        auth.signInWithPassword({
          email: normalizedEmail,
          password,
        }),
    );
    if (
      result.error ||
      !result.data.session ||
      !result.data.user ||
      result.data.session.user.id !== result.data.user.id
    ) {
      throw new Error("reviewer_credentials_rejected");
    }
    const committed = requireSuccessfulSessionRead(
      await auth.getSession(),
    );
    const authoritative = await auth.getUser();
    const authoritativeUser =
      authoritative.error === null ? authoritative.data.user : null;
    if (
      !committed ||
      !authoritativeUser ||
      committed.user.id !== result.data.user.id ||
      authoritativeUser.id !== result.data.user.id ||
      committed.user.is_anonymous === true ||
      authoritativeUser.is_anonymous === true ||
      committed.user.email?.trim().toLowerCase() !==
        normalizedEmail ||
      authoritativeUser.email?.trim().toLowerCase() !==
        normalizedEmail ||
      committed.user.app_metadata?.reviewer !== true ||
      authoritativeUser.app_metadata?.reviewer !== true
    ) {
      throw new Error("reviewer_session_commit_mismatch");
    }
    return committed;
  });
}

export { runExclusiveAuthLifecycle };

export type OAuthCallbackExchangeEvidence = {
  userId: string;
  sessionId: string;
  accessTokenDigest: string;
  refreshTokenDigest: string;
};

export type OAuthRecoveryRefreshEvidence = {
  userId: string;
  sessionId: string;
  accessTokenSha256: string;
  refreshTokenSha256: string;
};

const OAUTH_RECOVERY_REFRESH_AUTHORITY = Symbol(
  "oauth-recovery-refresh-authority",
);

export type OAuthRecoveryRefreshAuthority = Readonly<{
  reason: "auth_session_refresh_required";
  [OAUTH_RECOVERY_REFRESH_AUTHORITY]: true;
}>;

const pendingOAuthRecoveryRefreshAuthorities =
  new WeakSet<OAuthRecoveryRefreshAuthority>();

/**
 * Mints a one-use refresh authority only from the rotate-target route's exact
 * fail-closed response. Merely having a flow marker, a refresh token, or a
 * locally expired-looking JWT is never sufficient authorization.
 */
export function parseOAuthRecoveryRefreshAuthority(
  response: Pick<Response, "status" | "headers">,
  value: unknown,
): OAuthRecoveryRefreshAuthority | null {
  const contentType = response.headers
    .get("content-type")
    ?.split(";", 1)[0]
    .trim()
    .toLowerCase();
  if (
    response.status !== 409 ||
    contentType !== "application/json" ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 1 ||
    record.error !== "auth_session_refresh_required"
  ) {
    return null;
  }
  const authority = Object.freeze({
    reason: "auth_session_refresh_required" as const,
    [OAUTH_RECOVERY_REFRESH_AUTHORITY]: true as const,
  });
  pendingOAuthRecoveryRefreshAuthorities.add(authority);
  return authority;
}

function consumeOAuthRecoveryRefreshAuthority(
  authority: OAuthRecoveryRefreshAuthority,
): void {
  if (!pendingOAuthRecoveryRefreshAuthorities.delete(authority)) {
    throw new Error("oauth_recovery_refresh_authority_invalid");
  }
}

export class OAuthRecoveryRefreshRejectedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super("oauth_recovery_refresh_rejected");
    this.name = "OAuthRecoveryRefreshRejectedError";
    this.status = status;
  }
}

export class OAuthRecoveryRefreshAmbiguousError extends Error {
  constructor() {
    super("oauth_recovery_refresh_ambiguous");
    this.name = "OAuthRecoveryRefreshAmbiguousError";
  }
}

/**
 * One-shot refresh for a proof-bound claimed OAuth recovery.
 *
 * The caller must already own H→outer exact S. This function independently
 * binds the physical cookie's exact pre-refresh pair, permits one token
 * request, CAS-saves only a same-user/same-session rotation, validates `/user`,
 * and returns digests without exposing either token.
 */
export async function refreshBrowserSupabaseSessionForOAuthRecovery(
  expected: { userId: string; sessionId: string },
  authority: OAuthRecoveryRefreshAuthority,
  signal: AbortSignal,
): Promise<OAuthRecoveryRefreshEvidence> {
  if (
    !isOAuthFlowId(expected.userId) ||
    !isOAuthFlowId(expected.sessionId) ||
    signal.aborted
  ) {
    throw (
      signal.reason ??
      new Error("oauth_recovery_refresh_expected_invalid")
    );
  }
  consumeOAuthRecoveryRefreshAuthority(authority);
  const before = await readBrowserSupabaseSessionSnapshot();
  if (
    !before ||
    before.evidence.userId !== expected.userId ||
    before.evidence.sessionId !== expected.sessionId
  ) {
    throw new Error("oauth_recovery_refresh_source_mismatch");
  }
  const flowId = readExactVisibleOAuthCallbackFlow();
  if (
    flowId === null ||
    !oauthCallbackFlowBarrierMatches(flowId)
  ) {
    throw new OAuthFlowLeaseError(
      "oauth_flow_cookie_invalid",
    );
  }
  const capability =
    beginOAuthCallbackTransportScope(flowId);
  let definitiveStatus: number | null = null;
  try {
    await armOAuthRecoveryRefreshTransport(
      capability,
      before.evidence.refreshToken,
    );
    const response = await authRequestScope().fetch(
      new URL(
        "/auth/v1/token?grant_type=refresh_token",
        PUBLIC_ENV.SUPABASE_URL,
      ),
      {
        method: "POST",
        headers: {
          accept: "application/json",
          apikey: PUBLIC_ENV.SUPABASE_ANON_KEY,
          authorization:
            `Bearer ${PUBLIC_ENV.SUPABASE_ANON_KEY}`,
          "content-type":
            "application/json;charset=UTF-8",
        },
        body: JSON.stringify({
          refresh_token: before.evidence.refreshToken,
        }),
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
      },
    );
    const contentType = response.headers
      .get("content-type")
      ?.split(";", 1)[0]
      .trim()
      .toLowerCase();
    const bounded = await readBoundedResponseBytes(
      response,
      AUTH_REFRESH_MAX_RESPONSE_BYTES,
      signal,
    );
    if (!bounded.ok) {
      throw new Error(
        "oauth_recovery_refresh_response_invalid",
      );
    }
    let value: unknown = null;
    if (contentType === "application/json") {
      try {
        const text = new TextDecoder("utf-8", {
          fatal: true,
        }).decode(bounded.bytes);
        value = JSON.parse(text) as unknown;
      } catch {
        value = null;
      }
    }
    if (response.status !== 200) {
      if (
        definitiveRefreshRejection(
          response.status,
          contentType,
          value,
        )
      ) {
        definitiveStatus = response.status;
        throw new OAuthRecoveryRefreshRejectedError(
          response.status,
        );
      }
      throw new OAuthRecoveryRefreshAmbiguousError();
    }
    if (contentType !== "application/json") {
      throw new OAuthRecoveryRefreshAmbiguousError();
    }
    const refreshed =
      parseOAuthRecoveryRefreshSession(value, expected);
    if (!refreshed) {
      throw new OAuthRecoveryRefreshAmbiguousError();
    }

    // The refresh request is now remotely committed or ambiguous. Never
    // overwrite a pair that changed while it was in flight.
    const beforeSave =
      await readBrowserSupabaseSessionSnapshot();
    if (!exactBrowserSessionSnapshot(before, beforeSave)) {
      throw new OAuthRecoveryRefreshAmbiguousError();
    }
    const logicalStorageKey =
      callbackLogicalStorageKey(capability.capabilityId);
    await createOAuthCallbackCookieStorage(
      logicalStorageKey,
    ).setItem(
      logicalStorageKey,
      JSON.stringify(refreshed),
    );
    const committed =
      await readBrowserSupabaseSessionSnapshot();
    if (
      !committed ||
      committed.evidence.userId !== expected.userId ||
      committed.evidence.sessionId !== expected.sessionId ||
      committed.evidence.accessToken !==
        refreshed.access_token ||
      committed.evidence.refreshToken !==
        refreshed.refresh_token
    ) {
      throw new OAuthRecoveryRefreshAmbiguousError();
    }
    await armOAuthCallbackUserTransport(
      capability,
      refreshed.access_token,
    );
    await readAuthoritativeOAuthUser(
      refreshed.access_token,
      expected.userId,
      signal,
    );
    assertOAuthCallbackTransportConsumed(capability);
    const finalSession =
      await readBrowserSupabaseSessionSnapshot();
    if (!exactBrowserSessionSnapshot(
      committed,
      finalSession,
    )) {
      throw new OAuthRecoveryRefreshAmbiguousError();
    }
    const [accessTokenSha256, refreshTokenSha256] =
      await Promise.all([
        sha256Hex(refreshed.access_token),
        sha256Hex(refreshed.refresh_token),
      ]);
    return {
      ...expected,
      accessTokenSha256,
      refreshTokenSha256,
    };
  } catch (error) {
    const safety =
      oauthCallbackExchangeSafety(capability);
    if (
      safety === "definitively_rejected" &&
      definitiveStatus !== null &&
      error instanceof OAuthRecoveryRefreshRejectedError
    ) {
      try {
        const after =
          await readBrowserSupabaseSessionSnapshot();
        if (exactBrowserSessionSnapshot(before, after)) {
          throw error;
        }
      } catch (snapshotError) {
        if (
          snapshotError instanceof
          OAuthRecoveryRefreshRejectedError
        ) {
          throw snapshotError;
        }
      }
    }
    if (safety === "not_attempted") throw error;
    throw new OAuthRecoveryRefreshAmbiguousError();
  } finally {
    endOAuthCallbackTransportScope(capability);
  }
}

type OAuthCallbackLifecycleResult =
  | {
      outcome: "completed";
      evidence: OAuthCallbackExchangeEvidence;
      error: null;
    }
  | {
      outcome: "failed";
      evidence: null;
      error: unknown;
    };

type OAuthCallbackSourceIdentity = {
  userId: string;
  sessionId: string;
};

export class OAuthCallbackExchangeAmbiguousError extends Error {
  constructor() {
    super("oauth_callback_exchange_ambiguous");
    this.name = "OAuthCallbackExchangeAmbiguousError";
  }
}

const OAUTH_CALLBACK_TERMINAL_LOCK_TIMEOUT_MS = 12_000;

async function assertOAuthCallbackSourceSession(
  expected: OAuthCallbackSourceIdentity,
): Promise<void> {
  let snapshot: BrowserSupabaseSessionSnapshot | null;
  try {
    snapshot = await readBrowserSupabaseSessionSnapshot();
  } catch {
    throw new OAuthFlowLeaseError(
      "oauth_flow_cookie_invalid",
    );
  }
  if (
    snapshot === null ||
    snapshot.evidence.userId !== expected.userId ||
    snapshot.evidence.sessionId !== expected.sessionId
  ) {
    throw new OAuthFlowLeaseError(
      "oauth_flow_cookie_invalid",
    );
  }
}

function assertOAuthCallbackTerminalCleanupReady(
  flowId: string,
): void {
  if (
    typeof document === "undefined" ||
    readExactVisibleOAuthCallbackFlow() !== null ||
    readOAuthFlowBrowserBarrier() !== flowId
  ) {
    throw new Error(
      "oauth_callback_terminal_cleanup_barrier_invalid",
    );
  }
}

/**
 * Re-enters H→S only for same-process local cleanup after an exact terminal
 * server ACK already removed the visible marker but a durable browser barrier
 * remains. No Supabase transport is armed in this state.
 */
export function resumeOAuthCallbackTerminalCleanup<T>(options: {
  signal: AbortSignal;
  flowId: string;
  cleanup: () => T | Promise<T>;
}): Promise<T> {
  if (!isOAuthFlowId(options.flowId)) {
    return Promise.reject(
      new Error("oauth_callback_flow_invalid"),
    );
  }
  return authRequestScope().runExclusive(options.signal, () =>
    runAuthCrossContextExclusive(options.signal, async () => {
      assertOAuthCallbackTerminalCleanupReady(
        options.flowId,
      );
      return exactSupabaseAuthLock(
        authSdkLockName(),
        OAUTH_CALLBACK_TERMINAL_LOCK_TIMEOUT_MS,
        async () => {
          if (options.signal.aborted) {
            throw (
              options.signal.reason ??
              new Error("oauth_callback_terminal_cleanup_aborted")
            );
          }
          assertOAuthCallbackTerminalCleanupReady(
            options.flowId,
          );
          const result = await options.cleanup();
          if (
            readExactVisibleOAuthCallbackFlow() !== null
          ) {
            throw new Error(
              "oauth_callback_terminal_cleanup_marker_changed",
            );
          }
          return result;
        },
      );
    }),
  );
}

/**
 * Owns the complete browser callback critical section:
 *
 * L (same-realm queue) → H (origin-wide identity writer) → SDK S.
 *
 * The caller-supplied finish step includes the durable finalize response and
 * navigation, so H is not released while a late callback decision could still
 * overtake another tab's identity writer.
 */
export function runOAuthCallbackAuthLifecycle<T>(options: {
  signal: AbortSignal;
  flowId: string;
  code: string | null;
  preflight: (
    signal: AbortSignal,
  ) => Promise<OAuthCallbackSourceIdentity | null>;
  bindTarget: (
    binding: OAuthCallbackTargetBinding,
    signal: AbortSignal,
  ) => Promise<void>;
  finish: (
    result: OAuthCallbackLifecycleResult,
    auth: () => OAuthCallbackAuthClient,
    signal: AbortSignal,
  ) => Promise<T>;
}): Promise<T> {
  if (!isOAuthFlowId(options.flowId)) {
    return Promise.reject(new Error("oauth_callback_flow_invalid"));
  }
  return authRequestScope().runExclusive(options.signal, () =>
    runAuthCrossContextExclusive(options.signal, async () => {
      if (
        typeof document === "undefined" ||
        !oauthCallbackFlowBarrierMatches(options.flowId)
      ) {
        throw new OAuthFlowLeaseError(
          "oauth_flow_cookie_invalid",
        );
      }
      const capability = beginOAuthCallbackTransportScope(
        options.flowId,
      );
      const authClientRef: {
        current: OAuthCallbackAuthClient | null;
      } = { current: null };
      const auth = (): OAuthCallbackAuthClient => {
        if (authClientRef.current === null) {
          authClientRef.current = createOAuthCallbackClient(
            capability.capabilityId,
          );
        }
        return authClientRef.current;
      };
      let primaryFailed = false;
      try {
        // Claim/inspect the durable flow for every callback outcome, including
        // provider rejection and a missing code. Failed outcomes must not try
        // to finalize a still-pending row.
        const preflightSource =
          await options.preflight(options.signal);
        if (options.code !== null) {
          if (preflightSource === null) {
            throw new OAuthFlowLeaseError(
              "oauth_flow_cookie_invalid",
            );
          }
          await assertOAuthCallbackSourceSession(
            preflightSource,
          );
        }
        if (
          !oauthCallbackFlowBarrierMatches(options.flowId)
        ) {
          throw new OAuthFlowLeaseError(
            "oauth_flow_cookie_invalid",
          );
        }
        // One external exact S spans every callback-side identity read/write,
        // the durable finalize receipt, optional local sign-out, and
        // navigation. The dedicated SDK client has no internal lock.
        return await runSignalAwareSupabaseAuthLock(
          authSdkLockName(),
          options.signal,
          async () => {
          let lifecycleResult: OAuthCallbackLifecycleResult = {
            outcome: "failed",
            evidence: null,
            error: new Error("oauth_callback_code_missing"),
          };
          if (options.code !== null) {
            try {
              if (preflightSource === null) {
                throw new OAuthFlowLeaseError(
                  "oauth_flow_cookie_invalid",
                );
              }
              await assertOAuthCallbackSourceSession(
                preflightSource,
              );
              // No Supabase Auth request is permitted before the exact
              // preflight acknowledgement above. Verifier parsing and
              // capability arming stay inside the safety classifier so a
              // proven pre-transport failure can be finalized as failed.
              const codeVerifier =
                await readBrowserSupabaseOAuthVerifier();
              const boundTarget: {
                value: OAuthCallbackTargetEvidence | null;
              } = { value: null };
              await armOAuthCallbackPkceTransport(
                capability,
                options.code,
                codeVerifier,
                async (binding) => {
                  await options.bindTarget(
                    binding,
                    options.signal,
                  );
                  boundTarget.value = {
                    userId: binding.userId,
                    sessionId: binding.sessionId,
                    accessTokenDigest:
                      binding.accessTokenDigest,
                    refreshTokenDigest:
                      binding.refreshTokenDigest,
                  };
                },
              );
              const exchanged =
                await auth().exchangeCodeForSession(options.code);
              const session = exchanged.data.session;
              const user = exchanged.data.user;
              const identity = session
                ? readSupabaseAccessTokenIdentity(
                    session.access_token,
                  )
                : null;
              if (
                exchanged.error ||
                !session ||
                !user ||
                !identity ||
                user.id !== session.user.id ||
                user.id !== identity.userId ||
                user.is_anonymous !== false ||
                session.user.is_anonymous !== false
              ) {
                throw (
                  exchanged.error ??
                  new Error("oauth_callback_exchange_invalid")
                );
              }

              // exchangeCodeForSession resolves only after its storage write.
              // Parse document.cookie without Map-collapsing duplicate names,
              // then require exact access/refresh bytes and JWT CAS identities.
              const committed =
                await readBrowserSupabaseSessionSnapshot();
              if (
                !committed ||
                committed.evidence.userId !== user.id ||
                committed.evidence.sessionId !== identity.sessionId ||
                committed.evidence.accessToken !==
                  session.access_token ||
                committed.evidence.refreshToken !==
                  session.refresh_token
              ) {
                throw new Error(
                  "oauth_callback_session_commit_mismatch",
                );
              }
              const [
                accessTokenDigest,
                refreshTokenDigest,
              ] = await Promise.all([
                sha256Hex(session.access_token),
                sha256Hex(session.refresh_token),
              ]);
              if (
                boundTarget.value === null ||
                boundTarget.value.userId !== identity.userId ||
                boundTarget.value.sessionId !==
                  identity.sessionId ||
                boundTarget.value.accessTokenDigest !==
                  accessTokenDigest ||
                boundTarget.value.refreshTokenDigest !==
                  refreshTokenDigest
              ) {
                throw new Error(
                  "oauth_callback_bound_target_mismatch",
                );
              }

              await armOAuthCallbackUserTransport(
                capability,
                session.access_token,
              );
              // Use a raw, token-bound request rather than auth.getUser(); the
              // SDK method can remove the real cookie on a 401 and destroy the
              // recovery evidence this callback must preserve.
              await readAuthoritativeOAuthUser(
                session.access_token,
                user.id,
                options.signal,
              );
              assertOAuthCallbackTransportConsumed(capability);

              const finalSession =
                await readBrowserSupabaseSessionSnapshot();
              if (!exactBrowserSessionSnapshot(
                committed,
                finalSession,
              )) {
                throw new Error(
                  "oauth_callback_final_session_mismatch",
                );
              }
              lifecycleResult = {
                outcome: "completed",
                evidence: {
                  userId: identity.userId,
                  sessionId: identity.sessionId,
                  accessTokenDigest,
                  refreshTokenDigest,
                },
                error: null,
              };
            } catch (error) {
              const safety =
                oauthCallbackExchangeSafety(capability);
              poisonOAuthCallbackTransportScope(capability);
              if (safety === "ambiguous_or_committed") {
                // Once the token request may have committed, never collapse a
                // postcondition/read failure into terminal "failed". The marker
                // and durable claim remain for explicit recovery.
                throw new OAuthCallbackExchangeAmbiguousError();
              }
              lifecycleResult = {
                outcome: "failed",
                evidence: null,
                error,
              };
            }
          }

          if (
            !oauthCallbackFlowBarrierMatches(options.flowId)
          ) {
            throw new OAuthFlowLeaseError(
              "oauth_flow_cookie_invalid",
            );
          }
          return await options.finish(
            lifecycleResult,
            auth,
            options.signal,
          );
          },
        );
      } catch (error) {
        primaryFailed = true;
        throw error;
      } finally {
        let cleanupError: unknown = null;
        if (authClientRef.current !== null) {
          try {
            await authClientRef.current.dispose();
          } catch (error) {
            cleanupError = error;
          }
        }
        try {
          endOAuthCallbackTransportScope(capability);
        } catch (error) {
          cleanupError ??= error;
        }
        if (!primaryFailed && cleanupError !== null) {
          throw cleanupError;
        }
      }
    }),
  );
}
