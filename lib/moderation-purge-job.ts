import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  removeModerationPurgeTargets,
  type ModerationPurgeTarget,
} from "@/lib/moderation-purge";
import {
  isCanonicalStoragePath,
  requireSupabaseData,
  requireSupabaseRows,
  requireSupabaseSuccess,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { isUuid } from "@/lib/upload-write-safety";

type AdminClient = ReturnType<typeof createAdminClient>;

export type ModerationPurgeStart = {
  alreadyPurged: boolean;
  jobId: string | null;
};

export type ModerationPurgeStatus = {
  jobId: string;
  dollId: string;
  status: "pending" | "leased" | "completed";
  attemptCount: number;
};

export type ModerationPurgeLease = {
  jobId: string;
  dollId: string;
  targets: ModerationPurgeTarget[];
  leaseToken: string;
  leaseVersion: number;
  attemptCount: number;
};

async function verifyModerationPurgeLeaseTargets(
  admin: AdminClient,
  lease: ModerationPurgeLease,
): Promise<void> {
  const doll = await requireSupabaseData<{
    id: string;
    owner_id: string;
    image_url: string | null;
    deleted_at: string | null;
  } | null>("moderation.purge.doll_verify", () =>
    admin
      .from("dolls")
      .select("id, owner_id, image_url, deleted_at")
      .eq("id", lease.dollId)
      .maybeSingle(),
  );
  if (
    !doll ||
    doll.id !== lease.dollId ||
    !isUuid(doll.owner_id) ||
    typeof doll.deleted_at !== "string"
  ) {
    throw new Error("moderation purge doll lifecycle mismatch");
  }

  const expectedDollPath = `${doll.owner_id}/${lease.dollId}.png`;
  if (
    lease.targets.some(
      (target) =>
        target.bucket === "dolls" && target.path !== expectedDollPath,
    )
  ) {
    throw new Error("moderation purge doll storage ownership mismatch");
  }

  const scoreIds = [
    ...new Set(
      lease.targets
        .filter((target) => target.bucket === "highlights")
        .map((target) => target.path.split("/", 1)[0]),
    ),
  ];
  if (scoreIds.length === 0) return;
  const rows = (await requireSupabaseRows(
    "moderation.purge.target_owners",
    () =>
      admin
        .from("scores")
        .select("id, doll_id")
        .in("id", scoreIds),
  )) as Array<{ id: unknown; doll_id: unknown }>;
  const owned = new Set(
    rows
      .filter(
        (row) =>
          isUuid(row.id) &&
          isUuid(row.doll_id) &&
          row.doll_id === lease.dollId,
      )
      .map((row) => row.id as string),
  );
  if (
    owned.size !== scoreIds.length ||
    scoreIds.some((scoreId) => !owned.has(scoreId))
  ) {
    throw new Error("moderation purge manifest ownership mismatch");
  }
}

export type ModerationPurgeOutcome =
  | { kind: "idle" }
  | { kind: "completed"; jobId: string; attemptCount: number }
  | {
      kind: "pending";
      jobId: string;
      attemptCount: number;
      failure: string;
      retryRecorded: boolean;
    };

export function moderationPurgeHttpStatus(
  outcome: ModerationPurgeOutcome,
  authoritativeStatus: ModerationPurgeStatus | null,
): 200 | 202 {
  return outcome.kind === "completed" ||
    (outcome.kind === "idle" && authoritativeStatus?.status === "completed")
    ? 200
    : 202;
}

export type ModerationPurgeDrainResult = {
  claimed: number;
  completed: number;
  pending: number;
  claimErrors: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid moderation purge RPC response");
  }
  return value as Record<string, unknown>;
}

export function parseModerationPurgeStart(value: unknown): ModerationPurgeStart {
  const row = record(value);
  if (row.ok !== true || typeof row.already_purged !== "boolean") {
    throw new Error("invalid moderation purge start");
  }
  if (row.already_purged === true) {
    if (row.job_id !== null) {
      throw new Error("invalid completed moderation purge start");
    }
    return { alreadyPurged: true, jobId: null };
  }
  if (!isUuid(row.job_id)) {
    throw new Error("invalid moderation purge job id");
  }
  return { alreadyPurged: false, jobId: row.job_id };
}

export function parseModerationPurgeStatus(
  value: unknown,
  expectedJobId: string,
  expectedDollId: string,
): ModerationPurgeStatus {
  const row = record(value);
  if (
    row.ok !== true ||
    !isUuid(row.job_id) ||
    row.job_id.toLowerCase() !== expectedJobId.toLowerCase() ||
    !isUuid(row.doll_id) ||
    row.doll_id.toLowerCase() !== expectedDollId.toLowerCase() ||
    (row.status !== "pending" &&
      row.status !== "leased" &&
      row.status !== "completed") ||
    !Number.isSafeInteger(row.attempt_count) ||
    (row.attempt_count as number) < 0
  ) {
    throw new Error("invalid moderation purge status");
  }
  return {
    jobId: row.job_id.toLowerCase(),
    dollId: row.doll_id.toLowerCase(),
    status: row.status,
    attemptCount: row.attempt_count as number,
  };
}

function parseTargets(
  value: unknown,
  dollId: string,
): ModerationPurgeTarget[] {
  if (!Array.isArray(value)) {
    throw new Error("invalid moderation purge manifest");
  }
  if (value.length > 100) {
    throw new Error("moderation purge manifest too large");
  }
  const targets = value.map((item) => {
    const target = record(item);
    if (
      (target.bucket !== "dolls" && target.bucket !== "highlights") ||
      typeof target.path !== "string" ||
      !isCanonicalStoragePath(target.path)
    ) {
      throw new Error("invalid moderation purge target");
    }
    const segments = target.path.split("/");
    if (
      (target.bucket === "dolls"
        ? segments.length !== 2 ||
          !isUuid(segments[0]) ||
          segments[1] !== `${dollId}.png`
        : segments.length < 2 || !isUuid(segments[0]))
    ) {
      throw new Error("invalid moderation purge target correlation");
    }
    return { bucket: target.bucket, path: target.path } as ModerationPurgeTarget;
  });
  const keys = targets.map((target) => `${target.bucket}/${target.path}`);
  if (new Set(keys).size !== keys.length) {
    throw new Error("duplicate moderation purge target");
  }
  return targets;
}

export function parseModerationPurgeLease(
  value: unknown,
): ModerationPurgeLease | null {
  if (value === null) return null;
  const row = record(value);
  if (
    !isUuid(row.job_id) ||
    !isUuid(row.doll_id) ||
    !isUuid(row.lease_token) ||
    !Number.isSafeInteger(row.lease_version) ||
    (row.lease_version as number) < 1 ||
    !Number.isSafeInteger(row.attempt_count) ||
    (row.attempt_count as number) < 1
  ) {
    throw new Error("invalid moderation purge lease");
  }
  return {
    jobId: row.job_id,
    dollId: row.doll_id,
    targets: parseTargets(row.manifest, row.doll_id),
    leaseToken: row.lease_token,
    leaseVersion: row.lease_version as number,
    attemptCount: row.attempt_count as number,
  };
}

async function finish(
  admin: AdminClient,
  lease: ModerationPurgeLease,
  success: boolean,
  error: string | null,
): Promise<
  | "completed"
  | "pending"
  | "pending_batch"
  | "pending_target_remains"
  | "pending_final_sweep"
  | "pending_intent_drain"
> {
  const result = await requireSupabaseSuccess("moderation.purge.finish", () =>
    admin.rpc("finish_moderation_purge_v2", {
      p_job_id: lease.jobId,
      p_lease_token: lease.leaseToken,
      p_lease_version: lease.leaseVersion,
      p_success: success,
      p_error: error,
    }),
  );
  const row = record(result.data);
  const status = row.status;
  if (
    row.ok !== true ||
    row.job_id !== lease.jobId ||
    row.doll_id !== lease.dollId ||
    row.lease_token !== lease.leaseToken ||
    row.lease_version !== lease.leaseVersion ||
    ![
      "completed",
      "pending",
      "pending_batch",
      "pending_target_remains",
      "pending_final_sweep",
      "pending_intent_drain",
    ].includes(String(status)) ||
    (success ? status === "pending" : status !== "pending")
  ) {
    throw new Error("invalid moderation purge finish status");
  }
  return status as
    | "completed"
    | "pending"
    | "pending_batch"
    | "pending_target_remains"
    | "pending_final_sweep"
    | "pending_intent_drain";
}

export async function processModerationPurgeJob(
  admin: AdminClient,
  jobId?: string,
): Promise<ModerationPurgeOutcome> {
  const claim = await requireSupabaseSuccess("moderation.purge.claim", () =>
    admin.rpc("claim_moderation_purge_v2", {
      p_job_id: jobId ?? null,
      p_lease_seconds: 120,
      p_target_limit: 100,
    }),
  );
  const lease = parseModerationPurgeLease(claim.data);
  if (!lease) return { kind: "idle" };
  if (jobId && lease.jobId !== jobId) {
    throw new Error("moderation purge job mismatch");
  }

  try {
    await verifyModerationPurgeLeaseTargets(admin, lease);
  } catch {
    const failure = "purge_manifest_verification_failed";
    try {
      await finish(admin, lease, false, failure);
      return {
        kind: "pending",
        jobId: lease.jobId,
        attemptCount: lease.attemptCount,
        failure,
        retryRecorded: true,
      };
    } catch {
      return {
        kind: "pending",
        jobId: lease.jobId,
        attemptCount: lease.attemptCount,
        failure,
        retryRecorded: false,
      };
    }
  }

  const failed = await removeModerationPurgeTargets(lease.targets, {
    remove: (bucket, paths) => admin.storage.from(bucket).remove(paths),
    exists: (bucket, path) => admin.storage.from(bucket).exists(path),
  });
  if (failed.length > 0) {
    const failure = `storage_remove_failed:${failed
      .map((target) => `${target.bucket}/${target.path}`)
      .join(",")
      .slice(0, 900)}`;
    try {
      await finish(admin, lease, false, failure);
      return {
        kind: "pending",
        jobId: lease.jobId,
        attemptCount: lease.attemptCount,
        failure,
        retryRecorded: true,
      };
    } catch {
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
    const status = await finish(admin, lease, true, null);
    if (status === "completed") {
      return {
        kind: "completed",
        jobId: lease.jobId,
        attemptCount: lease.attemptCount,
      };
    }
    return {
      kind: "pending",
      jobId: lease.jobId,
      attemptCount: lease.attemptCount,
      failure:
        status === "pending_target_remains"
          ? "storage_object_still_present"
          : status === "pending_final_sweep"
            ? "signed_upload_final_sweep_wait"
            : status === "pending_intent_drain"
              ? "storage_upload_intent_drain_wait"
              : "purge_more_targets",
      retryRecorded: true,
    };
  } catch {
    return {
      kind: "pending",
      jobId: lease.jobId,
      attemptCount: lease.attemptCount,
      failure: "moderation.purge.finish",
      retryRecorded: false,
    };
  }
}

export async function drainModerationPurgeJobs(
  admin: AdminClient,
  limit = 10,
): Promise<ModerationPurgeDrainResult> {
  const result: ModerationPurgeDrainResult = {
    claimed: 0,
    completed: 0,
    pending: 0,
    claimErrors: 0,
  };
  const bounded = Math.max(1, Math.min(Math.trunc(limit), 50));
  for (let index = 0; index < bounded; index += 1) {
    let outcome: ModerationPurgeOutcome;
    try {
      outcome = await processModerationPurgeJob(admin);
    } catch (error) {
      result.claimErrors += 1;
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
