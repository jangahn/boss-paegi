// 회원 전용 페이지 — proxy(익명 차단) 단일 소스.
// 익명/무세션이 이 경로 접근 시 /login. (글로벌 동의 모델: 로그인 사용자는 **모든** 페이지에서
// proxy 가 동의 검사 → 미동의면 /consent. 아래는 "비로그인이 막히는" 경로 집합.)
export const MEMBER_ONLY_PAGES = ["/generate", "/credits", "/admin", "/account"] as const;

export function isMemberOnlyPath(pathname: string): boolean {
  return MEMBER_ONLY_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * Browser Auth coordination owns the complete `/auth` subtree. Global UI that
 * initializes or reads the ordinary Supabase client must not mount there:
 * callback/recovery pages need an isolated H -> S critical section with zero
 * AccountMenu/SessionBootstrap background Auth work.
 */
export function isAuthSubtreePath(pathname: string): boolean {
  return pathname === "/auth" || pathname.startsWith("/auth/");
}

// 글로벌 동의 게이트 **예외** — 미동의 로그인 사용자도 이 경로는 /consent 로 보내지 않음.
// `/consent`(동의 화면 자체)·`/auth/*`(OAuth 콜백)·`/api/*`(자체 requireMember 게이트).
// 정적/`_next`는 proxy matcher 에서 이미 제외. **`/login`은 예외 아님** — anon 만 허용(proxy 가 처리).
const CONSENT_EXEMPT_PREFIXES = ["/api", "/auth"] as const;

export function isConsentExempt(pathname: string): boolean {
  return (
    pathname === "/consent" ||
    CONSENT_EXEMPT_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))
  );
}

// 외부 webhook — proxy/updateSession 영향 최소화(즉시 pass-through). 세션 무관이며
// route 내부의 공급자 서명 + durable binding이 권위를 검증한다.
const WEBHOOK_PATHS: readonly string[] = [
  "/api/pay/webhook",
  "/api/fal/webhook",
  "/api/fal/face-webhook",
  "/api/fal/pick-webhook",
];

export function isWebhookPath(pathname: string): boolean {
  return WEBHOOK_PATHS.includes(pathname);
}
