import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type MemberRow = {
  user_id: string;
  gen_credits: number;
  member_since: string;
  /** 만14세 이상 1회 확인 시각(0030). null=미확인 → 생성·결제 게이트(age_required). */
  age_confirmed_at: string | null;
  /** 재활성(탈퇴 복구) 후 현재 약관·방침 재동의가 필요한 상태(0037). true 면 reconsent 전까지 차단. */
  reconsent_required: boolean;
};

export type MemberGateError =
  | "unauthorized"
  | "member_only"
  | "member_setup_required"
  | "account_deleted"
  | "reconsent_required"
  | "not_admin";

export type RequireMemberResult =
  | { ok: true; user: User; member: MemberRow }
  | { ok: false; status: 401 | 403; error: MemberGateError };

/**
 * 멤버 전용 라우트 게이트 — 세 가지를 각각 구분.
 * - 세션 없음 → 401 unauthorized
 * - 익명 세션 → 403 member_only (비회원)
 * - permanent user 지만 member_accounts row 없음 → 403 member_setup_required (멤버화 부분 실패)
 * 성공 시 user + member(잔여 크레딧 포함) 반환.
 *
 * @param opts.allowReconsent 재동의 게이트 우회 — `/api/account/reconsent`·`/reconsent` 전용
 *   (순환 차단: 재동의 자체가 막히면 재동의를 못 함).
 */
export async function requireMember(opts?: {
  allowReconsent?: boolean;
}): Promise<RequireMemberResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  if (user.is_anonymous) return { ok: false, status: 403, error: "member_only" };

  const admin = createAdminClient();
  // 탈퇴(soft-delete) 계정 차단 — 모든 member-only 경로의 단일 choke point(0030 profiles.deleted_at).
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
    .select("user_id, gen_credits, member_since, age_confirmed_at, reconsent_required")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!member) return { ok: false, status: 403, error: "member_setup_required" };
  const m = member as MemberRow;
  // 재활성 회원은 현재 약관·방침 재동의 전까지 모든 member 경로 차단(reconsent 경로만 예외).
  if (!opts?.allowReconsent && m.reconsent_required) {
    return { ok: false, status: 403, error: "reconsent_required" };
  }
  return { ok: true, user, member: m };
}

/**
 * 관리자 전용 게이트 — requireMember 통과 + member_accounts.is_admin(0020).
 * is_admin 은 **별도·관용 조회**: 0020 컬럼 미적용/조회 실패 시 안전하게 비-admin(기존 회원 흐름 무영향).
 * (is_admin 은 service_role 전용 컬럼 → 자가부여 불가.)
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

/** requireMember/requireAdmin 실패 결과 → JSON 응답. */
export function memberGateResponse(
  r: Extract<RequireMemberResult, { ok: false }>
): NextResponse {
  return NextResponse.json({ error: r.error }, { status: r.status });
}
