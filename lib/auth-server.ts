import "server-only";
import { cache } from "react";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { missingConsentItems } from "@/lib/consent";
import {
  resolveDbRead,
  resolveAdminAuthorityRead,
  resolveAuthUserRead,
  resolveRequiredDbRead,
  type AuthReadSource,
} from "@/lib/auth-read-policy";
import { log, errInfo } from "@/lib/log";
import { readCurrentAuthSessionState } from "@/lib/auth-session-live";

export type MemberRow = {
  user_id: string;
  gen_credits: number;
  member_since: string;
  /** 만 19세 이상 1회 확인 시각(2026-08-21 연령 상향 전엔 만 14세 기준). null=미확인. */
  age_confirmed_at: string | null;
  /** 동의 시각(버전 무관 불리언 모델, 2026-08-21). null=미동의. */
  terms_agreed_at: string | null;
  privacy_agreed_at: string | null;
};

export type MemberGateError =
  | "unauthorized"
  | "member_only"
  | "consent_required"
  | "account_deleted"
  | "not_admin"
  | "service_unavailable";

export type RequireMemberResult =
  | { ok: true; user: User; member: MemberRow }
  | { ok: false; status: 401 | 403 | 503; error: MemberGateError };

export type AuthGateResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403 | 503; error: MemberGateError };

function unavailable(
  userId: string | null,
  source: AuthReadSource,
  error: unknown,
): Extract<RequireMemberResult | AuthGateResult, { ok: false }> {
  log.error("auth.gate_read_fail", { userId, source, ...errInfo(error) });
  return { ok: false, status: 503, error: "service_unavailable" };
}

async function requireCurrentAuthUser(): Promise<AuthGateResult> {
  const supabase = await createClient();
  let authResult;
  try {
    authResult = await supabase.auth.getUser();
  } catch (error) {
    return unavailable(null, "auth", error);
  }
  const authRead = resolveAuthUserRead(authResult);
  if (!authRead.ok) {
    return authRead.kind === "unauthorized"
      ? { ok: false, status: 401, error: "unauthorized" }
      : unavailable(null, "auth", authRead.error);
  }
  const sessionState = await readCurrentAuthSessionState(() =>
    supabase.rpc("oauth_current_auth_session_live"),
  );
  if (sessionState.kind === "revoked") {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  if (sessionState.kind === "unavailable") {
    return unavailable(
      authRead.user.id,
      "auth",
      sessionState.error,
    );
  }
  return { ok: true, user: authRead.user };
}

/**
 * 멤버 전용 라우트 게이트 — 모든 member-only API/RSC 의 단일 choke point.
 * - 세션 없음 → 401 `unauthorized`
 * - 익명 세션 → 403 `member_only`(비회원)
 * - 탈퇴(soft-delete) → 403 `account_deleted`
 * - member_accounts row 없음(in-between) **또는** 동의 미충족(레거시·구버전·재활성) → 403 `consent_required`
 * 성공 시 user + member(잔여 크레딧 포함) 반환.
 *
 * 동의 판정은 `lib/consent.missingConsentItems` 단일 규칙(버전 무관·timestamp 유무).
 * profiles/member/legal 조회 실패는 상태 없음과 구분해 503 fail-closed한다. `/consent`·
 * `/api/account/consent` 는 이 게이트가 아니라 `requireAuthedNonDeleted` 경량 가드를 써서
 * self-block 을 구조적으로 방지한다(I6).
 */
export async function requireMember(): Promise<RequireMemberResult> {
  const authRead = await requireCurrentAuthUser();
  if (!authRead.ok) return authRead;
  const user = authRead.user;
  if (user.is_anonymous) return { ok: false, status: 403, error: "member_only" };

  const admin = createAdminClient();
  // 탈퇴(soft-delete) 계정 차단(0030 profiles.deleted_at).
  let profResult;
  try {
    profResult = await admin
      .from("profiles")
      .select("deleted_at")
      .eq("id", user.id)
      .maybeSingle();
  } catch (error) {
    return unavailable(user.id, "profile", error);
  }
  const prof = resolveRequiredDbRead("profile", profResult);
  if (!prof.ok) return unavailable(user.id, prof.source, prof.error);
  if ((prof.data as { deleted_at?: string | null } | null)?.deleted_at) {
    return { ok: false, status: 403, error: "account_deleted" };
  }

  let memberResult;
  try {
    memberResult = await admin
      .from("member_accounts")
      .select(
        "user_id, gen_credits, member_since, age_confirmed_at, terms_agreed_at, privacy_agreed_at"
      )
      .eq("user_id", user.id)
      .maybeSingle();
  } catch (error) {
    return unavailable(user.id, "member", error);
  }
  const member = resolveDbRead("member", memberResult);
  if (!member.ok) return unavailable(user.id, member.source, member.error);

  if (!member.data) return { ok: false, status: 403, error: "consent_required" };
  const m = member.data as MemberRow;

  if (missingConsentItems(m).length > 0) {
    return { ok: false, status: 403, error: "consent_required" };
  }
  return { ok: true, user, member: m };
}

/**
 * 로그인 세션 쓰기 게이트 — anonymous 플레이어도 허용하되 삭제된 profile은 차단한다.
 *
 * score/highlight처럼 제품상 anonymous 쓰기를 지원해 requireMember를 쓸 수 없는 경로가
 * auth.getUser()만 확인하면, 탈퇴 뒤 남은 세션으로 새 child row/Storage attach를 만들 수 있다.
 * profiles 조회 실패·no-row는 상태 없음으로 강등하지 않고 503 fail-closed한다.
 */
export async function requireActiveUser(): Promise<AuthGateResult> {
  const authRead = await requireCurrentAuthUser();
  if (!authRead.ok) return authRead;
  const user = authRead.user;

  const admin = createAdminClient();
  let profResult;
  try {
    profResult = await admin
      .from("profiles")
      .select("deleted_at")
      .eq("id", user.id)
      .maybeSingle();
  } catch (error) {
    return unavailable(user.id, "profile", error);
  }
  const prof = resolveRequiredDbRead("profile", profResult);
  if (!prof.ok) return unavailable(user.id, prof.source, prof.error);
  if ((prof.data as { deleted_at?: string | null } | null)?.deleted_at) {
    return { ok: false, status: 403, error: "account_deleted" };
  }
  return { ok: true, user };
}

/**
 * 경량 인증 가드 — `/consent` 페이지·`/api/account/consent`·`/api/account/consent/cancel` 전용(I6).
 * session ∧ 비익명 ∧ 비탈퇴만 확인(member_accounts·동의 검사 안 함 → row 없는 in-between 도 통과해
 * 동의를 완료할 수 있다). 동의 게이트가 동의 화면을 막는 self-block 을 방지.
 */
export async function requireAuthedNonDeleted(): Promise<AuthGateResult> {
  const authRead = await requireCurrentAuthUser();
  if (!authRead.ok) return authRead;
  const user = authRead.user;
  if (user.is_anonymous) return { ok: false, status: 403, error: "member_only" };

  const admin = createAdminClient();
  let profResult;
  try {
    profResult = await admin
      .from("profiles")
      .select("deleted_at")
      .eq("id", user.id)
      .maybeSingle();
  } catch (error) {
    return unavailable(user.id, "profile", error);
  }
  const prof = resolveRequiredDbRead("profile", profResult);
  if (!prof.ok) return unavailable(user.id, prof.source, prof.error);
  if ((prof.data as { deleted_at?: string | null } | null)?.deleted_at) {
    return { ok: false, status: 403, error: "account_deleted" };
  }
  return { ok: true, user };
}

/**
 * 관리자 전용 게이트 — requireMember 통과 + member_accounts.is_admin(0020).
 * is_admin 은 service_role 전용 컬럼 → 자가부여 불가. 실제 false만 403이고,
 * 조회 오류·throw·no-row·손상 응답은 권한 부재로 위장하지 않고 503 fail-closed한다.
 *
 * React cache는 장기 권한 캐시가 아니라 동일 server render pass 안의 memoization이다.
 * 병렬 layout/page가 각각 이 경계를 가까이 호출해도 auth·authority read는 한 번만
 * 수행하고, 다음 요청에서는 반드시 다시 판정한다.
 */
export const requireAdmin = cache(async (): Promise<RequireMemberResult> => {
  const r = await requireMember();
  if (!r.ok) return r;
  const admin = createAdminClient();
  let authorityResult;
  try {
    authorityResult = await admin
      .from("member_accounts")
      .select("is_admin")
      .eq("user_id", r.user.id)
      .maybeSingle();
  } catch (error) {
    return unavailable(r.user.id, "member", error);
  }
  const authority = resolveAdminAuthorityRead(authorityResult);
  if (!authority.ok) {
    return unavailable(r.user.id, authority.source, authority.error);
  }
  if (!authority.isAdmin) {
    return { ok: false, status: 403, error: "not_admin" };
  }
  return r;
});

/** requireMember/requireAdmin/requireAuthedNonDeleted 실패 결과 → JSON 응답. */
export function memberGateResponse(
  r: Extract<RequireMemberResult | AuthGateResult, { ok: false }>
): NextResponse {
  return NextResponse.json({ error: r.error }, { status: r.status });
}
