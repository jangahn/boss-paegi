// 쿠키 이름 단일 소스 — **edge(proxy)·node(라우트) 공용**(값만, 런타임 의존 없음).
// signup-cookie.ts(server-only·node:crypto)는 edge proxy 에서 import 불가 → 이름만 여기서.

/** 익명→회원 데이터 이전용 HMAC 서명 쿠키(서명/검증은 lib/signup-cookie). */
export const MIGRATE_COOKIE = "signup_migrate";
