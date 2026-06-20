import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";

// 회원 전용 페이지 — 익명/무세션 접근 시 /login 으로. (생성·갤러리)
// play/leaderboard/share/doll/홈 은 절대 게이팅하지 않음 (비회원 유지).
const MEMBER_ONLY_PAGES = ["/generate", "/gallery"];

export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request);
  const path = request.nextUrl.pathname;

  const memberOnly = MEMBER_ONLY_PAGES.some(
    (p) => path === p || path.startsWith(p + "/")
  );
  // 익명(user.is_anonymous)도 user 는 존재하므로 `!user` 만으로 판별 금지.
  if (memberOnly && (!user || user.is_anonymous)) {
    const url = request.nextUrl.clone();
    url.pathname = "/login";
    url.search = `?next=${encodeURIComponent(path)}`;
    const redirectRes = NextResponse.redirect(url);
    // updateSession 이 갱신한 세션 쿠키를 redirect 응답에 보존.
    response.cookies.getAll().forEach((c) => redirectRes.cookies.set(c));
    return redirectRes;
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|monitoring|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
