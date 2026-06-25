import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractOAuthProfile, safeNext } from "@/lib/oauth-metadata";
import { MIGRATE_COOKIE } from "@/lib/signup-cookie";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * OAuth 콜백 — linkIdentity(익명 승격) / signInWithOAuth(로그인) 공통 복귀점.
 * 1) identity_already_exists → 기존 OAuth 계정 재로그인 케이스 → /login?relogin=1.
 * 2) code 교환 → 세션 확립.
 * 3) 이메일 필수 게이트(verified-email linking 안전성).
 * 4) !익명 + 이메일 OK → 멤버 1회성 초기화(크레딧 5 + OAuth 닉/프사). 재로그인은 no-op.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const errorCode = url.searchParams.get("error_code");
  const next = safeNext(url.searchParams.get("next"));
  const rawP = url.searchParams.get("p");
  const provider = rawP === "kakao" || rawP === "google" ? rawP : null; // allowlist

  const redirect = (path: string) => NextResponse.redirect(new URL(path, request.url));
  // 마이그 쿠키 clear 한 redirect — 신규→/signup 정상 경로를 제외한 **모든 종료 경로**에 사용.
  const redirectClear = (path: string) => {
    const res = redirect(path);
    res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  };

  // (이전 linkIdentity 잔존 — 이제 항상 signInWithOAuth 라 거의 안 옴. 와도 재로그인 안내.)
  if (errorCode === "identity_already_exists") {
    log.info("auth.relogin_bounce", { provider, reason: "identity_already_exists" });
    return provider
      ? redirectClear(`/login?auto=${provider}&next=${encodeURIComponent(next)}`)
      : redirectClear(`/login?error=oauth&next=${encodeURIComponent(next)}`);
  }
  if (!code) {
    if (errorCode) log.warn("auth.callback_provider_error", { errorCode });
    return redirectClear("/login?error=oauth");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    log.warn("auth.callback_exchange_fail", { ...errInfo(error) });
    return redirectClear("/login?error=exchange");
  }
  const admin = createAdminClient();
  const { data: full } = await admin.auth.admin.getUserById(data.user.id);
  const user = full?.user ?? data.user;
  const profile = extractOAuthProfile(user);

  // 탈퇴(soft-delete) 계정 재로그인 차단 — 어떤 upsert 보다 먼저(0030).
  if (!user.is_anonymous) {
    const { data: delChk } = await admin
      .from("profiles")
      .select("deleted_at")
      .eq("id", user.id)
      .maybeSingle();
    if ((delChk as { deleted_at?: string | null } | null)?.deleted_at) {
      log.info("auth.deleted_account_blocked", { userId: user.id });
      await supabase.auth.signOut();
      return redirectClear("/login?error=account_deleted");
    }
  }

  // 이메일 필수 게이트.
  if (!user.is_anonymous && (!profile.email || !profile.emailVerified)) {
    log.warn("auth.callback_email_required", {
      userId: user.id,
      hasEmail: !!profile.email,
      verified: profile.emailVerified,
    });
    await supabase.auth.signOut();
    return redirectClear("/login?error=email_required");
  }

  // 익명 콜백(드묾) — 멤버 아님. 그대로.
  if (user.is_anonymous) return redirectClear(next);

  // 신규/기존 분기 — member_accounts 선조회. **자동 생성하지 않음.**
  const { data: member } = await admin
    .from("member_accounts")
    .select("user_id")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!member) {
    // 신규 → 동의 화면(/signup). 마이그 쿠키 **유지**(가입 완료 시 onboard 가 익명 데이터 이전).
    log.info("auth.signup_redirect", { userId: user.id });
    return redirect(`/signup?next=${encodeURIComponent(next)}`);
  }

  // 기존 회원 로그인 — 이메일 동기화만(자동 초기화/프로필 덮어쓰기 제거). 마이그 쿠키 clear.
  try {
    if (profile.email) {
      const { data: cur } = await admin
        .from("member_accounts")
        .select("email")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cur && cur.email !== profile.email) {
        await admin.from("member_accounts").update({ email: profile.email }).eq("user_id", user.id);
        log.info("auth.member_email_synced", { userId: user.id });
      }
    }
  } catch (e) {
    log.warn("auth.email_sync_fail", { userId: user.id, ...errInfo(e) });
  }
  return redirectClear(next);
}
