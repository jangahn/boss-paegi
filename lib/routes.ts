// 회원 전용 페이지 — proxy(익명 차단) 단일 소스.
// 익명/무세션이 이 경로 접근 시 /login. (글로벌 동의 모델: 로그인 사용자는 **모든** 페이지에서
// proxy 가 동의 검사 → 미동의면 /consent. 아래는 "비로그인이 막히는" 경로 집합.)
export const MEMBER_ONLY_PAGES = ["/generate", "/credits", "/admin", "/account"] as const;

export function isMemberOnlyPath(pathname: string): boolean {
  return MEMBER_ONLY_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/"));
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

// 결제 webhook — proxy/updateSession 영향 최소화(즉시 pass-through). 외부 서버 호출이라 세션 무관,
// 세션 리프레시 실패가 webhook 응답을 절대 막으면 안 됨. 보호는 route 내부 linkval/order/amount.
const WEBHOOK_PATHS: readonly string[] = ["/api/payapp/feedback", "/api/payapp/return"];

export function isWebhookPath(pathname: string): boolean {
  return WEBHOOK_PATHS.includes(pathname);
}
