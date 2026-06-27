import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { MIGRATE_COOKIE } from "@/lib/signup-cookie";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 동의 취소(/consent 의 "로그아웃하고 다시 로그인") — 서버에서 **httpOnly MIGRATE_COOKIE clear**(I2/#1:
 * client signOut 만으론 못 지워 다음 OAuth 계정에 익명데이터 오이전 위험) + Supabase 세션 로그아웃(auth 쿠키 clear).
 * 클라는 이 응답 후 추가로 client signOut(auth 쿠키 확실 정리) 한 뒤 /login 으로 — 새 계정 선택.
 */
export async function POST() {
  const supabase = await createClient();
  try {
    await supabase.auth.signOut();
  } catch (e) {
    log.warn("account.consent_cancel_signout_fail", { ...errInfo(e) });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
