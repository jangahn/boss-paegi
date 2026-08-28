import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  extractOAuthProfile,
  type OAuthProfile,
} from "@/lib/oauth-metadata";
import { log, errInfo } from "@/lib/log";
import { deleteAuthUserAcceptingMissing } from "@/lib/anon-data-migration";
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
 *
 * 0103: 여기서 프로필(닉네임·프사)은 덮어쓰지 않는다 — 마이페이지 커스터마이징이
 * 재로그인마다 OAuth 값으로 초기화되던 결함의 수정. RPC 는 email 만 동기화하고,
 * 탈퇴 스크럽 플레이스홀더('탈퇴한 사용자')가 남은 재활성 계정만 OAuth 로 재시드한다.
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

/**
 * 익명→신규회원 데이터 이전 — OAuth flow ledger 권위(0093~0095) 전용.
 * pre-ledger 3-part HMAC 쿠키 경로는 v1.03 에서 제거 — 15분 쿠키 TTL 드레인 완료 후
 * 프로덕션 legacy 영수증 0건(한 번도 실행되지 않음)을 확인하고 소멸시켰다.
 * 반환: `migrated`(이전함) / `skipped`(권위없음·이전불필요 → 재시도 무의미) /
 *       `failed`(권한·reassign·삭제 에러 — 호출부가 재시도 경로 유지).
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
): Promise<MigrateResult> {
  if (authority === null) {
    return "skipped";
  }
  const anonId = authority.sourceUserId;
  if (anonId === userId) {
    return "failed";
  }

  // A flow receipt is the serializable policy boundary and must be consumed
  // before any eventually-consistent member/Auth pre-read. In particular,
  // transfer + consent can commit while the HTTP ACK is lost; a retry may
  // already observe the target member. Replaying the durable receipt first
  // prevents that member row from being misclassified as a new no-transfer
  // decision.
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
    const deleted = await deleteAuthUserAcceptingMissing(admin, anonId);
    if (!deleted.ok) {
      throw deleted.error;
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
