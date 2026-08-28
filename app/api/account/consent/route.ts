import { createHash } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { requireAuthedNonDeleted, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGrowthLeversStrict } from "@/lib/config/getters";
import { missingConsentItems, type ConsentMember } from "@/lib/consent";
import { loadOAuthProfile, migrateAnonData } from "@/lib/account-onboard";
import { resolveSignupBonusStrict } from "@/lib/signup-bonus";
import {
  MIGRATE_COOKIE,
  migrateCookieName,
} from "@/lib/signup-cookie";
import { isOAuthFlowId } from "@/lib/oauth-flow-lease";
import {
  readSupabaseSessionCookieHeader,
} from "@/lib/supabase/session-cookie";
import { PUBLIC_ENV } from "@/lib/env";
import {
  prepareAnonMigration,
  resolveConsentMutation,
  resolveDbRead,
} from "@/lib/auth-read-policy";
import { recordConversion, memberStateFromUser } from "@/lib/analytics/server";
import type { RawSource } from "@/lib/analytics/core";
import { publicWriteActorKey } from "@/lib/public-write-quota";
import { log, errInfo } from "@/lib/log";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import {
  parseOAuthFlowDiscoveredAuthority,
  parseOAuthFlowDiscoveryAbsent,
  parseOAuthFlowRecoveredAuthority,
} from "@/lib/oauth-flow-status";

// The contract drain persists and verifies this exact provider execution
// bound. Keeping it explicit prevents a platform-default change from silently
// invalidating the 300 + 900 + 300 + 5 rollout proof.
export const maxDuration = 300;

export const runtime = "nodejs";

function tokenDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const clearCookie = (
  res: NextResponse,
  migrationFlow: string | null,
) => {
  res.cookies.set(MIGRATE_COOKIE, "", { maxAge: 0, path: "/" });
  if (migrationFlow) {
    res.cookies.set(migrateCookieName(migrationFlow), "", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 0,
      path: "/",
    });
  }
  return res;
};

/**
 * 동의 완료 + (콜백이 회원 생성 못 했을 때) **INSERT 복구**(I3). 보통은 콜백이 로그인 시 회원을 만들고
 * 여기선 UPDATE(stamp)만 하지만, row 없으면 INSERT(보너스·시드·익명이전 신규 1회).
 * 경량 가드(I6) → I5 재산출 → RPC insert/update(I7: 버전 null 항목은 미요구·미stamp).
 * 신규 후보의 익명이전 또는 기존회원 no-transfer receipt를 회원 mutation 전에
 * 확정해 transient 실패 시 flow와 member 상태가 갈라지지 않게 한다.
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
      .select("age_confirmed_at, terms_agreed_at, privacy_agreed_at")
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

  const required = missingConsentItems(member);

  // 재시도에서 required 가 비어도 body(migrationFlow)를 계속 파싱한다 —
  // 미완료 익명 이전을 idempotent 폼 재제출로 수렴시키는 경로(I4).
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
    migrationFlow?: unknown;
    /** 방문→가입 전환 분석 — first-touch source(있을 때만 적재). */
    acqSource?: unknown;
  };
  const hasMigrationFlow = Object.prototype.hasOwnProperty.call(
    body,
    "migrationFlow",
  );
  const migrationFlow =
    typeof body.migrationFlow === "string" &&
    isOAuthFlowId(body.migrationFlow)
      ? body.migrationFlow
      : null;
  if (hasMigrationFlow && migrationFlow === null) {
    return NextResponse.json(
      { error: "migration_flow_invalid" },
      { status: 400 },
    );
  }
  if (
    required.length > 0 &&
    !required.every((item) => body[item] === true)
  ) {
    return NextResponse.json({ error: "consent_required" }, { status: 400 });
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

  // The target session is the durable authority even when a second tab strips
  // migrationFlow from the URL/body. An explicit flow is recovered by its
  // exact session binding first; otherwise discover the sole matching flow.
  // This lets duplicate released receipts converge one at a time without ever
  // guessing when every hint is absent.
  let resolvedMigrationFlow = migrationFlow;
  let migrationAuthority: {
    flowId: string;
    sourceUserId: string;
    targetSessionId: string;
    targetAccessTokenSha256: string;
    targetRefreshTokenSha256: string;
  } | null = null;
  const targetSession = await readSupabaseSessionCookieHeader(
    req.headers.get("cookie"),
    PUBLIC_ENV.SUPABASE_URL,
  );
  if (
    targetSession.kind !== "present" ||
    targetSession.session.userId !== user.id
  ) {
    return NextResponse.json(
      { error: "migration_flow_conflict" },
      { status: 409 },
    );
  }

  let recovered:
    ReturnType<typeof parseOAuthFlowRecoveredAuthority> = null;
  if (migrationFlow === null) {
    try {
      const discoveredResult = await admin.rpc(
        "recover_active_oauth_flow_by_observed_session",
        {
          p_observed_user_id: user.id,
          p_observed_session_id:
            targetSession.session.sessionId,
        },
      );
      if (discoveredResult.error) throw discoveredResult.error;
      const discovered = parseOAuthFlowDiscoveredAuthority(
        discoveredResult.data,
      );
      const discoveryAbsent = parseOAuthFlowDiscoveryAbsent(
        discoveredResult.data,
      );
      if (!discovered && !discoveryAbsent) {
        return NextResponse.json(
          { error: "migration_flow_conflict" },
          { status: 409 },
        );
      }
      if (discovered) {
        resolvedMigrationFlow = discovered.status.flowId;
        recovered = discovered;
      }
    } catch (error) {
      log.error("account.consent_migration_discovery_fail", {
        flowId: migrationFlow,
        userId: user.id,
        ...errInfo(error),
      });
      return NextResponse.json(
        { error: "service_unavailable" },
        { status: 503 },
      );
    }
  }

  if (resolvedMigrationFlow !== null) {
    if (recovered === null) {
      try {
        const result = await admin.rpc(
          "recover_oauth_flow_intent_authority",
          {
            p_flow_id: resolvedMigrationFlow,
            p_observed_user_id: user.id,
            p_observed_session_id:
              targetSession.session.sessionId,
          },
        );
        if (result.error) throw result.error;
        recovered = parseOAuthFlowRecoveredAuthority(
          result.data,
          resolvedMigrationFlow,
        );
      } catch (error) {
        log.error("account.consent_migration_authority_fail", {
          flowId: resolvedMigrationFlow,
          userId: user.id,
          ...errInfo(error),
        });
        return NextResponse.json(
          { error: "service_unavailable" },
          { status: 503 },
        );
      }
    }
    if (
      !recovered ||
      recovered.status.state !== "completed" ||
      recovered.status.action !== "continue" ||
      recovered.status.releasedAt === null ||
      recovered.status.revokeConfirmedAt !== null ||
      !recovered.status.sourceIsAnonymous ||
      recovered.status.targetUserId !== user.id ||
      (
        recovered.status.targetSessionId !==
          targetSession.session.sessionId &&
        recovered.status.migrationConsumedAt === null
      ) ||
      recovered.status.targetSessionId === null ||
      recovered.sourceUserId === user.id
    ) {
      return NextResponse.json(
        { error: "migration_flow_conflict" },
        { status: 409 },
      );
    }
    migrationAuthority = {
      flowId: resolvedMigrationFlow,
      sourceUserId: recovered.sourceUserId,
      targetSessionId: recovered.status.targetSessionId,
      targetAccessTokenSha256: tokenDigest(
        targetSession.session.accessToken,
      ),
      targetRefreshTokenSha256: tokenDigest(
        targetSession.session.refreshToken,
      ),
    };
  }
  const migration = await prepareAnonMigration(member, () =>
    migrateAnonData(
      admin,
      user.id,
      migrationAuthority,
    ),
    migrationAuthority !== null,
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
    p_set_privacy: required.includes("privacy"),
    p_display_name: profile.displayName,
    p_avatar_url: profile.avatarUrl,
    p_email: profile.email,
  };

  // 버전 무관 원자 동의+OAuth 시드 RPC(0106). expand-first 적용이라 legacy
  // fallback 없이 단일 경로다. 실패 시 MIGRATE_COOKIE 유지(다음 재시도에 익명이전 보존, I4).
  const mutation = await resolveConsentMutation(() =>
    admin.rpc("create_or_update_member_consent_with_profile", atomicArgs),
  );
  if (!mutation.ok) {
    log.error("account.consent_rpc_fail", {
      userId: user.id,
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
    return NextResponse.json(
      { error: deleted ? "account_deleted" : "consent_failed" },
      { status: deleted ? 403 : 500 },
    );
  }
  const isNew = mutation.isNew;

  // OAuth profile/email seed is inside the same RPC transaction. Only the
  // nonessential conversion observation remains post-commit.
  if (isNew) {
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
    isNew,
    anonMigration: migration.result,
  });
  return clearCookie(
    NextResponse.json({ ok: true }),
    resolvedMigrationFlow,
  ); // 성공 → exact flow-scoped proof clear
}
