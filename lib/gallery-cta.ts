// 갤러리 뷰어 상태 + 가입/생성 유도 CTA — 토스트·가입배너·헤더버튼이 공용으로 사용(copy DRY).
//
// nonmember   : 비회원(익명 세션 또는 프로필 없음) — 생성하려면 가입 필요.
// member-empty: 회원이지만 아직 캐릭터 0개 — 바로 생성 가능.
// member      : 회원 + 캐릭터 보유 — 후킹 불필요(배너·토스트 없음).
export type ViewerState = "nonmember" | "member-empty" | "member";

/** 로그인 후 곧장 생성 페이지로(safeNext 가 "/generate" 허용). */
const LOGIN_THEN_GENERATE = "/login?next=%2Fgenerate";

export type CtaTarget = { label: string; href: string };

/**
 * 상태별 "캐릭터 만들기" 진입점.
 * - 비회원   → 로그인(가입) 후 생성으로.
 * - 회원     → 바로 생성으로.
 */
export function ctaFor(state: ViewerState): CtaTarget {
  return state === "nonmember"
    ? { label: "가입하고 만들기", href: LOGIN_THEN_GENERATE }
    : { label: "캐릭터 만들기", href: "/generate" };
}
