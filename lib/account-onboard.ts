import "server-only";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import {
  extractOAuthProfile,
  type OAuthProfile,
} from "@/lib/oauth-metadata";
import { verifyMigrateValue } from "@/lib/signup-cookie";
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
// 이전은 strict member no-row 신규 후보의 동의 INSERT 전에만 호출(I4 보수적 — 기존 회원은 자동 병합 안 함).

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
): Promise<void> {
  const mutation = await requireSupabaseSuccess("onboard.profile_sync", () =>
    admin.rpc("sync_active_member_oauth_profile", {
      p_user_id: userId,
      p_display_name: profile.displayName,
      p_avatar_url: profile.avatarUrl,
      p_email: profile.email,
    }),
  );
  if (!isExactOAuthProfileSyncAck(mutation.data)) {
    throw new SupabaseOperationError(
      "onboard.profile_sync",
      new Error("invalid_oauth_profile_sync_ack"),
    );
  }

  const [profileRead, memberRead] = await Promise.all([
    requireSupabaseSuccess("onboard.profile_sync.profile_verify", () =>
      admin
        .from("profiles")
        .select("id, deleted_at, display_name, avatar_url")
        .eq("id", userId)
        .maybeSingle(),
    ),
    requireSupabaseSuccess("onboard.profile_sync.member_verify", () =>
      admin
        .from("member_accounts")
        .select("user_id, email")
        .eq("user_id", userId)
        .maybeSingle(),
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

/**
 * 익명→신규회원 데이터 이전 — 서명 쿠키 검증 + 안전검사 통과 시에만.
 * 반환: `migrated`(이전함) / `skipped`(쿠키없음·invalid·대상아님·이상데이터·이전불필요 → 재시도 무의미) /
 *       `failed`(권한·조회·count·reassign·삭제 에러 — 호출부가 MIGRATE_COOKIE 유지·재시도).
 * 호출부가 쿠키 정책을 결정한다.
 */
export async function migrateAnonData(
  admin: SupabaseClient,
  cookieValue: string | undefined,
  userId: string,
): Promise<MigrateResult> {
  const anonId = verifyMigrateValue(cookieValue);
  if (!anonId || anonId === userId) return "skipped";

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
        const result = await admin.rpc("reassign_anon_data", {
          p_old: anonId,
          p_new: userId,
        });
        return { data: result.data, error: result.error };
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
      signedSourceCookieVerified: true,
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
      log.warn("onboard.anon_unexpected", {
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
