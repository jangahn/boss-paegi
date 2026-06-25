import { NextResponse } from "next/server";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getCurrentLegal } from "@/lib/legal";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 재활성(탈퇴 복구) 회원의 **현재 약관·방침 재동의** — `reconsent_required` 해제(0037).
 * 연령은 재확인하지 않는다(age_confirmed_at 유지) → body 는 {terms, privacy} 만.
 * 게이트는 `allowReconsent:true`(이 경로만 reconsent_required 차단 우회 — 순환 방지).
 */
export async function POST(req: Request) {
  const gate = await requireMember({ allowReconsent: true });
  if (!gate.ok) return memberGateResponse(gate);
  // 이미 동의 완료(재활성 대상 아님) → no-op 성공.
  if (!gate.member.reconsent_required) return NextResponse.json({ ok: true });

  const body = (await req.json().catch(() => ({}))) as {
    terms?: boolean;
    privacy?: boolean;
  };
  if (!body.terms || !body.privacy) {
    return NextResponse.json({ error: "consent_required" }, { status: 400 });
  }

  const now = new Date().toISOString();
  const [termsDoc, privacyDoc] = await Promise.all([
    getCurrentLegal("terms").catch(() => null),
    getCurrentLegal("privacy").catch(() => null),
  ]);

  const admin = createAdminClient();
  const { error } = await admin
    .from("member_accounts")
    .update({
      reconsent_required: false,
      terms_agreed_at: now,
      privacy_agreed_at: now,
      terms_version: termsDoc?.version ?? null,
      privacy_version: privacyDoc?.version ?? null,
      updated_at: now,
    })
    .eq("user_id", gate.user.id);
  if (error) {
    log.error("account.reconsent_fail", { userId: gate.user.id, ...errInfo(error) });
    return NextResponse.json({ error: "reconsent_failed" }, { status: 500 });
  }

  log.info("account.reconsent_success", { userId: gate.user.id });
  return NextResponse.json({ ok: true });
}
