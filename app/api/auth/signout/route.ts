import { NextResponse, type NextRequest } from "next/server";
import { MIGRATE_COOKIE } from "@/lib/signup-cookie";
import { createClient } from "@/lib/supabase/server";

export const runtime = "nodejs";

/**
 * 로그아웃 — 서버에서 Supabase 세션 종료(refresh token 무효화) + `sb-*` auth 쿠키 + httpOnly `MIGRATE_COOKIE` 만료.
 * 클라 signOut(lib/auth-oauth)·/consent [로그아웃]·AccountMenu 공통 경유 → 응답 Set-Cookie 에 auth+MIGRATE 만료 보장
 * (어댑터 미반영 대비 명시 만료, no-store). 타계정 로그인 시 오이전 방지(I4).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    await supabase.auth.signOut();
  } catch {
    /* 세션 없거나 만료여도 쿠키 정리는 진행 */
  }
  const res = NextResponse.json({ ok: true });
  for (const c of request.cookies.getAll()) {
    if (c.name.startsWith("sb-")) res.cookies.set(c.name, "", { maxAge: 0, path: "/" });
  }
  res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
