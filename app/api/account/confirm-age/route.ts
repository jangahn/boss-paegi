import { NextResponse } from "next/server";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

/**
 * 만14세 이상 1회 확인 — member_accounts.age_confirmed_at 설정(멱등).
 * DOB/나이는 저장하지 않는다(확인 시각만). 생성·결제 게이트가 이 플래그로 차단.
 */
export async function POST() {
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);

  if (!gate.member.age_confirmed_at) {
    const admin = createAdminClient();
    await admin
      .from("member_accounts")
      .update({ age_confirmed_at: new Date().toISOString() })
      .eq("user_id", gate.user.id)
      .is("age_confirmed_at", null); // 이미 있으면 유지(덮어쓰지 않음)
  }
  return NextResponse.json({ ok: true });
}
