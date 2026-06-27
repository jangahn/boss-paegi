import { NextResponse, type NextRequest } from "next/server";
import { updateSession } from "@/lib/supabase/middleware";
import { isMemberOnlyPath } from "@/lib/routes";

// 회원 전용 페이지(lib/routes 단일 소스) — 익명/무세션 접근 시 /login 으로. (생성·충전·관리자·마이페이지)
// (/admin 의 is_admin 최종 판정은 서버 RSC/라우트의 requireAdmin — 미들웨어는 DB read 회피.)
// play/leaderboard/share/doll/홈/갤러리·약관·방침 등 공개 페이지는 게이팅하지 않음 (비회원 유지).
export async function proxy(request: NextRequest) {
  const { response, user } = await updateSession(request);
  const path = request.nextUrl.pathname;

  // 익명(user.is_anonymous)도 user 는 존재하므로 `!user` 만으로 판별 금지.
  if (isMemberOnlyPath(path) && (!user || user.is_anonymous)) {
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
