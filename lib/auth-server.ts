import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentLegalVersions } from "@/lib/legal";
import { missingConsentItems } from "@/lib/consent";

export type MemberRow = {
  user_id: string;
  gen_credits: number;
  member_since: string;
  /** 만14세 이상 1회 확인 시각(0030). null=미확인. */
  age_confirmed_at: string | null;
  /** 동의 시점 약관/방침 발행본 버전(0031). null=미동의 또는 발행본 없을 때 동의. */
  terms_version: number | null;
  privacy_version: number | null;
};

export type MemberGateError =
  | "unauthorized"
  | "member_only"
  | "consent_required"
  | "account_deleted"
  | "not_admin";

export type RequireMemberResult =
  | { ok: true; user: User; member: MemberRow }
  | { ok: false; status: 401 | 403; error: MemberGateError };

export type AuthGateResult =
  | { ok: true; user: User }
  | { ok: false; status: 401 | 403; error: MemberGateError };

/**
 * 멤버 전용 라우트 게이트 — 모든 member-only API/RSC 의 단일 choke point.
 * - 세션 없음 → 401 `unauthorized`
 * - 익명 세션 → 403 `member_only`(비회원)
 * - 탈퇴(soft-delete) → 403 `account_deleted`
 * - member_accounts row 없음(in-between) **또는** 동의 미충족(레거시·구버전·재활성) → 403 `consent_required`
 * 성공 시 user + member(잔여 크레딧 포함) 반환.
 *
 * 동의 판정은 `lib/consent.missingConsentItems` 단일 규칙 + `getCurrentLegalVersions`(캐시).
 * **fail-open(I9)**: 버전 조회 실패는 null → stamp 된 회원을 강등하지 않음(age·row 검사는 항상 유효 →
 * row없음/age null 은 그래도 consent_required). `/consent`·`/api/account/consent` 는 이 게이트가 아니라
 * `requireAuthedNonDeleted` 경량 가드를 써서 self-block 을 구조적으로 방지한다(I6).
 */
export async function requireMember(): Promise<RequireMemberResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  if (user.is_anonymous) return { ok: false, status: 403, error: "member_only" };

  const admin = createAdminClient();
  // 탈퇴(soft-delete) 계정 차단(0030 profiles.deleted_at).
  const { data: prof } = await admin
    .from("profiles")
    .select("deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if ((prof as { deleted_at?: string | null } | null)?.deleted_at) {
    return { ok: false, status: 403, error: "account_deleted" };
  }

  const { data: member } = await admin
    .from("member_accounts")
    .select(
      "user_id, gen_credits, member_since, age_confirmed_at, terms_version, privacy_version"
    )
    .eq("user_id", user.id)
    .maybeSingle();

  if (!member) return { ok: false, status: 403, error: "consent_required" };
  const m = member as MemberRow;

  const curr = await getCurrentLegalVersions();
  if (missingConsentItems(m, curr).length > 0) {
    return { ok: false, status: 403, error: "consent_required" };
  }
  return { ok: true, user, member: m };
}

/**
 * 경량 인증 가드 — `/consent` 페이지·`/api/account/consent`·`/api/account/consent/cancel` 전용(I6).
 * session ∧ 비익명 ∧ 비탈퇴만 확인(member_accounts·동의 검사 안 함 → row 없는 in-between 도 통과해
 * 동의를 완료할 수 있다). 동의 게이트가 동의 화면을 막는 self-block 을 방지.
 */
export async function requireAuthedNonDeleted(): Promise<AuthGateResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  if (user.is_anonymous) return { ok: false, status: 403, error: "member_only" };

  const admin = createAdminClient();
  const { data: prof } = await admin
    .from("profiles")
    .select("deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if ((prof as { deleted_at?: string | null } | null)?.deleted_at) {
    return { ok: false, status: 403, error: "account_deleted" };
  }
  return { ok: true, user };
}

/**
 * 관리자 전용 게이트 — requireMember 통과 + member_accounts.is_admin(0020).
 * is_admin 은 service_role 전용 컬럼 → 자가부여 불가. 조회 실패/미적용 시 안전하게 비-admin.
 */
export async function requireAdmin(): Promise<RequireMemberResult> {
  const r = await requireMember();
  if (!r.ok) return r;
  const admin = createAdminClient();
  const { data, error } = await admin
    .from("member_accounts")
    .select("is_admin")
    .eq("user_id", r.user.id)
    .maybeSingle();
  if (error || !(data as { is_admin?: boolean } | null)?.is_admin) {
    return { ok: false, status: 403, error: "not_admin" };
  }
  return r;
}

/** requireMember/requireAdmin/requireAuthedNonDeleted 실패 결과 → JSON 응답. */
export function memberGateResponse(
  r: Extract<RequireMemberResult | AuthGateResult, { ok: false }>
): NextResponse {
  return NextResponse.json({ error: r.error }, { status: r.status });
}
