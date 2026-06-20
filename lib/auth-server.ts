import "server-only";
import { NextResponse } from "next/server";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";

export type MemberRow = {
  user_id: string;
  gen_credits: number;
  member_since: string;
};

export type MemberGateError = "unauthorized" | "member_only" | "member_setup_required";

export type RequireMemberResult =
  | { ok: true; user: User; member: MemberRow }
  | { ok: false; status: 401 | 403; error: MemberGateError };

/**
 * 멤버 전용 라우트 게이트 — 세 가지를 각각 구분.
 * - 세션 없음 → 401 unauthorized
 * - 익명 세션 → 403 member_only (비회원)
 * - permanent user 지만 member_accounts row 없음 → 403 member_setup_required (멤버화 부분 실패)
 * 성공 시 user + member(잔여 크레딧 포함) 반환.
 */
export async function requireMember(): Promise<RequireMemberResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return { ok: false, status: 401, error: "unauthorized" };
  if (user.is_anonymous) return { ok: false, status: 403, error: "member_only" };

  const admin = createAdminClient();
  const { data: member } = await admin
    .from("member_accounts")
    .select("user_id, gen_credits, member_since")
    .eq("user_id", user.id)
    .maybeSingle();

  if (!member) return { ok: false, status: 403, error: "member_setup_required" };
  return { ok: true, user, member: member as MemberRow };
}

/** requireMember 실패 결과 → JSON 응답. */
export function memberGateResponse(
  r: Extract<RequireMemberResult, { ok: false }>
): NextResponse {
  return NextResponse.json({ error: r.error }, { status: r.status });
}
