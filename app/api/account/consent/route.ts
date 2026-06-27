import { NextRequest, NextResponse } from "next/server";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { requireAuthedNonDeleted, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractOAuthProfile } from "@/lib/oauth-metadata";
import { getGrowthLevers } from "@/lib/config/getters";
import { getCurrentLegalVersions } from "@/lib/legal";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import { verifyMigrateValue, MIGRATE_COOKIE } from "@/lib/signup-cookie";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

const clearCookie = (res: NextResponse) => {
  res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
};

/**
 * 통합 동의 완료 — 신규가입·재활성·레거시·구버전 재동의 공용(onboard+reconsent+confirm-age 대체).
 * 경량 가드(I6, requireAuthedNonDeleted) → 서버가 필요 항목 재산출(I5) → RPC 가 insert/update 원자 처리(I4)
 * → 신규 insert 1회에만 OAuth 프로필 시드 + 익명데이터 이전. MIGRATE_COOKIE 는 터미널 경로만 clear(I2).
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
    // 이미 동의 완료 — no-op 성공(터미널 → 쿠키 clear).
    return clearCookie(NextResponse.json({ ok: true }));
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

  // I4: insert(보너스·stamp) / update(필요 항목만) 원자 처리 + is_new 반환.
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
    // I2: transient RPC 실패 — MIGRATE_COOKIE **유지**(다음 재시도에 익명이전 보존).
    log.error("account.consent_rpc_fail", { userId: user.id, ...errInfo(rpcErr) });
    return NextResponse.json({ error: "consent_failed" }, { status: 500 });
  }

  // 신규 insert 1회에만(원자적 승자): OAuth 프로필 시드 + 익명데이터 이전.
  if (isNewData === true) {
    await seedProfile(admin, user);
    await migrateAnonData(admin, req, user.id);
  }

  log.info("account.consent_success", { userId: user.id, isNew: isNewData === true });
  return clearCookie(NextResponse.json({ ok: true })); // I2: 성공 → clear
}

/** 신규 가입자의 OAuth 닉/프사를 profiles 에 시드(빈 값은 생략 — 기존 값 유지). */
async function seedProfile(admin: SupabaseClient, user: User): Promise<void> {
  try {
    const { data: full } = await admin.auth.admin.getUserById(user.id);
    const profile = extractOAuthProfile(full?.user ?? user);
    const patch: Record<string, string> = {};
    if (profile.displayName) patch.display_name = profile.displayName;
    if (profile.avatarUrl) patch.avatar_url = profile.avatarUrl;
    if (Object.keys(patch).length > 0) {
      await admin.from("profiles").update(patch).eq("id", user.id);
    }
  } catch (e) {
    log.warn("account.consent_profile_fail", { userId: user.id, ...errInfo(e) });
  }
}

/** 익명 데이터 이전 — 서명 쿠키 검증 + 안전 검사 통과 시에만(onboard 와 동일 로직). */
async function migrateAnonData(
  admin: SupabaseClient,
  req: NextRequest,
  userId: string
): Promise<void> {
  const anonId = verifyMigrateValue(req.cookies.get(MIGRATE_COOKIE)?.value);
  if (!anonId || anonId === userId) return;
  try {
    const { data: anonUser } = await admin.auth.admin.getUserById(anonId);
    const isAnon = anonUser?.user?.is_anonymous === true;
    const { data: anonMember } = await admin
      .from("member_accounts")
      .select("user_id")
      .eq("user_id", anonId)
      .maybeSingle();
    if (!isAnon || anonMember) return;
    // 익명에 있으면 안 되는 데이터(이상) — 이동·삭제 스킵 + 경고(수동 검토).
    const [d, o, g] = await Promise.all([
      admin.from("dolls").select("id", { head: true, count: "exact" }).eq("owner_id", anonId),
      admin
        .from("payapp_orders")
        .select("order_uuid", { head: true, count: "exact" })
        .eq("user_id", anonId),
      admin
        .from("ai_generations")
        .select("id", { head: true, count: "exact" })
        .eq("owner_id", anonId),
    ]);
    const unexpected = (d.count ?? 0) + (o.count ?? 0) + (g.count ?? 0);
    if (unexpected > 0) {
      log.warn("account.consent_anon_unexpected", {
        anonId,
        dolls: d.count,
        orders: o.count,
        gens: g.count,
      });
      return;
    }
    const { error: rErr } = await admin.rpc("reassign_anon_data", {
      p_old: anonId,
      p_new: userId,
    });
    if (rErr) {
      log.error("account.reassign_fail", { anonId, userId, ...errInfo(rErr) });
      return;
    }
    try {
      await admin.auth.admin.deleteUser(anonId);
    } catch (e) {
      log.warn("account.anon_delete_fail", { anonId, ...errInfo(e) });
    }
  } catch (e) {
    log.warn("account.consent_migrate_fail", { anonId, ...errInfo(e) });
  }
}
