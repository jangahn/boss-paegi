import { isUuid } from "./upload-write-safety.ts";

export type StorageCleanupStatus =
  | "pending"
  | "leased"
  | "completed"
  | "canceled";

export type DetachedStorageMutationAck = {
  jobId: string | null;
  cleanupStatus: StorageCleanupStatus;
};

export type DollDeleteAck = DetachedStorageMutationAck & {
  alreadyDeleted: boolean;
};

export type DollDeleteHttpAck =
  | { ok: true; cleanup: "completed" }
  | { accepted: true; cleanup: "pending" };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

function cleanupFields(
  value: Record<string, unknown>,
): DetachedStorageMutationAck | null {
  const jobId = value.job_id;
  const cleanupStatus = value.cleanup_status;
  if (
    (jobId !== null && !isUuid(jobId)) ||
    (cleanupStatus !== "pending" &&
      cleanupStatus !== "leased" &&
      cleanupStatus !== "completed" &&
      cleanupStatus !== "canceled") ||
    (jobId === null && cleanupStatus !== "completed")
  ) {
    return null;
  }
  return { jobId, cleanupStatus };
}

/** Exact acknowledgement shared by avatar clear/replace. */
export function parseDetachedStorageMutationAck(
  value: unknown,
): DetachedStorageMutationAck | null {
  const row = record(value);
  if (
    !row ||
    !hasExactKeys(row, ["ok", "job_id", "cleanup_status"]) ||
    row.ok !== true
  ) {
    return null;
  }
  return cleanupFields(row);
}

/** Exact, retry-safe acknowledgement from request_doll_delete. */
export function parseDollDeleteAck(value: unknown): DollDeleteAck | null {
  const row = record(value);
  if (
    !row ||
    !hasExactKeys(row, [
      "ok",
      "already_deleted",
      "job_id",
      "cleanup_status",
    ]) ||
    row.ok !== true ||
    typeof row.already_deleted !== "boolean"
  ) {
    return null;
  }
  const cleanup = cleanupFields(row);
  if (!cleanup || (row.already_deleted && cleanup.jobId === null)) {
    return null;
  }
  return {
    ...cleanup,
    alreadyDeleted: row.already_deleted,
  };
}

/** Exact browser acknowledgement after the doll row is durably gone. */
export function parseDollDeleteHttpAck(
  value: unknown,
): DollDeleteHttpAck | null {
  const row = record(value);
  if (!row) return null;
  if (
    hasExactKeys(row, ["ok", "cleanup"]) &&
    row.ok === true &&
    row.cleanup === "completed"
  ) {
    return { ok: true, cleanup: "completed" };
  }
  if (
    hasExactKeys(row, ["accepted", "cleanup"]) &&
    row.accepted === true &&
    row.cleanup === "pending"
  ) {
    return { accepted: true, cleanup: "pending" };
  }
  return null;
}

/** Role mutation is committed only by an exact echoed role. */
export function parseDollRoleUpdateAck(
  value: unknown,
  expectedRole: string,
): boolean {
  const row = record(value);
  return (
    !!row &&
    hasExactKeys(row, ["ok", "role"]) &&
    row.ok === true &&
    row.role === expectedRole
  );
}

export function isCleanupTerminal(status: StorageCleanupStatus): boolean {
  return status === "completed" || status === "canceled";
}

/** A completed response-loss receipt must not be claimed again (claim returns idle). */
export function cleanupJobToRun(
  acknowledgement: DetachedStorageMutationAck,
): string | null {
  return acknowledgement.jobId &&
    !isCleanupTerminal(acknowledgement.cleanupStatus)
    ? acknowledgement.jobId
    : null;
}
