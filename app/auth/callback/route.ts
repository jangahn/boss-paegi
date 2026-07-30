import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractOAuthProfile, safeNext } from "@/lib/oauth-metadata";
import { syncOAuthProfile } from "@/lib/account-onboard";
import { MIGRATE_COOKIE } from "@/lib/signup-cookie";
import { getCurrentLegalVersionsStrict } from "@/lib/legal/strict-versions";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import {
  resolveDbRead,
  resolveRequiredDbRead,
  type AuthReadSource,
} from "@/lib/auth-read-policy";
import { requireSupabaseSuccess } from "@/lib/supabase-operation";
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
  // DB 판정 불가 — 삭제/미동의/완료로 오분류하지 않고 동의 경계에 머문다.
  // 세션·MIGRATE_COOKIE를 보존해 DB 복구 후 /consent가 신규/기존 정책대로 다시 판정한다.
  const redirectReadRetry = (
    userId: string,
    source: AuthReadSource,
    readError: unknown
  ) => {
    log.error("auth.callback_read_fail", {
      userId,
      source,
      ...errInfo(readError),
    });
    const res = redirect(
      `/consent?next=${encodeURIComponent(next)}&error=service_unavailable`
    );
    res.headers.set("Cache-Control", "no-store");
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
  let user = data.user;
  try {
    const full = await requireSupabaseSuccess("auth.callback_user_read", () =>
      admin.auth.admin.getUserById(data.user.id),
    );
    user = full.data.user ?? data.user;
  } catch (readError) {
    // 세션 교환 결과는 인증된 fallback이다. 관리자 API 장애는 명시적으로 관측하되
    // 삭제/동의 DB 게이트를 건너뛰지는 않는다.
    log.warn("auth.callback_user_read_fail", {
      userId: data.user.id,
      ...errInfo(readError),
    });
  }
  const profile = extractOAuthProfile(user);

  // 탈퇴(soft-delete) 계정 재로그인 차단 — 어떤 분기보다 먼저(0030). 세션·쿠키 정리(E2).
  if (!user.is_anonymous) {
    let profileResult;
    try {
      profileResult = await admin
        .from("profiles")
        .select("deleted_at")
        .eq("id", user.id)
        .maybeSingle();
    } catch (readError) {
      return redirectReadRetry(user.id, "profile", readError);
    }
    const profileRead = resolveRequiredDbRead("profile", profileResult);
    if (!profileRead.ok) {
      return redirectReadRetry(user.id, profileRead.source, profileRead.error);
    }
    if ((profileRead.data as { deleted_at?: string | null } | null)?.deleted_at) {
      log.info("auth.deleted_account_blocked", { userId: user.id });
      try {
        await requireSupabaseSuccess("auth.callback_signout", () =>
          supabase.auth.signOut(),
        );
      } catch (signoutError) {
        // 응답의 auth cookie는 아래에서 강제 만료하므로 차단 자체는 유지한다.
        log.warn("auth.callback_signout_fail", {
          userId: user.id,
          ...errInfo(signoutError),
        });
      }
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
    try {
      await requireSupabaseSuccess("auth.callback_signout", () =>
        supabase.auth.signOut(),
      );
    } catch (signoutError) {
      log.warn("auth.callback_signout_fail", {
        userId: user.id,
        ...errInfo(signoutError),
      });
    }
    return signoutClear("/login?error=email_required");
  }

  // 익명 콜백(드묾) — 멤버 아님. 그대로.
  if (user.is_anonymous) return redirectClear(next);

  // 비익명 — 동의여부로 분기(회원 생성은 consent API).
  // no-row와 실제 member/legal 조회 실패를 구분해 오류에서는 MIGRATE를 보존하고 경계에 머문다.
  let memberResult;
  try {
    memberResult = await admin
      .from("member_accounts")
      .select("age_confirmed_at, terms_version, privacy_version, email")
      .eq("user_id", user.id)
      .maybeSingle();
  } catch (readError) {
    return redirectReadRetry(user.id, "member", readError);
  }
  const memberRead = resolveDbRead("member", memberResult);
  if (!memberRead.ok) {
    return redirectReadRetry(user.id, memberRead.source, memberRead.error);
  }

  let curr;
  try {
    curr = await getCurrentLegalVersionsStrict();
  } catch (readError) {
    return redirectReadRetry(user.id, "legal", readError);
  }

  const m = memberRead.data as {
    age_confirmed_at: string | null;
    terms_version: number | null;
    privacy_version: number | null;
    email: string | null;
  } | null;

  // Existing-member OAuth sync is lifecycle-fenced in one DB RPC. A dependency
  // failure remains at the retry boundary; a delayed callback cannot write PII
  // after account deletion.
  if (m && profile.email) {
    try {
      await syncOAuthProfile(admin, user.id, profile);
      log.info("auth.member_email_synced", { userId: user.id });
    } catch (e) {
      return redirectReadRetry(user.id, "member", e);
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
