// 회원 전용 페이지 — proxy(익명 차단) 단일 소스. (lazy 동의 모델: 동의 게이트는 각 회원기능에서 처리.)
// 여기 없는 경로(홈·랭킹·플레이·갤러리·공유·약관·방침 등 비로그인도 보는 공개 페이지)는 전체 허용.
export const MEMBER_ONLY_PAGES = ["/generate", "/credits", "/admin", "/account"] as const;

export function isMemberOnlyPath(pathname: string): boolean {
  return MEMBER_ONLY_PAGES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}
