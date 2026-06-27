import { NextRequest, NextResponse } from "next/server";
import { requireAuthedNonDeleted, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGrowthLevers } from "@/lib/config/getters";
import { getCurrentLegalVersions } from "@/lib/legal";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import { seedOAuthProfile, migrateAnonData } from "@/lib/account-onboard";
import { MIGRATE_COOKIE } from "@/lib/signup-cookie";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

const clearCookie = (res: NextResponse) => {
  res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
};

/**
 * 동의 완료 + (콜백이 회원 생성 못 했을 때) **INSERT 복구**(I3). 보통은 콜백이 로그인 시 회원을 만들고
 * 여기선 UPDATE(stamp)만 하지만, row 없으면 INSERT(보너스·시드·익명이전 신규 1회).
 * 경량 가드(I6) → I5 재산출 → RPC insert/update(I7: 버전 null 항목은 미요구·미stamp).
 * MIGRATE_COOKIE: INSERT 성공/이미완료=clear, RPC 실패(미생성)=유지(재시도).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAuthedNonDeleted();
  if (!gate.ok) return memberGateResponse(gate); // 쿠키 유지(비터미널)
  const user = gate.user;
  const admin = createAdminClient();

  // I5: 서버가 현재 상태로 필요 항목 재산출(클라가 보낸 items 신뢰 금지).
  const [member, curr] = await Promise.all([
    admin
      .from("member_accounts")
      .select("age_confirmed_at, terms_version, privacy_version")
      .eq("user_id", user.id)
      .maybeSingle()
      .then((r) => (r.data as ConsentMember) ?? null),
    getCurrentLegalVersions(),
  ]);
  const required = missingConsentItems(member, curr);
  if (required.length === 0) {
    return clearCookie(NextResponse.json({ ok: true })); // 이미 동의 완료
  }

  // 제출 동의가 필요한 항목을 모두 충족하는지 검증(미충족이면 재시도 가능 → 쿠키 유지).
  const body = (await req.json().catch(() => ({}))) as {
    age?: boolean;
    terms?: boolean;
    privacy?: boolean;
  };
  if (!required.every((item) => body[item] === true)) {
    return NextResponse.json({ error: "consent_required" }, { status: 400 });
  }

  const bonus = await getGrowthLevers()
    .then((g) => g.signupBonusCredits)
    .catch(() => 0);

  // I7: terms/privacy 는 현재 버전이 있을 때(required 에 포함)만 stamp — 버전 null 이면 required 에 없어 p_set=false.
  const { data: isNewData, error: rpcErr } = await admin.rpc(
    "create_or_update_member_consent",
    {
      p_user_id: user.id,
      p_bonus: bonus,
      p_set_age: required.includes("age"),
      p_set_terms: required.includes("terms"),
      p_terms_ver: curr.terms,
      p_set_privacy: required.includes("privacy"),
      p_privacy_ver: curr.privacy,
    }
  );
  if (rpcErr) {
    // INSERT/UPDATE 실패(미생성) — MIGRATE_COOKIE **유지**(다음 재시도에 익명이전 보존, I4).
    log.error("account.consent_rpc_fail", { userId: user.id, ...errInfo(rpcErr) });
    return NextResponse.json({ error: "consent_failed" }, { status: 500 });
  }

  // INSERT 복구(콜백이 못 만든 신규)에서만: OAuth 프로필 시드 + 익명데이터 이전(I3/I4).
  if (isNewData === true) {
    await seedOAuthProfile(admin, user);
    await migrateAnonData(admin, req.cookies.get(MIGRATE_COOKIE)?.value, user.id);
  }

  log.info("account.consent_success", { userId: user.id, isNew: isNewData === true });
  return clearCookie(NextResponse.json({ ok: true })); // 성공 → clear
}
