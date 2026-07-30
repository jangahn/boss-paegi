import { NextResponse, type NextRequest } from "next/server";
import { MIGRATE_COOKIE } from "@/lib/signup-cookie";
import { createClient } from "@/lib/supabase/server";
import { requireSupabaseSuccess } from "@/lib/supabase-operation";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 로그아웃 — 서버에서 Supabase 세션 종료(refresh token 무효화) + `sb-*` auth 쿠키 + httpOnly `MIGRATE_COOKIE` 만료.
 * 클라 signOut(lib/auth-oauth)·/consent [로그아웃]·AccountMenu 공통 경유 → 응답 Set-Cookie 에 auth+MIGRATE 만료 보장
 * (어댑터 미반영 대비 명시 만료, no-store). 타계정 로그인 시 오이전 방지(I4).
 */
export async function POST(request: NextRequest) {
  try {
    const supabase = await createClient();
    await requireSupabaseSuccess("auth.signout_revoke", () =>
      supabase.auth.signOut(),
    );
  } catch (error) {
    // 세션 없거나 원격 revoke가 실패해도 현재 브라우저의 모든 쿠키는
    // 아래에서 명시 만료한다. 재사용 가능한 refresh token 실패는 가시화한다.
    log.warn("auth.signout_revoke_fail", errInfo(error));
  }
  const res = NextResponse.json({ ok: true });
  for (const c of request.cookies.getAll()) {
    if (c.name.startsWith("sb-")) res.cookies.set(c.name, "", { maxAge: 0, path: "/" });
  }
  res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
  res.headers.set("Cache-Control", "no-store");
  return res;
}
