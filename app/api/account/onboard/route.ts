import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { extractOAuthProfile } from "@/lib/oauth-metadata";
import { getGrowthLevers } from "@/lib/config/getters";
import { getCurrentLegal } from "@/lib/legal";
import { verifyMigrateValue, MIGRATE_COOKIE } from "@/lib/signup-cookie";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 신규 가입 완료 — 동의(14세+약관+방침) 후 member_accounts 생성 + 익명 데이터 이전.
 * 가드: 세션 authed·비익명·deleted 아님. **중복호출 안전**(이미 member면 no-op). 마이그는 신규 row일 때만.
 */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  if (user.is_anonymous) return NextResponse.json({ error: "member_only" }, { status: 403 });

  const admin = createAdminClient();
  const { data: prof } = await admin
    .from("profiles")
    .select("deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if ((prof as { deleted_at?: string | null } | null)?.deleted_at) {
    return NextResponse.json({ error: "account_deleted" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as {
    age?: boolean;
    terms?: boolean;
    privacy?: boolean;
  };
  if (!body.age || !body.terms || !body.privacy) {
    return NextResponse.json({ error: "consent_required" }, { status: 400 });
  }

  const clearCookie = (res: NextResponse) => {
    res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
    return res;
  };

  const now = new Date().toISOString();
  const [bonus, termsDoc, privacyDoc] = await Promise.all([
    getGrowthLevers().then((g) => g.signupBonusCredits).catch(() => 0),
    getCurrentLegal("terms").catch(() => null),
    getCurrentLegal("privacy").catch(() => null),
  ]);

  // 멱등 insert — 신규 row 일 때만 반환(이미 member면 빈 배열 → no-op).
  const { data: rows, error: insErr } = await admin
    .from("member_accounts")
    .upsert(
      {
        user_id: user.id,
        gen_credits: bonus,
        age_confirmed_at: now,
        terms_agreed_at: now,
        privacy_agreed_at: now,
        terms_version: termsDoc?.version ?? null,
        privacy_version: privacyDoc?.version ?? null,
      },
      { onConflict: "user_id", ignoreDuplicates: true }
    )
    .select("user_id");
  if (insErr) {
    log.error("account.onboard_insert_fail", { userId: user.id, ...errInfo(insErr) });
    return NextResponse.json({ error: "onboard_failed" }, { status: 500 });
  }
  const isNew = (rows?.length ?? 0) > 0;

  if (!isNew) {
    // 이미 회원 — 재이전·중복 크레딧 없이 종료.
    log.info("account.onboard_noop_existing", { userId: user.id });
    return clearCookie(NextResponse.json({ ok: true }));
  }

  // 신규 — 프로필(OAuth 닉/프사) 설정.
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
    log.warn("account.onboard_profile_fail", { userId: user.id, ...errInfo(e) });
  }

  // 익명 데이터 이전 — 서명 쿠키 검증 + 안전 검사 통과 시에만.
  const anonId = verifyMigrateValue(req.cookies.get(MIGRATE_COOKIE)?.value);
  if (anonId && anonId !== user.id) {
    try {
      const { data: anonUser } = await admin.auth.admin.getUserById(anonId);
      const isAnon = anonUser?.user?.is_anonymous === true;
      const { data: anonMember } = await admin
        .from("member_accounts")
        .select("user_id")
        .eq("user_id", anonId)
        .maybeSingle();
      if (isAnon && !anonMember) {
        // 익명에 있으면 안 되는 데이터(이상) — 이동·삭제 스킵 + 경고(수동 검토).
        const [d, o, g] = await Promise.all([
          admin.from("dolls").select("id", { head: true, count: "exact" }).eq("owner_id", anonId),
          admin.from("payapp_orders").select("order_uuid", { head: true, count: "exact" }).eq("user_id", anonId),
          admin.from("ai_generations").select("id", { head: true, count: "exact" }).eq("owner_id", anonId),
        ]);
        const unexpected = (d.count ?? 0) + (o.count ?? 0) + (g.count ?? 0);
        if (unexpected > 0) {
          log.warn("account.onboard_anon_unexpected", {
            anonId,
            dolls: d.count,
            orders: o.count,
            gens: g.count,
          });
        } else {
          const { error: rErr } = await admin.rpc("reassign_anon_data", {
            p_old: anonId,
            p_new: user.id,
          });
          if (rErr) {
            log.error("account.reassign_fail", { anonId, userId: user.id, ...errInfo(rErr) });
          } else {
            // best-effort 익명 정리 — 실패해도 가입 성공.
            try {
              await admin.auth.admin.deleteUser(anonId);
            } catch (e) {
              log.warn("account.anon_delete_fail", { anonId, ...errInfo(e) });
            }
          }
        }
      }
    } catch (e) {
      log.warn("account.onboard_migrate_fail", { anonId, ...errInfo(e) });
    }
  }

  log.info("account.onboard_success", { userId: user.id });
  return clearCookie(NextResponse.json({ ok: true }));
}
