import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractOAuthProfile, safeNext } from "@/lib/oauth-metadata";
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

  const redirect = (path: string) => NextResponse.redirect(new URL(path, request.url));

  // 1) linkIdentity 가 "이미 연결된 식별자" 로 실패 → 기존 계정 재로그인 유도.
  if (errorCode === "identity_already_exists") {
    return redirect(`/login?relogin=1&next=${encodeURIComponent(next)}`);
  }
  if (!code) {
    if (errorCode) log.warn("auth.callback_provider_error", { errorCode });
    return redirect("/login?error=oauth");
  }

  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user) {
    log.warn("auth.callback_exchange_fail", { ...errInfo(error) });
    return redirect("/login?error=exchange");
  }
  // linkIdentity 는 OAuth 데이터를 user_metadata 에 머지하지 않음 → identities[].identity_data 에만 있음.
  // admin 으로 identities 포함된 권위 user 를 조회해야 닉/프사/이메일을 제대로 읽는다.
  const admin = createAdminClient();
  const { data: full } = await admin.auth.admin.getUserById(data.user.id);
  const user = full?.user ?? data.user;
  const profile = extractOAuthProfile(user);

  // 3) 이메일 필수 — 없거나 미검증이면 멤버화하지 않고 세션 종료 후 안내.
  if (!user.is_anonymous && (!profile.email || !profile.emailVerified)) {
    log.warn("auth.callback_email_required", {
      userId: user.id,
      hasEmail: !!profile.email,
      verified: profile.emailVerified,
    });
    await supabase.auth.signOut();
    return redirect("/login?error=email_required");
  }

  // 4) 멤버 1회성 초기화 — member_accounts 신규 insert 일 때만 프로필 덮어씀(재로그인 보존).
  if (!user.is_anonymous) {
    try {
      const { data: rows, error: upErr } = await admin
        .from("member_accounts")
        .upsert(
          { user_id: user.id, gen_credits: 5 },
          { onConflict: "user_id", ignoreDuplicates: true }
        )
        .select("user_id");
      if (upErr) throw upErr;

      const isNewMember = (rows?.length ?? 0) > 0;
      if (isNewMember) {
        const patch: Record<string, string> = {};
        if (profile.displayName) patch.display_name = profile.displayName;
        if (profile.avatarUrl) patch.avatar_url = profile.avatarUrl;
        if (Object.keys(patch).length > 0) {
          await admin.from("profiles").update(patch).eq("id", user.id);
        }
        log.info("auth.member_created", { userId: user.id });
      }
    } catch (e) {
      // 멤버 row 생성 실패 → permanent user 지만 멤버 상태 없음.
      // requireMember 가 member_setup_required 로 처리하므로 치명적이진 않으나 추적.
      log.error("auth.member_init_fail", { userId: user.id, ...errInfo(e) });
    }
  }

  return redirect(next);
}
