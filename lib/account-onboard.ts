import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  extractOAuthProfile,
  type OAuthProfile,
} from "@/lib/oauth-metadata";
import { verifyLegacyMigrateValue } from "@/lib/signup-cookie";
import { log, errInfo } from "@/lib/log";
import {
  isMissingAuthUserError,
  runAnonDataMigration,
} from "@/lib/anon-data-migration";
import {
  requireSupabaseSuccess,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import {
  isExactOAuthProfileSyncAck,
  matchesOAuthProfileSyncPostcondition,
} from "@/lib/oauth-profile-sync-result";

// 신규 회원 생성 시 부수효과(프로필 시드 + 익명데이터 이전) — 콜백(로그인 시 생성)·consent API(복구) 공용.
// 실제 이전은 strict member no-row에서만 허용하고, 기존회원 경합은 flow-scoped no-transfer receipt만 기록한다.

/** 관리자 Auth 조회를 우선하되 검증된 세션 metadata를 장애 시 fallback으로 사용한다. */
export async function loadOAuthProfile(
  admin: SupabaseClient,
  user: User,
): Promise<OAuthProfile> {
  let sourceUser = user;
  try {
    const full = await requireSupabaseSuccess("onboard.auth_user_read", () =>
      admin.auth.admin.getUserById(user.id),
    );
    sourceUser = full.data.user ?? user;
  } catch (e) {
    // 세션의 검증된 user metadata로 계속 시도하되, resolved `{ error }`도 관측한다.
    log.warn("onboard.auth_user_read_fail", {
      userId: user.id,
      ...errInfo(e),
    });
  }

  return extractOAuthProfile(sourceUser);
}

/**
 * Existing-member OAuth sync. The DB RPC locks profile -> member and rejects a
 * deleted account, so a delayed callback cannot repopulate scrubbed PII.
 * Failure is intentionally thrown: callers must not redirect as success.
 */
export async function seedOAuthProfile(
  admin: SupabaseClient,
  user: User,
): Promise<void> {
  const profile = await loadOAuthProfile(admin, user);
  await syncOAuthProfile(admin, user.id, profile);
}

export async function syncOAuthProfile(
  admin: SupabaseClient,
  userId: string,
  profile: OAuthProfile,
  signal?: AbortSignal,
): Promise<void> {
  const mutationQuery = admin.rpc(
    "sync_active_member_oauth_profile",
    {
      p_user_id: userId,
      p_display_name: profile.displayName,
      p_avatar_url: profile.avatarUrl,
      p_email: profile.email,
    },
  );
  const mutation = await requireSupabaseSuccess("onboard.profile_sync", () =>
    signal
      ? mutationQuery.abortSignal(signal)
      : mutationQuery,
  );
  if (!isExactOAuthProfileSyncAck(mutation.data)) {
    throw new SupabaseOperationError(
      "onboard.profile_sync",
      new Error("invalid_oauth_profile_sync_ack"),
    );
  }

  let profileQuery = admin
    .from("profiles")
    .select("id, deleted_at, display_name, avatar_url")
    .eq("id", userId);
  let memberQuery = admin
    .from("member_accounts")
    .select("user_id, email")
    .eq("user_id", userId);
  if (signal) {
    profileQuery = profileQuery.abortSignal(signal);
    memberQuery = memberQuery.abortSignal(signal);
  }
  const [profileRead, memberRead] = await Promise.all([
    requireSupabaseSuccess(
      "onboard.profile_sync.profile_verify",
      () => profileQuery.maybeSingle(),
    ),
    requireSupabaseSuccess(
      "onboard.profile_sync.member_verify",
      () => memberQuery.maybeSingle(),
    ),
  ]);
  if (
    !matchesOAuthProfileSyncPostcondition(
      profileRead.data,
      memberRead.data,
      {
        userId,
        displayName: profile.displayName,
        avatarUrl: profile.avatarUrl,
        email: profile.email,
      },
    )
  ) {
    throw new SupabaseOperationError(
      "onboard.profile_sync.verify",
      new Error("oauth_profile_sync_postcondition_failed"),
    );
  }
}

export type MigrateResult = "migrated" | "skipped" | "failed";

const MIGRATION_SKIP_REASON = {
  source_not_anonymous: "source_not_anonymous",
  source_generation_changed: "source_generation_changed",
  source_is_member: "source_is_member",
  target_is_member: "target_already_member",
  target_already_claimed: "target_already_claimed",
  source_already_claimed: "source_already_claimed",
  source_already_absent: "source_already_absent",
  target_withdrawn: "target_withdrawn",
  recovery_expired: "recovery_expired",
  unexpected_data: "unexpected_source_data",
} as const;

type MigrationSkipReceiptReason =
  (typeof MIGRATION_SKIP_REASON)[keyof typeof MIGRATION_SKIP_REASON];

function parseMigrationResult(
  value: unknown,
): {
  migrationResult: Record<string, unknown>;
  skipReason: MigrationSkipReceiptReason | null;
} | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const migrationResult = value as Record<string, unknown>;
  const resultKeys = Object.keys(migrationResult);
  if (
    resultKeys.length === 2 &&
    resultKeys.includes("ok") &&
    resultKeys.includes("skipped") &&
    migrationResult.ok === true &&
    Object.values(MIGRATION_SKIP_REASON).includes(
      migrationResult.skipped as MigrationSkipReceiptReason,
    )
  ) {
    return {
      migrationResult,
      skipReason:
        migrationResult.skipped as MigrationSkipReceiptReason,
    };
  }
  if (
    resultKeys.length === 4 &&
    ["ok", "scores", "badges", "telemetry"].every((key) =>
      resultKeys.includes(key)
    ) &&
    migrationResult.ok === true &&
    ["scores", "badges", "telemetry"].every((key) => {
      const count = migrationResult[key];
      return (
        typeof count === "number" &&
        Number.isInteger(count) &&
        count >= 0 &&
        count <= 2_147_483_647
      );
    })
  ) {
    return { migrationResult, skipReason: null };
  }
  return null;
}

function parseOAuthMigrationReceipt(
  value: unknown,
  expectedFlowId: string,
): {
  migrationResult: Record<string, unknown>;
  skipReason: MigrationSkipReceiptReason | null;
} | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const receipt = value as Record<string, unknown>;
  const receiptKeys = Object.keys(receipt);
  if (
    receiptKeys.length !== 5 ||
    ![
      "ok",
      "flowId",
      "alreadyConsumed",
      "migrationConsumedAt",
      "migrationResult",
    ].every((key) => receiptKeys.includes(key)) ||
    receipt.ok !== true ||
    receipt.flowId !== expectedFlowId ||
    typeof receipt.alreadyConsumed !== "boolean" ||
    typeof receipt.migrationConsumedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.migrationConsumedAt)) ||
    receipt.migrationResult === null ||
    typeof receipt.migrationResult !== "object" ||
    Array.isArray(receipt.migrationResult)
  ) {
    return null;
  }
  return parseMigrationResult(receipt.migrationResult);
}

function parseLegacyMigrationReceipt(
  value: unknown,
  expectedSourceUserId: string,
  expectedTargetUserId: string,
  expectedTargetSessionId: string,
): {
  migrationResult: Record<string, unknown>;
  skipReason: MigrationSkipReceiptReason | null;
} | null {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return null;
  }
  const receipt = value as Record<string, unknown>;
  const receiptKeys = Object.keys(receipt);
  if (
    receiptKeys.length !== 7 ||
    ![
      "ok",
      "sourceUserId",
      "targetUserId",
      "targetSessionId",
      "alreadyConsumed",
      "consumedAt",
      "migrationResult",
    ].every((key) => receiptKeys.includes(key)) ||
    receipt.ok !== true ||
    receipt.sourceUserId !== expectedSourceUserId ||
    receipt.targetUserId !== expectedTargetUserId ||
    receipt.targetSessionId !== expectedTargetSessionId ||
    typeof receipt.alreadyConsumed !== "boolean" ||
    typeof receipt.consumedAt !== "string" ||
    !Number.isFinite(Date.parse(receipt.consumedAt))
  ) {
    return null;
  }
  return parseMigrationResult(receipt.migrationResult);
}

/**
 * 익명→신규회원 데이터 이전 — 서명 쿠키 검증 + 안전검사 통과 시에만.
 * 반환: `migrated`(이전함) / `skipped`(쿠키없음·invalid·대상아님·이상데이터·이전불필요 → 재시도 무의미) /
 *       `failed`(권한·조회·count·reassign·삭제 에러 — 호출부가 MIGRATE_COOKIE 유지·재시도).
 * 호출부가 쿠키 정책을 결정한다.
 */
export async function migrateAnonData(
  admin: SupabaseClient,
  userId: string,
  authority: {
    flowId: string;
    sourceUserId: string;
    targetSessionId: string;
    targetAccessTokenSha256: string;
    targetRefreshTokenSha256: string;
  } | null,
  legacyCookieValue?: string,
  legacyTargetSessionId?: string,
): Promise<MigrateResult> {
  // Expand/contract compatibility: a browser served by the pre-ledger app can
  // still hold the old three-part HMAC capability. It is accepted only when
  // the current target session proves that no flow authority exists. 0094
  // revokes the raw primitive only after the cookie TTL plus the maximum old
  // invocation lifetime has drained.
  const legacyCapability =
    authority === null &&
    typeof legacyTargetSessionId === "string"
      ? verifyLegacyMigrateValue(legacyCookieValue)
      : null;
  if (authority === null && legacyCapability === null) {
    return "skipped";
  }
  const anonId =
    authority?.sourceUserId ??
    legacyCapability?.sourceUserId ??
    null;
  if (anonId === null) return "skipped";
  if (anonId === userId) {
    return authority === null ? "skipped" : "failed";
  }

  // A flow receipt is the serializable policy boundary and must be consumed
  // before any eventually-consistent member/Auth pre-read. In particular,
  // transfer + consent can commit while the HTTP ACK is lost; a retry may
  // already observe the target member. Replaying the durable receipt first
  // prevents that member row from being misclassified as a new no-transfer
  // decision.
  if (authority !== null) {
    let result: Awaited<ReturnType<typeof admin.rpc>>;
    try {
      result = await admin.rpc(
        "consume_oauth_flow_intent_migration",
        {
          p_flow_id: authority.flowId,
          p_target_user_id: userId,
          p_target_session_id: authority.targetSessionId,
          p_source_user_id: anonId,
          p_access_token_sha256:
            authority.targetAccessTokenSha256,
          p_refresh_token_sha256:
            authority.targetRefreshTokenSha256,
        },
      );
    } catch (error) {
      log.error("onboard.migrate_operation_fail", {
        anonId,
        userId,
        operation: "data.reassign",
        ...errInfo(error),
      });
      return "failed";
    }
    const receipt = parseOAuthMigrationReceipt(
      result.data,
      authority.flowId,
    );
    if (result.error !== null || receipt === null) {
      log.error("onboard.migrate_operation_fail", {
        anonId,
        userId,
        operation: "data.reassign",
        ...errInfo(
          result.error ??
            new Error(
              "oauth_flow_migration_receipt_invalid",
            ),
        ),
      });
      return "failed";
    }
    if (receipt.skipReason !== null) {
      return "skipped";
    }

    try {
      const deleted = await admin.auth.admin.deleteUser(anonId);
      if (
        !isMissingAuthUserError(deleted.error) &&
        (
          deleted.error !== null ||
          deleted.data.user?.id !== anonId
        )
      ) {
        throw deleted.error ??
          new Error("delete_result_invalid");
      }
    } catch (error) {
      log.error("onboard.migrate_operation_fail", {
        anonId,
        userId,
        operation: "auth.delete_user",
        ...errInfo(error),
      });
      return "failed";
    }
    return "migrated";
  }

  const outcome = await runAnonDataMigration(
    {
      getTargetUser: async () => {
        const result = await admin.auth.admin.getUserById(userId);
        return {
          data: result.data.user
            ? {
                userId: result.data.user.id,
                isAnonymous: result.data.user.is_anonymous === true,
              }
            : null,
          error: result.error,
        };
      },
      getTargetMember: async () => {
        const result = await admin
          .from("member_accounts")
          .select("user_id")
          .eq("user_id", userId)
          .maybeSingle();
        const row = result.data as { user_id: string } | null;
        return {
          data: row ? { userId: row.user_id } : null,
          error: result.error,
        };
      },
      getAnonUser: async () => {
        const result = await admin.auth.admin.getUserById(anonId);
        if (isMissingAuthUserError(result.error)) {
          return { data: null, error: null };
        }
        return {
          data: result.data.user
            ? { isAnonymous: result.data.user.is_anonymous === true }
            : null,
          error: result.error,
        };
      },
      getAnonMember: async () => {
        const result = await admin
          .from("member_accounts")
          .select("user_id")
          .eq("user_id", anonId)
          .maybeSingle();
        const row = result.data as { user_id: string } | null;
        return {
          data: row ? { userId: row.user_id } : null,
          error: result.error,
        };
      },
      countDolls: async () => {
        const result = await admin
          .from("dolls")
          .select("id", { head: true, count: "exact" })
          .eq("owner_id", anonId);
        return { count: result.count, error: result.error };
      },
      countOrders: async () => {
        const result = await admin
          .from("orders")
          .select("order_uuid", { head: true, count: "exact" })
          .eq("user_id", anonId);
        return { count: result.count, error: result.error };
      },
      countGenerations: async () => {
        const result = await admin
          .from("ai_generations")
          .select("id", { head: true, count: "exact" })
          .eq("owner_id", anonId);
        return { count: result.count, error: result.error };
      },
      reassign: async () => {
        if (
          legacyCapability === null ||
          typeof legacyTargetSessionId !== "string"
        ) {
          return {
            data: null,
            error: new Error(
              "legacy_migration_authority_missing",
            ),
          };
        }
        const result = await admin.rpc(
          "consume_legacy_signup_migration",
          {
            p_source_user_id: anonId,
            p_target_user_id: userId,
            p_target_session_id:
              legacyTargetSessionId,
            p_issued_at: new Date(
              legacyCapability.issuedAtMs,
            ).toISOString(),
            p_expires_at: new Date(
              legacyCapability.expiresAtMs,
            ).toISOString(),
          },
        );
        const receipt = parseLegacyMigrationReceipt(
          result.data,
          anonId,
          userId,
          legacyTargetSessionId,
        );
        return {
          data: receipt
            ? receipt.migrationResult
            : null,
          error:
            result.error ??
            (receipt
              ? null
              : new Error(
                  "legacy_migration_receipt_invalid",
                )),
        };
      },
      deleteAnonUser: async () => {
        const result = await admin.auth.admin.deleteUser(anonId);
        if (isMissingAuthUserError(result.error)) {
          return { deleted: true, error: null };
        }
        return {
          deleted: result.data.user?.id === anonId,
          error: result.error,
        };
      },
    },
    {
      sourceUserId: anonId,
      targetUserId: userId,
      sourceAuthorityVerified: true,
    },
  );

  if (outcome.result === "failed") {
    log.error("onboard.migrate_operation_fail", {
      anonId,
      userId,
      operation: outcome.operation,
      ...errInfo(outcome.error),
    });
    return "failed";
  }
  if (outcome.result === "skipped") {
    if (outcome.reason === "unexpected_data") {
      log.warn("onboard.legacy_anon_unexpected", {
        anonId,
        dolls: outcome.counts?.dolls,
        orders: outcome.counts?.orders,
        gens: outcome.counts?.generations,
      });
    }
    return "skipped";
  }
  return "migrated";
}
