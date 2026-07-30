import "server-only";

import { deletedEmailMarker } from "@/lib/oauth-metadata";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  AccountDeleteCleanupError,
  parseAccountDeletionCleanupManifest,
  removeAccountDeletionCleanupTargets,
  scrubDeletedAccountAuth,
  type AccountDeletionCleanupManifest,
  type AccountDeletionCleanupTarget,
} from "@/lib/account-delete-cleanup";
import {
  isCanonicalStoragePath,
  requireSupabaseRows,
  requireSupabaseSuccess,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { isUuid } from "@/lib/upload-write-safety";

type AdminClient = ReturnType<typeof createAdminClient>;

export type AccountDeletionStart = {
  jobId: string;
  userId: string;
  cleanupStatus: "pending" | "leased" | "completed";
  manifest: AccountDeletionCleanupManifest | null;
};

type CleanupLease = {
  jobId: string;
  userId: string;
  targets: AccountDeletionCleanupTarget[];
  generationIds: string[];
  leaseToken: string;
  leaseVersion: number;
  attemptCount: number;
  scrubAuth: boolean;
};

type CleanupFinishStatus =
  | "completed"
  | "pending"
  | "pending_batch"
  | "pending_target_remains"
  | "pending_final_sweep"
  | "pending_intent_drain"
  | "pending_generation_reconciliation"
  | "pending_auth_scrub";

export type AccountDeletionCleanupOutcome =
  | { kind: "idle" }
  | { kind: "completed"; jobId: string; attemptCount: number }
  | {
      kind: "pending";
      jobId: string;
      attemptCount: number;
      failure: string;
      retryRecorded: boolean;
    };

export type AccountDeletionCleanupDrainResult = {
  claimed: number;
  completed: number;
  pending: number;
  claimErrors: number;
};

function objectRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid account deletion cleanup RPC response");
  }
  return value as Record<string, unknown>;
}

export function parseAccountDeletionStart(
  value: unknown,
  expectedUserId: string,
): AccountDeletionStart {
  const row = objectRecord(value);
  const jobId = row.job_id;
  const userId = row.user_id;
  const cleanupStatus = row.cleanup_status;
  if (
    row.ok !== true ||
    !isUuid(jobId) ||
    !isUuid(userId) ||
    userId !== expectedUserId ||
    !["pending", "leased", "completed"].includes(String(cleanupStatus))
  ) {
    throw new Error("invalid account deletion cleanup start");
  }
  return {
    jobId,
    userId,
    cleanupStatus: cleanupStatus as AccountDeletionStart["cleanupStatus"],
    manifest:
      cleanupStatus === "completed"
        ? null
        : parseAccountDeletionCleanupManifest(row.manifest, userId),
  };
}

export function parseAccountDeletionCleanupLease(
  value: unknown,
): CleanupLease | null {
  if (value === null) return null;
  const row = objectRecord(value);
  if (
    !isUuid(row.job_id) ||
    !isUuid(row.user_id) ||
    !isUuid(row.lease_token) ||
    !Number.isSafeInteger(row.lease_version) ||
    (row.lease_version as number) < 1 ||
    !Number.isSafeInteger(row.attempt_count) ||
    (row.attempt_count as number) < 1 ||
    typeof row.scrub_auth !== "boolean"
  ) {
    throw new Error("invalid account deletion cleanup lease");
  }
  return {
    jobId: row.job_id,
    userId: row.user_id,
    targets: parseCleanupTargets(row.targets, row.user_id),
    generationIds: parseGenerationIds(row.generation_ids),
    leaseToken: row.lease_token,
    leaseVersion: row.lease_version as number,
    attemptCount: row.attempt_count as number,
    scrubAuth: row.scrub_auth,
  };
}

function parseGenerationIds(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 100 ||
    value.some((generationId) => !isUuid(generationId))
  ) {
    throw new Error("invalid account cleanup generation targets");
  }
  const generationIds = value as string[];
  if (new Set(generationIds).size !== generationIds.length) {
    throw new Error("duplicate account cleanup generation target");
  }
  return generationIds;
}

function parseCleanupTargets(
  value: unknown,
  userId: string,
): AccountDeletionCleanupTarget[] {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error("invalid account cleanup targets");
  }
  const targets = value.map((item) => {
    const target = objectRecord(item);
    const bucket = target.bucket;
    const path = target.path;
    if (
      (bucket !== "dolls" &&
        bucket !== "highlights" &&
        bucket !== "avatars") ||
      typeof path !== "string" ||
      !isCanonicalStoragePath(path)
    ) {
      throw new Error("invalid account cleanup target");
    }
    if (
      bucket === "dolls" &&
      !path.startsWith(`${userId}/`) &&
      !path.startsWith(`tmp/face/${userId}/`)
    ) {
      throw new Error("invalid account cleanup doll target");
    }
    if (bucket === "avatars" && !path.startsWith(`${userId}/`)) {
      throw new Error("invalid account cleanup avatar target");
    }
    if (
      bucket === "highlights" &&
      (!path.includes("/") || !isUuid(path.split("/", 1)[0]))
    ) {
      throw new Error("invalid account cleanup highlight target");
    }
    return { bucket, path } as AccountDeletionCleanupTarget;
  });
  const keys = targets.map((target) => `${target.bucket}/${target.path}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("duplicate account cleanup target");
  }
  return targets;
}

function cleanupFailureCode(error: unknown): string {
  if (error instanceof AccountDeleteCleanupError) {
    return [...new Set(error.failures.map((failure) => failure.operation))].join(",");
  }
  if (error instanceof SupabaseOperationError) return error.operation;
  if (error instanceof Error) return error.name;
  return "unknown_cleanup_failure";
}

function sameManifest(
  left: AccountDeletionCleanupManifest,
  right: AccountDeletionCleanupManifest,
): boolean {
  const sorted = (values: readonly string[]) => [...values].sort();
  return (
    left.avatar === right.avatar &&
    JSON.stringify(sorted(left.dolls)) === JSON.stringify(sorted(right.dolls)) &&
    JSON.stringify(sorted(left.highlights)) ===
      JSON.stringify(sorted(right.highlights))
  );
}

async function finishCleanupJob(
  admin: AdminClient,
  lease: CleanupLease,
  success: boolean,
  error: string | null,
): Promise<CleanupFinishStatus> {
  const result = await requireSupabaseSuccess("account.cleanup.finish", () =>
    admin.rpc("finish_account_deletion_cleanup_v2", {
      p_job_id: lease.jobId,
      p_lease_token: lease.leaseToken,
      p_lease_version: lease.leaseVersion,
      p_success: success,
      p_error: error,
    }),
  );
  const row = objectRecord(result.data);
  const status = row.status;
  if (
    row.ok !== true ||
    row.job_id !== lease.jobId ||
    row.user_id !== lease.userId ||
    row.lease_token !== lease.leaseToken ||
    row.lease_version !== lease.leaseVersion ||
    ![
      "completed",
      "pending",
      "pending_batch",
      "pending_target_remains",
      "pending_final_sweep",
      "pending_intent_drain",
      "pending_generation_reconciliation",
      "pending_auth_scrub",
    ].includes(String(status))
  ) {
    throw new Error("invalid account cleanup finish status");
  }
  if (
    (success && status === "pending") ||
    (!success && status !== "pending")
  ) {
    throw new Error("account cleanup finish outcome mismatch");
  }
  return status as CleanupFinishStatus;
}

async function verifyAccountDeletionCleanupTargets(
  admin: AdminClient,
  lease: CleanupLease,
): Promise<void> {
  const scoreIds = [
    ...new Set(
      lease.targets
        .filter((target) => target.bucket === "highlights")
        .map((target) => target.path.split("/", 1)[0]),
    ),
  ];
  if (scoreIds.length === 0) return;
  const raw = await requireSupabaseRows(
    "account.cleanup.target_owners",
    () =>
      admin
        .from("scores")
        .select("id, owner_id")
        .in("id", scoreIds),
  );
  const rows = validateAdminRows<{ id: string; owner_id: string }>(
    "account.cleanup.target_owners",
    raw,
    { id: "uuid", owner_id: "uuid" },
  );
  const returned = new Set(
    rows
      .filter((row) => row.owner_id === lease.userId)
      .map((row) => row.id),
  );
  if (
    returned.size !== scoreIds.length ||
    scoreIds.some((scoreId) => !returned.has(scoreId))
  ) {
    throw new Error("account cleanup target ownership mismatch");
  }
}

async function armAccountDeletionAuthFence(
  admin: AdminClient,
  lease: CleanupLease,
): Promise<void> {
  const result = await requireSupabaseSuccess(
    "account.cleanup.auth.arm_fence",
    () =>
      admin.rpc("arm_account_deletion_cleanup_auth_fence", {
        p_job_id: lease.jobId,
        p_user_id: lease.userId,
        p_lease_token: lease.leaseToken,
        p_lease_version: lease.leaseVersion,
      }),
  );
  const row = objectRecord(result.data);
  if (
    row.ok !== true ||
    row.job_id !== lease.jobId ||
    row.user_id !== lease.userId ||
    row.lease_token !== lease.leaseToken ||
    row.lease_version !== lease.leaseVersion ||
    row.action !== "scrub"
  ) {
    throw new Error("invalid account cleanup Auth fence");
  }

  const observed = await requireSupabaseSuccess(
    "account.cleanup.auth.read_fence",
    () => admin.auth.admin.getUserById(lease.userId),
  );
  const user = observed.data?.user;
  const fence =
    user?.app_metadata?.bp_account_cleanup_fence as
      | Record<string, unknown>
      | undefined;
  if (
    !user ||
    user.id !== lease.userId ||
    !fence ||
    fence.job_id !== lease.jobId ||
    fence.user_id !== lease.userId ||
    fence.lease_token !== lease.leaseToken ||
    fence.lease_version !== lease.leaseVersion ||
    fence.action !== "scrub"
  ) {
    throw new Error("account cleanup Auth fence not observed");
  }
}

/**
 * 한 cleanup job을 lease로 claim해 실행한다. Storage/Auth 정리는 모두 멱등이며 finish RPC가
 * 실패해도 job은 leased 상태로 남아 lease 만료 후 재실행된다.
 */
export async function processAccountDeletionCleanupJob(
  admin: AdminClient,
  options: {
    jobId?: string;
    userId?: string;
    manifest?: AccountDeletionCleanupManifest;
  } = {},
): Promise<AccountDeletionCleanupOutcome> {
  const claim = await requireSupabaseSuccess("account.cleanup.claim", () =>
    admin.rpc("claim_account_deletion_cleanup_v2", {
      p_job_id: options.jobId ?? null,
      p_lease_seconds: 120,
      p_target_limit: 100,
    }),
  );
  const lease = parseAccountDeletionCleanupLease(claim.data);
  if (!lease) return { kind: "idle" };

  let failure: string | null = null;
  try {
    if (options.jobId && options.jobId !== lease.jobId) {
      throw new Error("cleanup job mismatch");
    }
    if (options.userId && options.userId !== lease.userId) {
      throw new Error("cleanup user mismatch");
    }
    if (
      options.manifest &&
      !sameManifest(options.manifest, {
        dolls: [],
        highlights: [],
        avatar: null,
      })
    ) {
      throw new Error("cleanup manifest mismatch");
    }
    await verifyAccountDeletionCleanupTargets(admin, lease);
    await removeAccountDeletionCleanupTargets(lease.targets, {
      remove: (bucket, paths) => admin.storage.from(bucket).remove(paths),
      exists: (bucket, path) => admin.storage.from(bucket).exists(path),
    });
    if (lease.scrubAuth) {
      await armAccountDeletionAuthFence(admin, lease);
      await scrubDeletedAccountAuth(lease.userId, {
        scrubAuth: (userMetadataKeys) =>
          admin.auth.admin.updateUserById(lease.userId, {
            email: deletedEmailMarker(lease.userId),
            user_metadata: Object.fromEntries(
              userMetadataKeys.map((key) => [key, null]),
            ),
          }),
        readAuth: () => admin.auth.admin.getUserById(lease.userId),
      });
    }
  } catch (error) {
    failure = cleanupFailureCode(error);
  }

  if (failure) {
    try {
      await finishCleanupJob(admin, lease, false, failure);
      return {
        kind: "pending",
        jobId: lease.jobId,
        attemptCount: lease.attemptCount,
        failure,
        retryRecorded: true,
      };
    } catch {
      // lease row는 그대로라 만료 뒤 claim 가능하다. 원래 cleanup 실패 코드를 유지한다.
      return {
        kind: "pending",
        jobId: lease.jobId,
        attemptCount: lease.attemptCount,
        failure,
        retryRecorded: false,
      };
    }
  }

  try {
    const finishStatus = await finishCleanupJob(admin, lease, true, null);
    if (finishStatus !== "completed") {
      const failureByStatus: Record<
        Exclude<CleanupFinishStatus, "completed" | "pending">,
        string
      > = {
        pending_batch: "account_cleanup_more_targets",
        pending_target_remains: "storage_object_still_present",
        pending_final_sweep: "signed_upload_final_sweep_wait",
        pending_intent_drain: "storage_upload_intent_drain_wait",
        pending_generation_reconciliation:
          "generation_cost_reconciliation_wait",
        pending_auth_scrub: "auth_scrub_required",
      };
      return {
        kind: "pending",
        jobId: lease.jobId,
        attemptCount: lease.attemptCount,
        failure:
          finishStatus === "pending"
            ? "account_cleanup_retry"
            : failureByStatus[finishStatus],
        retryRecorded: true,
      };
    }
    return {
      kind: "completed",
      jobId: lease.jobId,
      attemptCount: lease.attemptCount,
    };
  } catch {
    // 외부 정리는 성공했지만 완료 기록이 실패했다. 멱등 재실행으로 수렴한다.
    return {
      kind: "pending",
      jobId: lease.jobId,
      attemptCount: lease.attemptCount,
      failure: "account.cleanup.finish",
      retryRecorded: false,
    };
  }
}

export async function drainAccountDeletionCleanupJobs(
  admin: AdminClient,
  limit = 10,
): Promise<AccountDeletionCleanupDrainResult> {
  const result: AccountDeletionCleanupDrainResult = {
    claimed: 0,
    completed: 0,
    pending: 0,
    claimErrors: 0,
  };
  const boundedLimit = Math.max(1, Math.min(Math.trunc(limit), 50));

  for (let index = 0; index < boundedLimit; index += 1) {
    let outcome: AccountDeletionCleanupOutcome;
    try {
      outcome = await processAccountDeletionCleanupJob(admin);
    } catch (error) {
      result.claimErrors += 1;
      // A resolved, malformed claim response can arrive after the RPC
      // transaction leased the poison row. Continue so that lease makes the
      // next due row observable in this same invocation. A transport/RPC
      // failure has no such progress proof and is stopped to avoid hammering
      // the same unavailable dependency.
      if (error instanceof SupabaseOperationError) break;
      continue;
    }
    if (outcome.kind === "idle") break;
    result.claimed += 1;
    if (outcome.kind === "completed") result.completed += 1;
    else result.pending += 1;
  }
  return result;
}
