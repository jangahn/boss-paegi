import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractOAuthProfile, safeNext } from "@/lib/oauth-metadata";
import { MIGRATE_COOKIE } from "@/lib/signup-cookie";
import { getCurrentLegalVersions } from "@/lib/legal";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * OAuth 콜백 — 세션 확립 + **동의여부 판정 분기**. 글로벌 동의 모델:
 * **회원 생성·가입보너스·OAuth 시드·익명이전은 모두 동의 시점(consent API)** — 콜백은 안 만듦.
 * 1) 교환 → 세션. 2) 탈퇴/이메일 게이트(세션·쿠키 정리). 3) 비익명:
 *    미동의(신규 no-row/레거시/구버전) → **직접 `/consent`**(MIGRATE 유지 → consent 가 is_new 시 이전+clear).
 *    동의완료(기존회원) → 이메일 동기화 + 목적지(MIGRATE clear). proxy 는 뒤로가기/직접URL 방어선.
 */
export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const errorCode = url.searchParams.get("error_code");
  const next = safeNext(url.searchParams.get("next"));
  const rawP = url.searchParams.get("p");
  const provider = rawP === "kakao" || rawP === "google" ? rawP : null; // allowlist

  const redirect = (path: string) => NextResponse.redirect(new URL(path, request.url));
  // 마이그 쿠키 clear redirect — 정상 종료 경로(동의완료/익명).
  const redirectClear = (path: string) => {
    const res = redirect(path);
    res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  };
  // 탈퇴/이메일 게이트 — 세션 종료 + sb-* auth 쿠키·MIGRATE 만료 + no-store (잔존 세션 루프 방지, E2).
  const signoutClear = (path: string) => {
    const res = redirect(path);
    for (const c of request.cookies.getAll()) {
      if (c.name.startsWith("sb-")) res.cookies.set(c.name, "", { maxAge: 0, path: "/" });
    }
    res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
    res.headers.set("Cache-Control", "no-store");
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

  // 탈퇴(soft-delete) 계정 재로그인 차단 — 어떤 분기보다 먼저(0030). 세션·쿠키 정리(E2).
  if (!user.is_anonymous) {
    const { data: delChk } = await admin
      .from("profiles")
      .select("deleted_at")
      .eq("id", user.id)
      .maybeSingle();
    if ((delChk as { deleted_at?: string | null } | null)?.deleted_at) {
      log.info("auth.deleted_account_blocked", { userId: user.id });
      await supabase.auth.signOut();
      return signoutClear("/login?error=account_deleted");
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
    return signoutClear("/login?error=email_required");
  }

  // 익명 콜백(드묾) — 멤버 아님. 그대로.
  if (user.is_anonymous) return redirectClear(next);

  // 비익명 — 동의여부로 분기(회원 생성은 consent API). member 동의 컬럼 + 현재 버전 병렬 조회.
  const [memberRes, curr] = await Promise.all([
    admin
      .from("member_accounts")
      .select("age_confirmed_at, terms_version, privacy_version, email")
      .eq("user_id", user.id)
      .maybeSingle(),
    getCurrentLegalVersions(),
  ]);
  const m = memberRes.data as {
    age_confirmed_at: string | null;
    terms_version: number | null;
    privacy_version: number | null;
    email: string | null;
  } | null;

  // 기존 회원 이메일 동기화(동의 무관, best-effort).
  if (m && profile.email && m.email !== profile.email) {
    try {
      await admin.from("member_accounts").update({ email: profile.email }).eq("user_id", user.id);
      log.info("auth.member_email_synced", { userId: user.id });
    } catch (e) {
      log.warn("auth.email_sync_fail", { userId: user.id, ...errInfo(e) });
    }
  }

  const member: ConsentMember = m
    ? { age_confirmed_at: m.age_confirmed_at, terms_version: m.terms_version, privacy_version: m.privacy_version }
    : null;
  if (missingConsentItems(member, curr).length > 0) {
    // 미동의(신규 no-row/레거시/구버전) → **직접 동의화면**. MIGRATE_COOKIE **유지**
    // (consent API 가 is_new INSERT 시 익명이전+clear, C3). proxy 의존 없이 보냄.
    log.info("auth.consent_required", { userId: user.id, isNew: !m });
    return redirect(`/consent?next=${encodeURIComponent(next)}`);
  }
  // 동의완료(기존회원) → 목적지(MIGRATE clear — 마이그 불요).
  return redirectClear(next);
}
