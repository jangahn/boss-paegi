import "server-only";

import { randomUUID } from "node:crypto";
import type { User } from "@supabase/supabase-js";
import type { createAdminClient } from "@/lib/supabase/admin";
import { isMissingAuthUserError } from "@/lib/anon-data-migration";

type AdminClient = ReturnType<typeof createAdminClient>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DEFAULT_LEASE_SECONDS = 20;
const MAX_DRAIN_LIMIT = 100;
const MAX_CLEANUP_ATTEMPT_COUNT = 2_147_483_647;

type CleanupLease = {
  cleanupId: string;
  sourceUserId: string;
  sourceAuthCreatedAt: string;
  leaseToken: string;
  leaseVersion: number;
  attemptCount: number;
};

type SourceVerification = "absent" | "deletable" | "protected";
type FinishStatus = "completed" | "protected" | "pending";

export type OAuthAnonAuthCleanupOutcome =
  | { kind: "idle"; pendingBacklog: number }
  | {
      kind: "completed" | "protected";
      cleanupId: string;
      sourceUserId: string;
      attemptCount: number;
    }
  | {
      kind: "pending";
      cleanupId: string;
      sourceUserId: string;
      attemptCount: number;
      failure: string;
      retryRecorded: boolean;
    }
  | {
      kind: "failed";
      cleanupId: string;
      sourceUserId: string;
      attemptCount: number;
      failure: "cleanup_attempt_limit_exhausted";
    };

export type OAuthAnonAuthCleanupDrainResult = {
  claimed: number;
  completed: number;
  protected: number;
  failed: number;
  pending: number;
  backlog: number;
  claimErrors: number;
};

type AuthRead =
  | { kind: "missing" }
  | { kind: "present"; user: User }
  | { kind: "unavailable" };

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid oauth anonymous Auth cleanup RPC response");
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return (
    actual.length === wanted.length &&
    actual.every((key, index) => key === wanted[index])
  );
}

function validInstant(value: unknown): value is string {
  return (
    typeof value === "string" &&
    parseIsoInstantNanoseconds(value) !== null
  );
}

function positiveSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 1;
}

function nonNegativeSafeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function parseCleanupIdle(value: unknown): number | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const row = value as Record<string, unknown>;
  if (
    exactKeys(row, ["ok", "idle", "pendingBacklog"]) &&
    row.ok === true &&
    row.idle === true &&
    nonNegativeSafeInteger(row.pendingBacklog)
  ) {
    return row.pendingBacklog;
  }
  return null;
}

export function parseOAuthAnonAuthCleanupLease(
  value: unknown,
): CleanupLease | null {
  if (value === null) return null;
  const row = record(value);
  if (
    !exactKeys(row, [
      "ok",
      "cleanupId",
      "sourceUserId",
      "sourceAuthCreatedAt",
      "leaseToken",
      "leaseVersion",
      "attemptCount",
    ]) ||
    row.ok !== true ||
    typeof row.cleanupId !== "string" ||
    !UUID_RE.test(row.cleanupId) ||
    typeof row.sourceUserId !== "string" ||
    !UUID_RE.test(row.sourceUserId) ||
    !validInstant(row.sourceAuthCreatedAt) ||
    typeof row.leaseToken !== "string" ||
    !UUID_RE.test(row.leaseToken) ||
    !positiveSafeInteger(row.leaseVersion) ||
    !positiveSafeInteger(row.attemptCount)
  ) {
    throw new Error("invalid oauth anonymous Auth cleanup lease");
  }
  return {
    cleanupId: row.cleanupId,
    sourceUserId: row.sourceUserId,
    sourceAuthCreatedAt: row.sourceAuthCreatedAt,
    leaseToken: row.leaseToken,
    leaseVersion: row.leaseVersion,
    attemptCount: row.attemptCount,
  };
}

function parseSourceVerification(
  value: unknown,
  lease: CleanupLease,
): SourceVerification {
  const row = record(value);
  if (
    !exactKeys(row, ["ok", "cleanupId", "state"]) ||
    row.ok !== true ||
    row.cleanupId !== lease.cleanupId ||
    (row.state !== "absent" &&
      row.state !== "deletable" &&
      row.state !== "protected")
  ) {
    throw new Error("invalid oauth anonymous Auth source verification");
  }
  return row.state;
}

function parseFinishStatus(
  value: unknown,
  lease: CleanupLease,
  expected: FinishStatus,
): FinishStatus {
  const row = record(value);
  if (
    !exactKeys(row, [
      "ok",
      "cleanupId",
      "status",
      "leaseVersion",
      "nextAttemptAt",
    ]) ||
    row.ok !== true ||
    row.cleanupId !== lease.cleanupId ||
    row.leaseVersion !== lease.leaseVersion ||
    !(
      row.status === expected &&
      (expected === "pending"
        ? validInstant(row.nextAttemptAt)
        : row.nextAttemptAt === null)
    ) &&
    !(
      expected === "pending" &&
      lease.attemptCount === MAX_CLEANUP_ATTEMPT_COUNT &&
      row.status === "protected" &&
      row.nextAttemptAt === null
    )
  ) {
    throw new Error("invalid oauth anonymous Auth cleanup finish");
  }
  return row.status as FinishStatus;
}

async function rpc(
  admin: AdminClient,
  operation: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const result = await admin.rpc(operation, args);
  if (result.error) throw result.error;
  return result.data;
}

async function readFreshAuthUser(
  admin: AdminClient,
  userId: string,
): Promise<AuthRead> {
  try {
    const result = await admin.auth.admin.getUserById(userId);
    if (isMissingAuthUserError(result.error)) {
      return { kind: "missing" };
    }
    if (result.error || !result.data?.user) {
      return { kind: "unavailable" };
    }
    const user = result.data.user;
    if (
      user.id !== userId ||
      typeof user.created_at !== "string" ||
      parseIsoInstantNanoseconds(user.created_at) === null
    ) {
      return { kind: "unavailable" };
    }
    return { kind: "present", user };
  } catch {
    return { kind: "unavailable" };
  }
}

async function verifySource(
  admin: AdminClient,
  lease: CleanupLease,
): Promise<SourceVerification> {
  const value = await rpc(
    admin,
    "verify_oauth_anon_auth_cleanup_source",
    {
      p_cleanup_id: lease.cleanupId,
      p_lease_token: lease.leaseToken,
      p_lease_version: lease.leaseVersion,
    },
  );
  return parseSourceVerification(value, lease);
}

async function finish(
  admin: AdminClient,
  lease: CleanupLease,
  outcome: FinishStatus,
  error: string | null,
): Promise<FinishStatus> {
  const value = await rpc(
    admin,
    "finish_oauth_anon_auth_cleanup",
    {
      p_cleanup_id: lease.cleanupId,
      p_lease_token: lease.leaseToken,
      p_lease_version: lease.leaseVersion,
      p_outcome: outcome,
      p_error: error,
    },
  );
  return parseFinishStatus(value, lease, outcome);
}

async function pending(
  admin: AdminClient,
  lease: CleanupLease,
  failure: string,
): Promise<OAuthAnonAuthCleanupOutcome> {
  try {
    const status = await finish(
      admin,
      lease,
      "pending",
      failure,
    );
    if (status === "protected") {
      return {
        kind: "failed",
        cleanupId: lease.cleanupId,
        sourceUserId: lease.sourceUserId,
        attemptCount: lease.attemptCount,
        failure: "cleanup_attempt_limit_exhausted",
      };
    }
    return {
      kind: "pending",
      cleanupId: lease.cleanupId,
      sourceUserId: lease.sourceUserId,
      attemptCount: lease.attemptCount,
      failure,
      retryRecorded: true,
    };
  } catch {
    return {
      kind: "pending",
      cleanupId: lease.cleanupId,
      sourceUserId: lease.sourceUserId,
      attemptCount: lease.attemptCount,
      failure,
      retryRecorded: false,
    };
  }
}

async function terminal(
  admin: AdminClient,
  lease: CleanupLease,
  outcome: "completed" | "protected",
): Promise<OAuthAnonAuthCleanupOutcome> {
  await finish(
    admin,
    lease,
    outcome,
    outcome === "protected" ? "source_generation_changed" : null,
  );
  return {
    kind: outcome,
    cleanupId: lease.cleanupId,
    sourceUserId: lease.sourceUserId,
    attemptCount: lease.attemptCount,
  };
}

/**
 * Parse an RFC 3339/ISO timestamp without dropping sub-millisecond precision.
 * PostgreSQL and GoTrue use different UTC suffixes (`+00:00` vs `Z`), so
 * string equality is not a generation fence.
 */
export function parseIsoInstantNanoseconds(value: string): string | null {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
      value,
    );
  if (!match) return null;
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText = "",
    ,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);
  const offsetHour = offsetHourText ? Number(offsetHourText) : 0;
  const offsetMinute = offsetMinuteText ? Number(offsetMinuteText) : 0;
  if (
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > 31 ||
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    offsetHour > 23 ||
    offsetMinute > 59
  ) {
    return null;
  }
  // Date.UTC treats years 0..99 as 1900..1999. Seed then set the full year so
  // every four-digit RFC 3339 year is parsed without that legacy coercion.
  const local = new Date(0);
  local.setUTCFullYear(year, month - 1, day);
  local.setUTCHours(hour, minute, second, 0);
  const localMilliseconds = local.getTime();
  if (
    local.getUTCFullYear() !== year ||
    local.getUTCMonth() !== month - 1 ||
    local.getUTCDate() !== day ||
    local.getUTCHours() !== hour ||
    local.getUTCMinutes() !== minute ||
    local.getUTCSeconds() !== second
  ) {
    return null;
  }
  const offsetMinutes =
    (offsetHour * 60 + offsetMinute) *
    (offsetSign === "-" ? -1 : 1);
  const utcMilliseconds =
    localMilliseconds - offsetMinutes * 60_000;
  const epochSeconds = utcMilliseconds / 1_000;
  if (!Number.isSafeInteger(epochSeconds)) return null;
  return `${epochSeconds}:${fractionText.padEnd(9, "0")}`;
}

export function sameAuthGenerationCreatedAt(
  observed: string,
  expected: string,
): boolean {
  const observedNs = parseIsoInstantNanoseconds(observed);
  const expectedNs = parseIsoInstantNanoseconds(expected);
  return (
    observedNs !== null &&
    expectedNs !== null &&
    observedNs === expectedNs
  );
}

/**
 * Execute one fenced cleanup lease. A delete acknowledgement is never
 * terminal evidence: the worker always performs a fresh Admin Auth read and
 * the finish RPC independently rechecks `auth.users` under the source fence.
 */
export async function processOAuthAnonAuthCleanupJob(
  admin: AdminClient,
): Promise<OAuthAnonAuthCleanupOutcome> {
  const leaseToken = randomUUID();
  const claim = await rpc(admin, "claim_oauth_anon_auth_cleanup", {
    p_lease_token: leaseToken,
    p_lease_seconds: DEFAULT_LEASE_SECONDS,
  });
  const pendingBacklog = parseCleanupIdle(claim);
  if (pendingBacklog !== null) {
    return { kind: "idle", pendingBacklog };
  }
  const lease = parseOAuthAnonAuthCleanupLease(claim);
  if (!lease) {
    throw new Error("invalid empty oauth anonymous Auth cleanup claim");
  }
  if (lease.leaseToken !== leaseToken) {
    throw new Error("oauth anonymous Auth cleanup lease token mismatch");
  }

  const before = await readFreshAuthUser(admin, lease.sourceUserId);
  let verified: SourceVerification;
  try {
    verified = await verifySource(admin, lease);
  } catch {
    return pending(admin, lease, "source_verification_unavailable");
  }

  if (verified === "absent") {
    if (before.kind !== "missing") {
      return pending(admin, lease, "auth_read_db_divergence");
    }
    try {
      return await terminal(admin, lease, "completed");
    } catch {
      return pending(admin, lease, "absence_finish_unavailable");
    }
  }
  if (verified === "protected") {
    try {
      return await terminal(admin, lease, "protected");
    } catch {
      return pending(admin, lease, "protection_finish_unavailable");
    }
  }
  if (
    before.kind !== "present" ||
    before.user.is_anonymous !== true ||
    !sameAuthGenerationCreatedAt(
      before.user.created_at,
      lease.sourceAuthCreatedAt,
    )
  ) {
    return pending(admin, lease, "auth_read_db_divergence");
  }

  // The response is deliberately ignored. It may be a resolved error, throw,
  // malformed success, or a lost acknowledgement after the delete committed.
  try {
    await admin.auth.admin.deleteUser(lease.sourceUserId);
  } catch {
    // Fresh post-delete authority below decides the outcome.
  }

  const after = await readFreshAuthUser(admin, lease.sourceUserId);
  if (after.kind === "unavailable") {
    return pending(admin, lease, "auth_delete_confirmation_unavailable");
  }

  let verifiedAfter: SourceVerification;
  try {
    verifiedAfter = await verifySource(admin, lease);
  } catch {
    return pending(admin, lease, "post_delete_verification_unavailable");
  }
  if (after.kind === "missing" && verifiedAfter === "absent") {
    try {
      return await terminal(admin, lease, "completed");
    } catch {
      return pending(admin, lease, "absence_finish_unavailable");
    }
  }
  if (after.kind === "present" && verifiedAfter === "protected") {
    try {
      return await terminal(admin, lease, "protected");
    } catch {
      return pending(admin, lease, "protection_finish_unavailable");
    }
  }
  return pending(admin, lease, "auth_delete_not_confirmed");
}

export async function drainOAuthAnonAuthCleanupJobs(
  admin: AdminClient,
  limit: number,
): Promise<OAuthAnonAuthCleanupDrainResult> {
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_DRAIN_LIMIT
  ) {
    throw new Error("invalid oauth anonymous Auth cleanup drain limit");
  }
  const result: OAuthAnonAuthCleanupDrainResult = {
    claimed: 0,
    completed: 0,
    protected: 0,
    failed: 0,
    pending: 0,
    backlog: 0,
    claimErrors: 0,
  };
  for (let index = 0; index < limit; index += 1) {
    let outcome: OAuthAnonAuthCleanupOutcome;
    try {
      outcome = await processOAuthAnonAuthCleanupJob(admin);
    } catch {
      result.claimErrors += 1;
      break;
    }
    if (outcome.kind === "idle") {
      result.backlog = outcome.pendingBacklog;
      break;
    }
    result.claimed += 1;
    if (outcome.kind === "completed") result.completed += 1;
    else if (outcome.kind === "protected") result.protected += 1;
    else if (outcome.kind === "failed") result.failed += 1;
    else {
      result.pending += 1;
      // This is a lower bound when the batch fills before an idle claim can
      // return the authoritative queue count.
      result.backlog += 1;
    }
  }
  return result;
}
