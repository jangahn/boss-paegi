import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  runFencedStorageCleanup,
  type FencedStorageCleanupOutcome,
  type FencedStorageLease,
} from "@/lib/fenced-storage-cleanup";
import {
  isCanonicalStoragePath,
  requireSupabaseSuccess,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import {
  isOwnedAvatarUploadPath,
  isUuid,
} from "@/lib/upload-write-safety";

type AdminClient = ReturnType<typeof createAdminClient>;

export type StorageCleanupDrainResult = {
  claimed: number;
  completed: number;
  pending: number;
  claimErrors: number;
};

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid storage cleanup RPC response");
  }
  return value as Record<string, unknown>;
}

function isUuidAssetPath(
  path: string,
  prefix: string,
  extensions: readonly string[],
): boolean {
  if (!isCanonicalStoragePath(path)) return false;
  const segments = path.split("/");
  if (segments.length !== 2 || segments[0] !== prefix) return false;
  const dot = segments[1].lastIndexOf(".");
  return (
    dot > 0 &&
    isUuid(segments[1].slice(0, dot)) &&
    extensions.includes(segments[1].slice(dot + 1))
  );
}

function validUploadLease(row: Record<string, unknown>): boolean {
  if (!isUuid(row.owner_user_id)) return false;
  const subjectId = row.subject_id;
  const purpose = row.purpose;
  const bucket = row.bucket;
  const path = row.path;
  if (typeof path !== "string" || !isCanonicalStoragePath(path)) return false;

  if (purpose === "site_asset_og" || purpose === "site_asset_logo") {
    const prefix = purpose === "site_asset_og" ? "og" : "logo";
    return (
      subjectId === null &&
      bucket === "site-assets" &&
      new RegExp(
        `^${prefix}/[0-9]{6}/[0-9a-f-]+\\.(png|jpg|webp)$`,
      ).test(path) &&
      isUuid(path.split("/")[2]?.split(".", 1)[0])
    );
  }
  if (purpose === "event_image") {
    const segments = path.split("/");
    const dot = segments[1]?.lastIndexOf(".") ?? -1;
    return (
      subjectId === null &&
      bucket === "events" &&
      segments.length === 2 &&
      /^[0-9]{6}$/.test(segments[0]) &&
      dot > 0 &&
      isUuid(segments[1].slice(0, dot)) &&
      ["png", "jpg", "webp", "gif"].includes(segments[1].slice(dot + 1))
    );
  }
  if (purpose === "avatar_upload") {
    return (
      subjectId === null &&
      bucket === "avatars" &&
      isOwnedAvatarUploadPath(path, row.owner_user_id)
    );
  }
  if (purpose === "highlight_upload") {
    return (
      isUuid(subjectId) &&
      bucket === "highlights" &&
      isUuidAssetPath(path, subjectId, ["mp4", "webm"])
    );
  }
  if (purpose === "doll_upload") {
    return (
      isUuid(subjectId) &&
      bucket === "dolls" &&
      path === `${row.owner_user_id}/${subjectId}.png`
    );
  }
  return false;
}

function validObjectLease(row: Record<string, unknown>): boolean {
  if (
    !isUuid(row.user_id) ||
    !isUuid(row.subject_id) ||
    typeof row.path !== "string" ||
    !isCanonicalStoragePath(row.path)
  ) {
    return false;
  }
  if (row.kind === "avatar_clear" || row.kind === "avatar_replace") {
    return (
      row.bucket === "avatars" &&
      row.subject_id === row.user_id &&
      isOwnedAvatarUploadPath(row.path, row.user_id)
    );
  }
  if (
    row.kind === "doll_delete" ||
    row.kind === "doll_create_compensation"
  ) {
    return (
      row.bucket === "dolls" &&
      row.path === `${row.user_id}/${row.subject_id}.png`
    );
  }
  if (row.kind === "highlight_expired") {
    return (
      row.bucket === "highlights" &&
      isUuidAssetPath(row.path, row.subject_id, ["mp4", "webm"])
    );
  }
  return false;
}

export function parseStorageCleanupLease(
  value: unknown,
  source: "upload" | "object",
): FencedStorageLease | null {
  if (value === null) return null;
  const row = record(value);
  if (
    !isUuid(row.job_id) ||
    typeof row.bucket !== "string" ||
    typeof row.path !== "string" ||
    !isCanonicalStoragePath(row.path) ||
    !isUuid(row.lease_token) ||
    !Number.isSafeInteger(row.lease_version) ||
    (row.lease_version as number) < 1 ||
    !Number.isSafeInteger(row.attempt_count) ||
    (row.attempt_count as number) < 1
  ) {
    throw new Error("invalid storage cleanup lease");
  }
  if (
    (source === "upload" && !validUploadLease(row)) ||
    (source === "object" && !validObjectLease(row))
  ) {
    throw new Error("invalid storage cleanup target correlation");
  }
  return {
    jobId: row.job_id,
    bucket: row.bucket,
    path: row.path,
    leaseToken: row.lease_token,
    leaseVersion: row.lease_version as number,
    attemptCount: row.attempt_count as number,
  };
}

async function finish(
  admin: AdminClient,
  rpc:
    | "finish_storage_upload_cleanup"
    | "finish_storage_object_cleanup",
  lease: FencedStorageLease,
  success: boolean,
  error: string | null,
): Promise<"completed" | "cleaned" | "pending"> {
  const result = await requireSupabaseSuccess(`storage_cleanup.${rpc}`, () =>
    admin.rpc(rpc, {
      p_job_id: lease.jobId,
      p_lease_token: lease.leaseToken,
      p_lease_version: lease.leaseVersion,
      p_success: success,
      p_error: error,
    }),
  );
  const row = record(result.data);
  const status = row.status;
  if (status !== "completed" && status !== "cleaned" && status !== "pending") {
    throw new Error("invalid storage cleanup finish status");
  }
  if (
    row.ok !== true ||
    row.job_id !== lease.jobId ||
    row.lease_token !== lease.leaseToken ||
    row.lease_version !== lease.leaseVersion
  ) {
    throw new Error("storage cleanup finish correlation mismatch");
  }
  const expectedStatus = success
    ? rpc === "finish_storage_upload_cleanup"
      ? "cleaned"
      : "completed"
    : "pending";
  if (status !== expectedStatus) {
    throw new Error("storage cleanup finish outcome mismatch");
  }
  return status;
}

async function runLease(
  admin: AdminClient,
  lease: FencedStorageLease,
  finishRpc:
    | "finish_storage_upload_cleanup"
    | "finish_storage_object_cleanup",
): Promise<FencedStorageCleanupOutcome> {
  return runFencedStorageCleanup(lease, {
    remove: (bucket, paths) => admin.storage.from(bucket).remove(paths),
    exists: (bucket, path) => admin.storage.from(bucket).exists(path),
    finish: (claimed, success, error) =>
      finish(admin, finishRpc, claimed, success, error),
  });
}

export async function processStorageObjectCleanupJob(
  admin: AdminClient,
  jobId?: string,
): Promise<FencedStorageCleanupOutcome | { kind: "idle" }> {
  const claim = await requireSupabaseSuccess("storage_cleanup.object.claim", () =>
    admin.rpc("claim_storage_object_cleanup", {
      p_job_id: jobId ?? null,
      p_lease_seconds: 120,
    }),
  );
  const lease = parseStorageCleanupLease(claim.data, "object");
  if (!lease) return { kind: "idle" };
  if (jobId && lease.jobId !== jobId) {
    throw new Error("storage cleanup job mismatch");
  }
  return runLease(admin, lease, "finish_storage_object_cleanup");
}

export async function processUploadCleanupJob(
  admin: AdminClient,
): Promise<FencedStorageCleanupOutcome | { kind: "idle" }> {
  const claim = await requireSupabaseSuccess("storage_cleanup.upload.claim", () =>
    admin.rpc("claim_storage_upload_cleanup", {
      p_lease_seconds: 120,
    }),
  );
  const lease = parseStorageCleanupLease(claim.data, "upload");
  if (!lease) return { kind: "idle" };
  return runLease(admin, lease, "finish_storage_upload_cleanup");
}

async function drain(
  limit: number,
  processOne: () => Promise<
    FencedStorageCleanupOutcome | { kind: "idle" }
  >,
): Promise<StorageCleanupDrainResult> {
  const result: StorageCleanupDrainResult = {
    claimed: 0,
    completed: 0,
    pending: 0,
    claimErrors: 0,
  };
  const bounded = Math.max(1, Math.min(Math.trunc(limit), 50));
  for (let index = 0; index < bounded; index += 1) {
    let outcome: FencedStorageCleanupOutcome | { kind: "idle" };
    try {
      outcome = await processOne();
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

export function drainStorageObjectCleanupJobs(
  admin: AdminClient,
  limit = 10,
): Promise<StorageCleanupDrainResult> {
  return drain(limit, () => processStorageObjectCleanupJob(admin));
}

export function drainUploadCleanupJobs(
  admin: AdminClient,
  limit = 10,
): Promise<StorageCleanupDrainResult> {
  return drain(limit, () => processUploadCleanupJob(admin));
}
