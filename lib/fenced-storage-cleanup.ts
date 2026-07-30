import {
  removeStorageObjects,
  SupabaseOperationError,
  type StorageExistsResult,
  type StorageRemoveResult,
} from "./supabase-operation.ts";

export type FencedStorageLease = {
  jobId: string;
  bucket: string;
  path: string;
  leaseToken: string;
  leaseVersion: number;
  attemptCount: number;
};

export type FencedStorageCleanupDependencies = {
  remove: (
    bucket: string,
    paths: string[],
  ) => PromiseLike<StorageRemoveResult>;
  exists: (
    bucket: string,
    path: string,
  ) => PromiseLike<StorageExistsResult>;
  finish: (
    lease: FencedStorageLease,
    success: boolean,
    error: string | null,
  ) => PromiseLike<"completed" | "cleaned" | "pending">;
};

export type FencedStorageCleanupOutcome =
  | {
      kind: "completed";
      jobId: string;
      attemptCount: number;
    }
  | {
      kind: "pending";
      jobId: string;
      attemptCount: number;
      failure: string;
      retryRecorded: boolean;
    };

function failureName(error: unknown): string {
  if (
    error instanceof SupabaseOperationError &&
    error.operationError instanceof Error &&
    error.operationError.name
  ) {
    return error.operationError.name;
  }
  if (error instanceof Error && error.name) return error.name;
  return "storage_cleanup_failed";
}

/**
 * A single-object cleanup lease runner. Storage deletion is idempotent; a
 * failed finish leaves the lease durable so a later lease/version can retry.
 * Resolved `{ error }` responses are failures just like thrown exceptions.
 */
export async function runFencedStorageCleanup(
  lease: FencedStorageLease,
  dependencies: FencedStorageCleanupDependencies,
): Promise<FencedStorageCleanupOutcome> {
  let failure: string | null = null;
  try {
    await removeStorageObjects(
      "storage_cleanup.object_remove",
      [lease.path],
      (paths) => dependencies.remove(lease.bucket, paths),
      (path) => dependencies.exists(lease.bucket, path),
    );
  } catch (error) {
    failure = failureName(error);
  }

  if (failure) {
    try {
      await dependencies.finish(lease, false, failure);
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
    const status = await dependencies.finish(lease, true, null);
    if (status !== "completed" && status !== "cleaned") {
      return {
        kind: "pending",
        jobId: lease.jobId,
        attemptCount: lease.attemptCount,
        failure: "cleanup_finish_not_terminal",
        retryRecorded: true,
      };
    }
    return {
      kind: "completed",
      jobId: lease.jobId,
      attemptCount: lease.attemptCount,
    };
  } catch {
    return {
      kind: "pending",
      jobId: lease.jobId,
      attemptCount: lease.attemptCount,
      failure: "cleanup_finish_failed",
      retryRecorded: false,
    };
  }
}
