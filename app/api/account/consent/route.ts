import { NextRequest, NextResponse } from "next/server";
import { requireAuthedNonDeleted, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGrowthLeversStrict } from "@/lib/config/getters";
import { getCurrentLegalVersionsStrict } from "@/lib/legal/strict-versions";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import { loadOAuthProfile, migrateAnonData } from "@/lib/account-onboard";
import { resolveSignupBonusStrict } from "@/lib/signup-bonus";
import { MIGRATE_COOKIE } from "@/lib/signup-cookie";
import {
  displayedLegalVersionsMatch,
  prepareAnonMigration,
  resolveDbRead,
  resolveRequiredDbRead,
} from "@/lib/auth-read-policy";
import {
  runConsentOnboardMutation,
  syncLegacyOAuthProfileStrict,
} from "@/lib/consent-onboard-mutation";
import { recordConversion, memberStateFromUser } from "@/lib/analytics/server";
import type { RawSource } from "@/lib/analytics/core";
import { publicWriteActorKey } from "@/lib/public-write-quota";
import { log, errInfo } from "@/lib/log";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";

export const runtime = "nodejs";

const clearCookie = (res: NextResponse) => {
  res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
  return res;
};

/**
 * 동의 완료 + (콜백이 회원 생성 못 했을 때) **INSERT 복구**(I3). 보통은 콜백이 로그인 시 회원을 만들고
 * 여기선 UPDATE(stamp)만 하지만, row 없으면 INSERT(보너스·시드·익명이전 신규 1회).
 * 경량 가드(I6) → I5 재산출 → RPC insert/update(I7: 버전 null 항목은 미요구·미stamp).
 * 신규 후보의 익명이전은 INSERT 전에 수행해 transient 실패 시 row를 만들지 않는다.
 * MIGRATE_COOKIE: 이전+INSERT 성공/이미완료=clear, 조회·이전·RPC 실패=유지(재시도).
 */
export async function POST(req: NextRequest) {
  const gate = await requireAuthedNonDeleted();
  if (!gate.ok) return memberGateResponse(gate); // 쿠키 유지(비터미널)
  const user = gate.user;
  const admin = createAdminClient();

  // I5: 서버가 현재 상태로 필요 항목 재산출(클라가 보낸 items 신뢰 금지).
  let memberResult;
  try {
    memberResult = await admin
      .from("member_accounts")
      .select("age_confirmed_at, terms_version, privacy_version")
      .eq("user_id", user.id)
      .maybeSingle();
  } catch (error) {
    log.error("account.consent_read_fail", {
      userId: user.id,
      source: "member",
      ...errInfo(error),
    });
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
  const memberRead = resolveDbRead("member", memberResult);
  if (!memberRead.ok) {
    log.error("account.consent_read_fail", {
      userId: user.id,
      source: memberRead.source,
      ...errInfo(memberRead.error),
    });
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
  const member = (memberRead.data as ConsentMember) ?? null;

  let curr;
  try {
    curr = await getCurrentLegalVersionsStrict();
  } catch (error) {
    log.error("account.consent_read_fail", {
      userId: user.id,
      source: "legal",
      ...errInfo(error),
    });
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }
  const required = missingConsentItems(member, curr);

  // Legacy rollout fallback can commit consent before its strict profile sync.
  // Parse the body and run the sync even when a retry now observes no missing
  // consent items; an early success here would permanently hide that partial
  // commit and clear MIGRATE_COOKIE.
  const requestBody = await readApiJsonObjectRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as {
    age?: boolean;
    terms?: boolean;
    privacy?: boolean;
    termsVersion?: unknown;
    privacyVersion?: unknown;
    /** 방문→가입 전환 분석 — first-touch source(있을 때만 적재). */
    acqSource?: unknown;
  };
  if (
    required.length > 0 &&
    !required.every((item) => body[item] === true)
  ) {
    return NextResponse.json({ error: "consent_required" }, { status: 400 });
  }
  if (
    !displayedLegalVersionsMatch(required, curr, {
      terms: body.termsVersion,
      privacy: body.privacyVersion,
    })
  ) {
    return NextResponse.json(
      { error: "legal_version_changed" },
      { status: 409 },
    );
  }

  // Resolve every value needed by the atomic member transaction before moving
  // anonymous data or mutating membership state.
  const profile = await loadOAuthProfile(admin, user);
  if (!profile.email || !profile.emailVerified) {
    return NextResponse.json({ error: "email_required" }, { status: 403 });
  }
  let bonus = 0;
  if (member === null) {
    const provider = (user.app_metadata as { provider?: string } | null)?.provider;
    try {
      bonus = await resolveSignupBonusStrict(
        provider,
        getGrowthLeversStrict,
      );
    } catch (error) {
      log.error("account.consent_growth_config_fail", {
        userId: user.id,
        ...errInfo(error),
      });
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    }
  }

  // strict no-row인 신규 후보만 익명이전. INSERT 전에 끝내야 실패 시 member row가 생기지 않아
  // 보존된 MIGRATE_COOKIE로 재POST가 실제 이전을 다시 시도한다. 기존 member 재로그인은 호출 안 함(I4).
  const migration = await prepareAnonMigration(member, () =>
    migrateAnonData(admin, req.cookies.get(MIGRATE_COOKIE)?.value, user.id)
  );
  if (!migration.ok) {
    log.error("account.consent_migrate_retry", {
      userId: user.id,
      ...errInfo(migration.error),
    });
    return NextResponse.json({ error: "migration_failed" }, { status: 503 });
  }

  const atomicArgs = {
    p_user_id: user.id,
    p_bonus: bonus,
    p_set_age: required.includes("age"),
    p_set_terms: required.includes("terms"),
    p_terms_ver: curr.terms,
    p_set_privacy: required.includes("privacy"),
    p_privacy_ver: curr.privacy,
    p_display_name: profile.displayName,
    p_avatar_url: profile.avatarUrl,
    p_email: profile.email,
  };
  const legacyArgs = {
    p_user_id: atomicArgs.p_user_id,
    p_bonus: atomicArgs.p_bonus,
    p_set_age: atomicArgs.p_set_age,
    p_set_terms: atomicArgs.p_set_terms,
    p_terms_ver: atomicArgs.p_terms_ver,
    p_set_privacy: atomicArgs.p_set_privacy,
    p_privacy_ver: atomicArgs.p_privacy_ver,
  };
  const profileSelect = "id, deleted_at, display_name, avatar_url";
  const memberEmailSelect = "user_id, email";
  const expectedProfile = {
    displayName: profile.displayName,
    avatarUrl: profile.avatarUrl,
    email: profile.email,
  };

  // I7: use the atomic consent+OAuth seed RPC whenever available. During an
  // app-first rollout, only its exact PGRST202 missing-function error may use
  // the legacy consent RPC. Legacy success remains non-terminal until guarded
  // profile/email writes and fresh consent/lifecycle postconditions pass.
  const mutation = await runConsentOnboardMutation({
    atomic: () =>
      admin.rpc("create_or_update_member_consent_with_profile", atomicArgs),
    legacy: () =>
      admin.rpc("create_or_update_member_consent", legacyArgs),
    syncLegacyProfile: () => {
      const profilePatch: Record<string, string> = {};
      if (profile.displayName !== null) {
        profilePatch.display_name = profile.displayName;
      }
      if (profile.avatarUrl !== null) {
        profilePatch.avatar_url = profile.avatarUrl;
      }
      return syncLegacyOAuthProfileStrict(
        {
          writeActiveProfile: () =>
            Object.keys(profilePatch).length > 0
              ? admin
                  .from("profiles")
                  .update(profilePatch)
                  .eq("id", user.id)
                  .is("deleted_at", null)
                  .select(profileSelect)
                  .maybeSingle()
              : admin
                  .from("profiles")
                  .select(profileSelect)
                  .eq("id", user.id)
                  .is("deleted_at", null)
                  .maybeSingle(),
          writeMemberEmail: () =>
            admin
              .from("member_accounts")
              .update({ email: profile.email })
              .eq("user_id", user.id)
              .select(memberEmailSelect)
              .maybeSingle(),
          readProfile: () =>
            admin
              .from("profiles")
              .select(profileSelect)
              .eq("id", user.id)
              .maybeSingle(),
          readMemberEmail: () =>
            admin
              .from("member_accounts")
              .select(memberEmailSelect)
              .eq("user_id", user.id)
              .maybeSingle(),
          scrubMemberEmail: () =>
            admin
              .from("member_accounts")
              .update({ email: null })
              .eq("user_id", user.id)
              .select(memberEmailSelect)
              .maybeSingle(),
        },
        user.id,
        expectedProfile,
      );
    },
    verifyLegacyCommit: async () => {
      // Profile first, member second: if deletion commits before either read it
      // is observed; if it commits after the successful linearization point,
      // the deletion transaction scrubs the already-written OAuth values.
      let profileResult;
      try {
        profileResult = await admin
          .from("profiles")
          .select(profileSelect)
          .eq("id", user.id)
          .maybeSingle();
      } catch (error) {
        throw error;
      }
      const profileRead = resolveRequiredDbRead("profile", profileResult);
      if (!profileRead.ok) throw profileRead.error;
      const profileAfter = profileRead.data as {
        id: string;
        deleted_at: string | null;
        display_name: string | null;
        avatar_url: string | null;
      };
      if (
        profileAfter.id !== user.id ||
        profileAfter.deleted_at !== null
      ) {
        throw new Error("invalid_account");
      }
      if (
        profile.displayName !== null &&
        profileAfter.display_name !== profile.displayName
      ) {
        throw new Error("legacy_profile_display_name_mismatch");
      }
      if (
        profile.avatarUrl !== null &&
        profileAfter.avatar_url !== profile.avatarUrl
      ) {
        throw new Error("legacy_profile_avatar_url_mismatch");
      }

      let memberAfterResult;
      try {
        memberAfterResult = await admin
          .from("member_accounts")
          .select(
            "user_id, email, age_confirmed_at, terms_version, privacy_version",
          )
          .eq("user_id", user.id)
          .maybeSingle();
      } catch (error) {
        throw error;
      }
      const memberAfterRead = resolveRequiredDbRead(
        "member",
        memberAfterResult,
      );
      if (!memberAfterRead.ok) throw memberAfterRead.error;
      const memberAfter = memberAfterRead.data as {
        user_id: string;
        email: string | null;
        age_confirmed_at: string | null;
        terms_version: number | null;
        privacy_version: number | null;
      };
      if (
        memberAfter.user_id !== user.id ||
        memberAfter.email !== profile.email
      ) {
        throw new Error("legacy_member_email_mismatch");
      }

      const currAfter = await getCurrentLegalVersionsStrict();
      const stillMissing = missingConsentItems(memberAfter, currAfter);
      if (stillMissing.length > 0) {
        const legalChanged =
          currAfter.terms !== curr.terms ||
          currAfter.privacy !== curr.privacy;
        throw new Error(
          legalChanged
            ? "legal_version_changed"
            : "legacy_consent_postcondition_failed",
        );
      }
    },
  });
  if (!mutation.ok) {
    // INSERT/UPDATE 실패(미생성) — MIGRATE_COOKIE **유지**(다음 재시도에 익명이전 보존, I4).
    log.error("account.consent_rpc_fail", {
      userId: user.id,
      phase: mutation.phase,
      legacyCommitted: mutation.legacyCommitted,
      ...errInfo(mutation.error),
    });
    const message =
      mutation.error &&
      typeof mutation.error === "object" &&
      "message" in mutation.error &&
      typeof mutation.error.message === "string"
        ? mutation.error.message
        : "";
    const deleted = message.includes("invalid_account");
    const versionChanged =
      message.includes("legal_version_changed");
    return NextResponse.json(
      {
        error: deleted
          ? "account_deleted"
          : versionChanged
            ? "legal_version_changed"
            : "consent_failed",
      },
      { status: deleted ? 403 : versionChanged ? 409 : 500 },
    );
  }

  // OAuth profile/email seed is inside the same RPC transaction. Only the
  // nonessential conversion observation remains post-commit.
  if (mutation.isNew) {
    // 방문→가입 전환(분석, best-effort) — 신규 회원 1회. acqSource 있을 때만(분석 off 면 미적재).
    if (body.acqSource) {
      const actorKey = publicWriteActorKey(req.headers, user.id, true);
      if (actorKey) {
        await recordConversion(
          "signup",
          body.acqSource as RawSource,
          memberStateFromUser(user),
          actorKey,
        );
      }
    }
  }

  log.info("account.consent_success", {
    userId: user.id,
    isNew: mutation.isNew,
    mutationMode: mutation.mode,
    anonMigration: migration.result,
  });
  return clearCookie(NextResponse.json({ ok: true })); // 성공 → clear
}
