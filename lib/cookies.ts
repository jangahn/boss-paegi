// 쿠키 이름 단일 소스 — **edge(proxy)·node(라우트) 공용**(값만, 런타임 의존 없음).
// signup-cookie.ts(server-only·node:crypto)는 edge proxy 에서 import 불가 → 이름만 여기서.

/** 익명→회원 데이터 이전용 HMAC 서명 쿠키(서명/검증은 lib/signup-cookie). */
export const MIGRATE_COOKIE = "signup_migrate";

/** OAuth flow-scoped anonymous migration proof. */
export const MIGRATE_COOKIE_PREFIX = "signup_migrate_";

/** OAuth cross-tab marker; callback authority lives in an HttpOnly proof. */
export const OAUTH_FLOW_COOKIE_PREFIX =
  "boss-paegi-oauth-flow-";

/** Server-issued HMAC proof for one OAuth callback flow. */
export const OAUTH_FLOW_PROOF_COOKIE_PREFIX =
  "boss-paegi-oauth-proof-";

const OAUTH_FLOW_BARRIER_COOKIE_PREFIXES = [
  OAUTH_FLOW_COOKIE_PREFIX,
  OAUTH_FLOW_PROOF_COOKIE_PREFIX,
] as const;

/**
 * The visible marker and the HttpOnly recovery proof independently fence
 * ordinary documents and mutations. Treating either prefix as authoritative
 * makes a partially delivered Set-Cookie response fail closed.
 *
 * Values are intentionally irrelevant. A malformed percent escape only
 * creates a barrier when the undecoded name already begins with a reserved
 * prefix; an unrelated malformed cookie must not pin the whole application.
 */
export function cookieHeaderHasOAuthFlowBarrier(
  cookieHeader: string | null | undefined,
): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((entry) => {
    const trimmed = entry.trim();
    if (!trimmed) return false;
    const equals = trimmed.indexOf("=");
    const rawName =
      equals < 0 ? trimmed : trimmed.slice(0, equals);
    if (
      OAUTH_FLOW_BARRIER_COOKIE_PREFIXES.some((prefix) =>
        rawName.startsWith(prefix),
      )
    ) {
      return true;
    }
    try {
      const decodedName = decodeURIComponent(rawName);
      return OAUTH_FLOW_BARRIER_COOKIE_PREFIXES.some((prefix) =>
        decodedName.startsWith(prefix),
      );
    } catch {
      return false;
    }
  });
}

/** @deprecated Prefer the barrier name; kept for source-compatible tests. */
export const cookieHeaderHasOAuthFlowMarker =
  cookieHeaderHasOAuthFlowBarrier;
