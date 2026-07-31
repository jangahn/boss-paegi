import { safeNext } from "./oauth-metadata.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const COOKIE_NAME_RE =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const AUTH_RECONCILE_MAX_COOKIE_NAMES = 144;
const AUTH_RECONCILE_MAX_COOKIE_NAME_CHARS = 256;
export const AUTH_RECONCILE_MAX_COOKIE_NAMES_CHARS = 4 * 1024;
export const AUTH_RECONCILE_CAPABILITY_COOKIE =
  "boss-paegi-auth-reconcile";
export const AUTH_RECONCILE_PROBE_HEADER =
  "x-boss-paegi-auth-cookie-probe";
export const AUTH_RECONCILE_PROBE_ACK_HEADER =
  "x-boss-paegi-auth-cookie-probe-match";

export type AuthReconcileReason =
  | "account_deleted"
  | "auth_session_check_required"
  | "auth_session_invalid";

export type AuthReconcileIntent =
  | {
      reason: "account_deleted" | "auth_session_check_required";
      next: string;
      expectedUserId: string;
      expectedSessionId: string;
    }
  | {
      reason: "auth_session_invalid";
      next: string;
      expectedUserId: null;
      expectedSessionId: null;
    };

export type AuthReconcileInput = AuthReconcileIntent & {
  capability: string;
  cookiePath: string;
  cookieNames: readonly string[];
};

export type AuthReconcileSessionCas = {
  rawCookieBytes: string;
  cookieFingerprint: string;
  accessToken: string;
  refreshToken: string;
  userId: string;
  sessionId: string;
};

/**
 * Equality over every browser-owned byte and identity used to authorize a
 * reconciliation mutation. UUID equality alone is insufficient because a
 * refresh or a same-session token rotation must be treated as newer state.
 */
export function authReconcileSessionCasMatches(
  baseline: AuthReconcileSessionCas,
  candidate: AuthReconcileSessionCas | null,
): candidate is AuthReconcileSessionCas {
  return (
    candidate !== null &&
    candidate.rawCookieBytes === baseline.rawCookieBytes &&
    candidate.cookieFingerprint === baseline.cookieFingerprint &&
    candidate.accessToken === baseline.accessToken &&
    candidate.refreshToken === baseline.refreshToken &&
    candidate.userId === baseline.userId &&
    candidate.sessionId === baseline.sessionId
  );
}

function exactKeys(
  value: Record<string, string | string[] | undefined>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
}

function isCanonicalCookiePath(value: string): boolean {
  if (
    value.length === 0 ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//") ||
    /[\\?#;\u0000-\u001f\u007f]/u.test(value)
  ) {
    return false;
  }
  try {
    const parsed = new URL(value, "https://internal.invalid");
    return (
      parsed.origin === "https://internal.invalid" &&
      parsed.pathname === value
    );
  } catch {
    return false;
  }
}

/**
 * Enumerates exactly the non-root RFC 6265 path-match boundaries for the
 * original request pathname. Repeated and trailing slashes are preserved;
 * string-only prefixes such as `/acc` for `/account` are never produced.
 */
export function authReconcileNonRootCookiePaths(
  pathname: string,
): string[] {
  if (!isCanonicalCookiePath(pathname)) {
    throw new Error("auth_cookie_cleanup_path_invalid");
  }
  const paths = new Set<string>();
  for (
    let index = 1;
    index < pathname.length;
    index += 1
  ) {
    if (pathname[index] !== "/") continue;
    const withoutSlash = pathname.slice(0, index);
    const withSlash = pathname.slice(0, index + 1);
    if (withoutSlash !== "/") paths.add(withoutSlash);
    if (withSlash !== "/") paths.add(withSlash);
  }
  if (pathname !== "/") paths.add(pathname);
  return [...paths];
}

function canonicalCookieNames(
  value: readonly string[],
): string[] | null {
  if (
    value.length > AUTH_RECONCILE_MAX_COOKIE_NAMES ||
    value.some(
      (name) =>
        name.length === 0 ||
        name.length > AUTH_RECONCILE_MAX_COOKIE_NAME_CHARS ||
        !COOKIE_NAME_RE.test(name),
    )
  ) {
    return null;
  }
  const names = [...value].sort();
  if (
    names.some(
      (name, index) =>
        index > 0 && name === names[index - 1],
    ) ||
    names.join(",").length >
      AUTH_RECONCILE_MAX_COOKIE_NAMES_CHARS
  ) {
    return null;
  }
  return names;
}

function parseCanonicalCookieNames(
  value: string,
): string[] | null {
  if (value.length > AUTH_RECONCILE_MAX_COOKIE_NAMES_CHARS) {
    return null;
  }
  if (value.length === 0) return [];
  const raw = value.split(",");
  const canonical = canonicalCookieNames(raw);
  return canonical !== null &&
    canonical.every((name, index) => name === raw[index])
    ? canonical
    : null;
}

export function parseAuthReconcileSearchParams(
  value: Record<string, string | string[] | undefined>,
): AuthReconcileInput | null {
  const reason = value.reason;
  const next = value.next;
  const capability = value.capability;
  const cookiePath = value.cookiePath;
  const serializedCookieNames = value.cookieNames;
  const cookieNames =
    typeof serializedCookieNames === "string"
      ? parseCanonicalCookieNames(serializedCookieNames)
      : null;
  if (
    typeof reason !== "string" ||
    typeof next !== "string" ||
    typeof capability !== "string" ||
    !UUID_RE.test(capability) ||
    typeof cookiePath !== "string" ||
    !isCanonicalCookiePath(cookiePath) ||
    cookieNames === null ||
    (
      reason === "account_deleted"
        ? next !== "/login?error=account_deleted"
        : safeNext(next) !== next
    )
  ) {
    return null;
  }
  if (reason === "auth_session_invalid") {
    return exactKeys(value, [
      "capability",
      "cookieNames",
      "cookiePath",
      "next",
      "reason",
    ])
      ? {
          reason,
          next,
          expectedUserId: null,
          expectedSessionId: null,
          capability,
          cookiePath,
          cookieNames,
        }
      : null;
  }
  if (
    (
      reason !== "account_deleted" &&
      reason !== "auth_session_check_required"
    ) ||
    !exactKeys(value, [
      "expectedSession",
      "expectedUser",
      "capability",
      "cookieNames",
      "cookiePath",
      "next",
      "reason",
    ]) ||
    typeof value.expectedUser !== "string" ||
    !UUID_RE.test(value.expectedUser) ||
    typeof value.expectedSession !== "string" ||
    !UUID_RE.test(value.expectedSession)
  ) {
    return null;
  }
  return {
    reason,
    next,
    expectedUserId: value.expectedUser,
    expectedSessionId: value.expectedSession,
    capability,
    cookiePath,
    cookieNames,
  };
}

export function authReconcilePath(
  input: AuthReconcileInput,
): string {
  const cookieNames = canonicalCookieNames(input.cookieNames);
  if (
    cookieNames === null ||
    !cookieNames.every(
      (name, index) => name === input.cookieNames[index],
    )
  ) {
    throw new Error("auth_reconcile_cookie_names_invalid");
  }
  const query = new URLSearchParams({
    next:
      input.reason === "account_deleted"
        ? "/login?error=account_deleted"
        : safeNext(input.next),
    reason: input.reason,
    capability: input.capability,
    cookieNames: cookieNames.join(","),
    cookiePath: input.cookiePath,
  });
  if (
    input.expectedUserId !== null &&
    input.expectedSessionId !== null
  ) {
    query.set("expectedUser", input.expectedUserId);
    query.set("expectedSession", input.expectedSessionId);
  }
  return `/auth/reconcile?${query.toString()}`;
}

/**
 * The query carries a random nonce, while the HttpOnly capability cookie
 * carries this digest. Binding every mutation-relevant field means a direct
 * navigation cannot reuse a capability to choose another session, path, or
 * cookie name. Cookie values are never part of either URL or digest input.
 */
export async function authReconcileCapabilityDigest(
  input: AuthReconcileInput,
): Promise<string> {
  const canonicalPath = authReconcilePath(input);
  const parsedUrl = new URL(
    canonicalPath,
    "https://auth-reconcile.invalid",
  );
  const canonical = parseAuthReconcileSearchParams(
    Object.fromEntries(parsedUrl.searchParams),
  );
  if (canonical === null) {
    throw new Error("auth_reconcile_input_invalid");
  }
  const payload = JSON.stringify([
    "boss-paegi-auth-reconcile-capability-v1",
    canonical.reason,
    canonical.next,
    canonical.expectedUserId,
    canonical.expectedSessionId,
    canonical.capability,
    canonical.cookiePath,
    canonical.cookieNames,
  ]);
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
