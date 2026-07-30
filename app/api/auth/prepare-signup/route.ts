import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { signMigrateValue, MIGRATE_COOKIE, MIGRATE_MAX_AGE } from "@/lib/signup-cookie";
import { decidePrepareSignupUser } from "@/lib/prepare-signup-policy";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * OAuth 시작 전(익명 세션) 호출 — 현재 익명 user.id 를 서명 쿠키로 기록.
 * signInWithOAuth 가 세션을 새 회원으로 교체한 뒤, onboard 가 이 쿠키로 익명 데이터를 이전한다.
 * 쿠키는 서버 세션 기반으로만 발급되므로 타 익명 id 위조 불가.
 */
export async function POST() {
  const supabase = await createClient();
  let authResult: Awaited<ReturnType<typeof supabase.auth.getUser>>;
  try {
    authResult = await supabase.auth.getUser();
  } catch (error) {
    log.error("auth.prepare_signup_user_fail", errInfo(error));
    return NextResponse.json(
      { error: "auth_unavailable" },
      { status: 503 },
    );
  }
  const decision = decidePrepareSignupUser(authResult);
  if (!decision.ok) {
    log.warn("auth.prepare_signup_user_fail", {
      kind: decision.kind,
      ...errInfo(decision.error),
    });
    return NextResponse.json(
      {
        error:
          decision.kind === "unauthorized"
            ? "unauthorized"
            : "auth_unavailable",
      },
      { status: decision.kind === "unauthorized" ? 401 : 503 },
    );
  }

  const res = NextResponse.json({ ok: true });
  if (decision.user.isAnonymous) {
    try {
      res.cookies.set(
        MIGRATE_COOKIE,
        signMigrateValue(decision.user.id),
        {
          httpOnly: true,
          secure: true,
          sameSite: "lax",
          path: "/",
          maxAge: MIGRATE_MAX_AGE,
        },
      );
    } catch (error) {
      log.error("auth.prepare_signup_cookie_fail", errInfo(error));
      return NextResponse.json(
        { error: "auth_unavailable" },
        { status: 503 },
      );
    }
  }
  return res;
}
