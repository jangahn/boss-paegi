import { stringFromBase64URL } from "@supabase/ssr";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const AUTH_COOKIE_MAX_CHARS = 128 * 1024;
const COOKIE_HEADER_MAX_CHARS = 256 * 1024;
const ACCESS_TOKEN_MAX_CHARS = 64 * 1024;
const REFRESH_TOKEN_MAX_CHARS = 64 * 1024;
const AUTH_COOKIE_MAX_CHUNKS = 64;
const AUTH_RECONCILE_MAX_COOKIE_NAMES = 144;
const AUTH_RECONCILE_MAX_COOKIE_PAIRS = 144;
const AUTH_RECONCILE_MAX_COOKIE_NAMES_CHARS = 4 * 1024;

export type SupabaseSessionCookieEvidence = {
  accessToken: string;
  refreshToken: string;
  userId: string;
  sessionId: string;
};

export type SupabaseSessionCookieResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | {
      kind: "present";
      session: SupabaseSessionCookieEvidence;
    };

export function readSupabaseAccessTokenIdentity(
  accessToken: string,
): { userId: string; sessionId: string } | null {
  if (
    accessToken.length === 0 ||
    accessToken.length > ACCESS_TOKEN_MAX_CHARS ||
    /[\s\u0000-\u001f\u007f]/.test(accessToken)
  ) {
    return null;
  }
  try {
    const jwt = accessToken.split(".");
    if (jwt.length !== 3) return null;
    const claims: unknown = JSON.parse(
      stringFromBase64URL(jwt[1]),
    );
    if (
      claims === null ||
      typeof claims !== "object" ||
      Array.isArray(claims)
    ) {
      return null;
    }
    const claim = claims as Record<string, unknown>;
    if (
      typeof claim.sub !== "string" ||
      !UUID_RE.test(claim.sub) ||
      typeof claim.session_id !== "string" ||
      !UUID_RE.test(claim.session_id)
    ) {
      return null;
    }
    return {
      userId: claim.sub,
      sessionId: claim.session_id,
    };
  } catch {
    return null;
  }
}

/**
 * access token 의 exp 클레임(unix 초) — 서명 검증 없이 **'만료'를 '손상'과 구분**하는
 * 분류에만 쓴다(세션의 권위 판정은 여전히 서버 getUser). JWT 구조가 아니거나 exp 가
 * 안전한 양의 정수가 아니면 null(=분류 불가 → 호출부는 보수적으로 손상 취급).
 */
export function readSupabaseAccessTokenExpiresAt(
  accessToken: string,
): number | null {
  if (
    accessToken.length === 0 ||
    accessToken.length > ACCESS_TOKEN_MAX_CHARS ||
    /[\s\u0000-\u001f\u007f]/.test(accessToken)
  ) {
    return null;
  }
  try {
    const jwt = accessToken.split(".");
    if (jwt.length !== 3) return null;
    const claims: unknown = JSON.parse(
      stringFromBase64URL(jwt[1]),
    );
    if (
      claims === null ||
      typeof claims !== "object" ||
      Array.isArray(claims)
    ) {
      return null;
    }
    const exp = (claims as Record<string, unknown>).exp;
    if (
      typeof exp !== "number" ||
      !Number.isSafeInteger(exp) ||
      exp <= 0
    ) {
      return null;
    }
    return exp;
  } catch {
    return null;
  }
}

export function supabaseAuthCookieName(
  supabaseUrl: string,
): string {
  return (
    `sb-${new URL(supabaseUrl).hostname.split(".")[0]}` +
    "-auth-token"
  );
}

function isRelevantAuthCookieName(
  name: string,
  cookieName: string,
): boolean {
  return (
    name === cookieName ||
    name.startsWith(`${cookieName}.`)
  );
}

function supabaseCodeVerifierCookieName(
  cookieName: string,
): string {
  return `${cookieName}-code-verifier`;
}

function isRelevantReconcileCookieName(
  name: string,
  cookieName: string,
): boolean {
  return (
    isRelevantAuthCookieName(name, cookieName) ||
    isRelevantAuthCookieName(
      name,
      supabaseCodeVerifierCookieName(cookieName),
    )
  );
}

const COOKIE_NAME_RE =
  /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;

/**
 * Captures only exact, Set-Cookie-safe names in the Supabase auth-token and
 * code-verifier namespaces. Values are deliberately excluded. A
 * reconciliation capability binds this sorted set so hidden Path-scoped
 * duplicates and invalid chunk suffixes can be tombstoned without ever
 * serializing bearer credentials or PKCE material.
 */
export function readRawSupabaseAuthCookieNames(
  cookieHeader: string | null,
  supabaseUrl: string,
): string[] {
  if (
    !cookieHeader ||
    cookieHeader.length > COOKIE_HEADER_MAX_CHARS
  ) {
    return [];
  }
  const cookieName = supabaseAuthCookieName(supabaseUrl);
  const names = new Set<string>();
  let pairs = 0;
  for (const segment of cookieHeader.split(";")) {
    const pair = segment.trim();
    if (pair.length === 0) continue;
    pairs += 1;
    if (pairs > 512) return [];
    const equals = pair.indexOf("=");
    const rawName = (
      equals === -1 ? pair : pair.slice(0, equals)
    ).trim();
    if (
      isRelevantReconcileCookieName(rawName, cookieName) &&
      rawName.length <= 256 &&
      COOKIE_NAME_RE.test(rawName)
    ) {
      names.add(rawName);
      if (names.size > AUTH_RECONCILE_MAX_COOKIE_NAMES) {
        return [];
      }
    }
  }
  const canonical = [...names].sort();
  return canonical.join(",").length <=
    AUTH_RECONCILE_MAX_COOKIE_NAMES_CHARS
    ? canonical
    : [];
}

/**
 * Fingerprints the exact decoded name/value multiset without exposing bearer
 * values. Multiplicity is retained so a valid root cookie and an identically
 * named Path/Domain-scoped duplicate cannot alias the root-only post-state.
 */
export async function fingerprintSupabaseAuthCookiePairs(
  cookies: readonly { name: string; value: string }[],
): Promise<string> {
  const canonical = cookies
    .map(({ name, value }) => [name, value] as const)
    .sort(([leftName, leftValue], [rightName, rightValue]) => {
      if (leftName < rightName) return -1;
      if (leftName > rightName) return 1;
      if (leftValue < rightValue) return -1;
      if (leftValue > rightValue) return 1;
      return 0;
    });
  const encoded = new TextEncoder().encode(
    JSON.stringify([
      "boss-paegi-supabase-auth-cookie-pairs-v1",
      canonical,
    ]),
  );
  if (encoded.byteLength > COOKIE_HEADER_MAX_CHARS * 2) {
    throw new Error("auth_cookie_fingerprint_oversized");
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    encoded,
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export type RawSupabaseCookiePairsResult =
  | { kind: "absent" }
  | { kind: "invalid" }
  | {
      kind: "present";
      cookies: readonly { name: string; value: string }[];
    };

function readRawSupabaseCookiePairs(
  cookieHeader: string | null,
  supabaseUrl: string,
  relevant: (name: string, cookieName: string) => boolean,
  maxPairs: number,
): RawSupabaseCookiePairsResult {
  if (!cookieHeader) return { kind: "absent" };
  if (cookieHeader.length > COOKIE_HEADER_MAX_CHARS) {
    return { kind: "invalid" };
  }
  const cookieName = supabaseAuthCookieName(supabaseUrl);
  const cookies: { name: string; value: string }[] = [];
  for (const segment of cookieHeader.split(";")) {
    const pair = segment.trim();
    if (pair.length === 0) continue;
    const equals = pair.indexOf("=");
    const rawName =
      equals === -1 ? pair.trim() : pair.slice(0, equals).trim();
    if (!relevant(rawName, cookieName)) {
      continue;
    }
    if (
      equals <= 0 ||
      rawName.length === 0 ||
      /[\s\u0000-\u001f\u007f();,\\"]/u.test(rawName)
    ) {
      return { kind: "invalid" };
    }
    const encodedValue = pair.slice(equals + 1).trim();
    let value: string;
    try {
      value = decodeURIComponent(encodedValue);
    } catch {
      return { kind: "invalid" };
    }
    cookies.push({ name: rawName, value });
    if (cookies.length > maxPairs) {
      return { kind: "invalid" };
    }
  }
  return cookies.length === 0
    ? { kind: "absent" }
    : { kind: "present", cookies };
}

/**
 * `NextRequest.cookies.getAll()` is a lossy map view: duplicate Cookie header
 * fields with the same name can collapse before a route sees them. OAuth CAS
 * decisions must instead parse the raw header and preserve every relevant
 * name/value pair so duplicate bases, duplicate chunks, base+chunks, gaps and
 * invalid suffixes are all fail-closed.
 *
 * Unrelated malformed cookies do not turn a valid Auth cookie into a denial
 * of service. Malformation of an `sb-<ref>-auth-token[.*]` pair does.
 */
export function readRawSupabaseAuthCookiePairs(
  cookieHeader: string | null,
  supabaseUrl: string,
): RawSupabaseCookiePairsResult {
  return readRawSupabaseCookiePairs(
    cookieHeader,
    supabaseUrl,
    isRelevantAuthCookieName,
    AUTH_COOKIE_MAX_CHUNKS + 1,
  );
}

/**
 * Raw multiset used only by the reconciliation HEAD proof. Unlike the session
 * parser above, this deliberately includes the code-verifier namespace so an
 * invisible/HttpOnly residual verifier makes cleanup fail visibly.
 */
export function readRawSupabaseReconcileCookiePairs(
  cookieHeader: string | null,
  supabaseUrl: string,
): RawSupabaseCookiePairsResult {
  return readRawSupabaseCookiePairs(
    cookieHeader,
    supabaseUrl,
    isRelevantReconcileCookieName,
    AUTH_RECONCILE_MAX_COOKIE_PAIRS,
  );
}

/**
 * Parses only bounded, structural evidence from @supabase/ssr's chunked
 * cookie. JWT claims are not treated as authorization; callers must still
 * validate the access token with Auth. `sub`/`session_id` are CAS identities
 * that prevent a delayed response for one session from mutating another.
 */
export async function readSupabaseSessionCookie(
  cookies: readonly { name: string; value: string }[],
  supabaseUrl: string,
): Promise<SupabaseSessionCookieEvidence | null> {
  const cookieName = supabaseAuthCookieName(supabaseUrl);
  const exact = cookies.filter(({ name }) => name === cookieName);
  const chunkLike = cookies.filter(({ name }) =>
    name.startsWith(`${cookieName}.`),
  );
  if (
    exact.length > 1 ||
    (exact.length === 1 && chunkLike.length > 0) ||
    chunkLike.length > AUTH_COOKIE_MAX_CHUNKS
  ) {
    return null;
  }

  let combined: string | null = null;
  if (exact.length === 1) {
    combined = exact[0].value;
  } else if (chunkLike.length > 0) {
    const chunks = new Map<number, string>();
    for (const { name, value } of chunkLike) {
      const suffix = name.slice(cookieName.length + 1);
      if (
        !/^(?:0|[1-9]\d*)$/u.test(suffix) ||
        suffix.length > 3
      ) {
        return null;
      }
      const index = Number(suffix);
      if (
        !Number.isSafeInteger(index) ||
        index < 0 ||
        index >= AUTH_COOKIE_MAX_CHUNKS ||
        chunks.has(index) ||
        value.length === 0
      ) {
        return null;
      }
      chunks.set(index, value);
    }
    if (chunks.size === 0) return null;
    const ordered: string[] = [];
    let total = 0;
    for (let index = 0; index < chunks.size; index += 1) {
      const value = chunks.get(index);
      if (value === undefined) return null;
      total += value.length;
      if (
        !Number.isSafeInteger(total) ||
        total > AUTH_COOKIE_MAX_CHARS
      ) {
        return null;
      }
      ordered.push(value);
    }
    combined = ordered.join("");
  }
  if (
    combined === null ||
    combined.length === 0 ||
    combined.length > AUTH_COOKIE_MAX_CHARS
  ) {
    return null;
  }
  try {
    const json = combined.startsWith("base64-")
      ? stringFromBase64URL(combined.slice("base64-".length))
      : combined;
    const parsed: unknown = JSON.parse(json);
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed)
    ) {
      return null;
    }
    const accessToken = (parsed as Record<string, unknown>)
      .access_token;
    const refreshToken = (parsed as Record<string, unknown>)
      .refresh_token;
    if (
      typeof accessToken !== "string" ||
      typeof refreshToken !== "string" ||
      refreshToken.length === 0 ||
      refreshToken.length > REFRESH_TOKEN_MAX_CHARS ||
      /[\s\u0000-\u001f\u007f]/u.test(refreshToken)
    ) {
      return null;
    }
    const identity = readSupabaseAccessTokenIdentity(accessToken);
    if (!identity) return null;
    return {
      accessToken,
      refreshToken,
      ...identity,
    };
  } catch {
    return null;
  }
}

export async function readSupabaseSessionCookieHeader(
  cookieHeader: string | null,
  supabaseUrl: string,
): Promise<SupabaseSessionCookieResult> {
  const raw = readRawSupabaseAuthCookiePairs(
    cookieHeader,
    supabaseUrl,
  );
  if (raw.kind !== "present") return raw;
  const session = await readSupabaseSessionCookie(
    raw.cookies,
    supabaseUrl,
  );
  return session
    ? { kind: "present", session }
    : { kind: "invalid" };
}
