import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { extractOAuthProfile } from "@/lib/oauth-metadata";
import { verifyMigrateValue } from "@/lib/signup-cookie";
import { log, errInfo } from "@/lib/log";

// 신규 회원 생성 시 부수효과(프로필 시드 + 익명데이터 이전) — 콜백(로그인 시 생성)·consent API(복구) 공용.
// 이전은 **신규 회원 생성(is_new) 경로에서만** 호출(I4 보수적 — 기존 회원은 자동 병합 안 함).

/** 신규 가입자의 OAuth 닉/프사를 profiles 에 시드(빈 값은 생략 — 기존 값 유지). best-effort. */
export async function seedOAuthProfile(admin: SupabaseClient, user: User): Promise<void> {
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
    log.warn("onboard.seed_profile_fail", { userId: user.id, ...errInfo(e) });
  }
}

export type MigrateResult = "migrated" | "skipped" | "failed";

/**
 * 익명→신규회원 데이터 이전 — 서명 쿠키 검증 + 안전검사 통과 시에만.
 * 반환: `migrated`(이전함) / `skipped`(쿠키없음·invalid·대상아님·이상데이터·이전불필요 → 재시도 무의미) /
 *       `failed`(reassign·조회 에러 — transient, 호출부가 MIGRATE_COOKIE 유지·재시도). 호출부가 쿠키 정책 결정.
 */
export async function migrateAnonData(
  admin: SupabaseClient,
  cookieValue: string | undefined,
  userId: string
): Promise<MigrateResult> {
  const anonId = verifyMigrateValue(cookieValue);
  if (!anonId || anonId === userId) return "skipped";
  try {
    const { data: anonUser } = await admin.auth.admin.getUserById(anonId);
    const isAnon = anonUser?.user?.is_anonymous === true;
    const { data: anonMember } = await admin
      .from("member_accounts")
      .select("user_id")
      .eq("user_id", anonId)
      .maybeSingle();
    if (!isAnon || anonMember) return "skipped";
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
      log.warn("onboard.anon_unexpected", {
        anonId,
        dolls: d.count,
        orders: o.count,
        gens: g.count,
      });
      return "skipped";
    }
    const { error: rErr } = await admin.rpc("reassign_anon_data", {
      p_old: anonId,
      p_new: userId,
    });
    if (rErr) {
      log.error("onboard.reassign_fail", { anonId, userId, ...errInfo(rErr) });
      return "failed";
    }
    try {
      await admin.auth.admin.deleteUser(anonId);
    } catch (e) {
      log.warn("onboard.anon_delete_fail", { anonId, ...errInfo(e) });
    }
    return "migrated";
  } catch (e) {
    log.warn("onboard.migrate_fail", { anonId, ...errInfo(e) });
    return "failed";
  }
}
