import { NextResponse } from "next/server";
import { MIGRATE_COOKIE } from "@/lib/signup-cookie";

export const runtime = "nodejs";

/**
 * 로그아웃 시 httpOnly `MIGRATE_COOKIE` 정리(타계정 오이전 방지, I4) — 클라 signOut 이 Supabase signOut 전에 호출.
 * (Supabase auth 쿠키는 클라 supabase.auth.signOut 이 정리.)
 */
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
}
