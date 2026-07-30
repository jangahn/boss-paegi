import type { User } from "@supabase/supabase-js";
import type { createAdminClient } from "./supabase/admin.ts";
import {
  deletedEmailMarker,
  isDeletedMarker,
} from "./oauth-metadata.ts";
import {
  parseAccountReactivationCancelledResult,
  parseAccountReactivationCompleteResult,
  type AccountReactivationCancelledResult,
  type AccountReactivationCompleteResult,
  type AccountReactivationTerminalResult,
} from "./admin-mutation.ts";
import {
  requireSupabaseData,
  requireSupabaseSuccess,
} from "./supabase-operation.ts";

type AdminClient = ReturnType<typeof createAdminClient>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const REACTIVATION_LEASE_SECONDS = 120;
const REACTIVATION_AUTH_FENCE_KEY = "bp_reactivation_fence";

export type AccountReactivationCorrelation = {
  requestId: string;
  adminId: string;
  userId: string;
};

export type AccountReactivationLease =
  AccountReactivationCorrelation & {
    email: string;
    expectedDeletedAt: string;
    expectedWithdrawalGeneration: number;
    leaseToken: string;
    leaseVersion: number;
    attemptCount: number;
    action: "activate" | "cancel";
    preflightError: string | null;
  };

export type AccountReactivationStatus = {
  status: "pending" | "leased" | "completed" | "cancelled";
  requestId: string;
  adminId: string;
  userId: string;
  attemptCount: number;
  nextAttemptAt: string | null;
  result: AccountReactivationTerminalResult | null;
};

export type AccountReactivationOutcome =
  | { kind: "idle" }
  | {
      kind: "completed";
      requestId: string;
      adminId: string;
      userId: string;
      attemptCount: number;
      result: AccountReactivationCompleteResult;
    }
  | {
      kind: "cancelled";
      requestId: string;
      adminId: string;
      userId: string;
      attemptCount: number;
      result: AccountReactivationCancelledResult;
    }
  | {
      kind: "pending";
      requestId: string;
      adminId: string;
      userId: string;
      attemptCount: number;
      failure: string;
      retryRecorded: boolean;
    };

export type AccountReactivationDrainResult = {
  claimed: number;
  completed: number;
  pending: number;
  retryBacklog: number;
  claimErrors: number;
  healthErrors: number;
  failures: Array<{
    requestId: string;
    userId: string;
    failure: string;
    retryRecorded: boolean;
  }>;
  claimFailures: string[];
  backlogSample: {
    requestId: string;
    userId: string;
    status: "pending" | "leased";
    lastError: string | null;
    retryAt: string;
  } | null;
};

type LegacyAccountReactivationRepairLease = {
  status: "leased";
  jobId: string;
  userId: string;
  email: string;
  expectedWithdrawalGeneration: number;
  leaseToken: string;
  leaseVersion: number;
  attemptCount: number;
  preflightError: string | null;
};

type LegacyAccountReactivationRepairClaim =
  | LegacyAccountReactivationRepairLease
  | {
      status: "superseded";
      jobId: string;
      userId: string;
    };

type LegacyAccountReactivationRepairOutcome =
  | { kind: "idle" }
  | {
      kind: "completed";
      jobId: string;
      userId: string;
    }
  | {
      kind: "superseded";
      jobId: string;
      userId: string;
    }
  | {
      kind: "pending";
      jobId: string;
      userId: string;
      failure: string;
      retryRecorded: boolean;
    };

class AccountReactivationFailure extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "AccountReactivationFailure";
    this.code = code;
  }
}

export type AccountReactivationDeadline = {
  readonly monotonicDeadlineMs: number;
};

export function createAccountReactivationDeadline(
  maxDurationMs: number,
): AccountReactivationDeadline {
  const bounded = Math.max(
    1,
    Math.min(
      Number.isFinite(maxDurationMs)
        ? Math.trunc(maxDurationMs)
        : 1,
      55_000,
    ),
  );
  return {
    monotonicDeadlineMs: performance.now() + bounded,
  };
}

async function beforeDeadline<T>(
  deadline: AccountReactivationDeadline | undefined,
  task: () => Promise<T>,
): Promise<T> {
  if (!deadline) return task();
  const remaining =
    deadline.monotonicDeadlineMs - performance.now();
  if (remaining <= 0) {
    throw new AccountReactivationFailure(
      "reactivation_deadline_exceeded",
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task(),
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new AccountReactivationFailure(
                "reactivation_deadline_exceeded",
              ),
            ),
          remaining,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Share the saga's monotonic deadline with the durable begin/cancel RPCs
 * performed by HTTP routes. A timed-out request may keep running in the
 * underlying client, but both operations are durable and exactly replayable;
 * the caller must report pending rather than waiting past the route ceiling.
 */
export async function runAccountReactivationBeforeDeadline<T>(
  deadline: AccountReactivationDeadline | undefined,
  task: () => Promise<T>,
): Promise<T> {
  return beforeDeadline(deadline, task);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new AccountReactivationFailure("invalid_rpc_response");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new AccountReactivationFailure(`invalid_${field}`);
  }
  return value;
}

function safeInteger(
  value: unknown,
  field: string,
  minimum = 0,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new AccountReactivationFailure(`invalid_${field}`);
  }
  return value as number;
}

function normalizedEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length >= 3 &&
    normalized.length <= 320 &&
    EMAIL_RE.test(normalized)
    ? normalized
    : null;
}

function timestamp(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length > 64 ||
    !Number.isFinite(Date.parse(value))
  ) {
    throw new AccountReactivationFailure(`invalid_${field}`);
  }
  return value;
}

function optionalFailureCode(value: unknown): string | null {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 100 ||
    !/^[a-z][a-z0-9_]*$/u.test(value)
  ) {
    throw new AccountReactivationFailure("invalid_preflight_error");
  }
  return value;
}

export function parseAccountReactivationLease(
  value: unknown,
): AccountReactivationLease | null {
  if (value === null) return null;
  const row = record(value);
  const email = normalizedEmail(row.email);
  if (!email || isDeletedMarker(email)) {
    throw new AccountReactivationFailure("invalid_reactivation_email");
  }
  return {
    requestId: uuid(row.request_id, "request_id"),
    adminId: uuid(row.admin_user_id, "admin_user_id"),
    userId: uuid(row.user_id, "user_id"),
    email,
    expectedDeletedAt: timestamp(
      row.expected_deleted_at,
      "expected_deleted_at",
    ),
    expectedWithdrawalGeneration: safeInteger(
      row.expected_withdrawal_generation,
      "expected_withdrawal_generation",
      1,
    ),
    leaseToken: uuid(row.lease_token, "lease_token"),
    leaseVersion: safeInteger(row.lease_version, "lease_version", 1),
    attemptCount: safeInteger(row.attempt_count, "attempt_count", 1),
    action:
      row.action === "activate" || row.action === "cancel"
        ? row.action
        : (() => {
            throw new AccountReactivationFailure(
              "invalid_reactivation_action",
            );
          })(),
    preflightError: optionalFailureCode(row.preflight_error),
  };
}

function parseLegacyAccountReactivationRepairClaim(
  value: unknown,
): LegacyAccountReactivationRepairClaim | null {
  if (value === null) return null;
  const row = record(value);
  if (row.status === "superseded") {
    return {
      status: "superseded",
      jobId: uuid(row.job_id, "legacy_repair_job_id"),
      userId: uuid(row.user_id, "legacy_repair_user_id"),
    };
  }
  if (row.status !== "leased") {
    throw new AccountReactivationFailure(
      "invalid_legacy_repair_status",
    );
  }
  const email = normalizedEmail(row.email);
  if (!email || isDeletedMarker(email)) {
    throw new AccountReactivationFailure(
      "invalid_legacy_repair_email",
    );
  }
  return {
    status: "leased",
    jobId: uuid(row.job_id, "legacy_repair_job_id"),
    userId: uuid(row.user_id, "legacy_repair_user_id"),
    email,
    expectedWithdrawalGeneration: safeInteger(
      row.expected_withdrawal_generation,
      "legacy_repair_withdrawal_generation",
    ),
    leaseToken: uuid(
      row.lease_token,
      "legacy_repair_lease_token",
    ),
    leaseVersion: safeInteger(
      row.lease_version,
      "legacy_repair_lease_version",
      1,
    ),
    attemptCount: safeInteger(
      row.attempt_count,
      "legacy_repair_attempt_count",
      1,
    ),
    preflightError: optionalFailureCode(row.preflight_error),
  };
}

export function parseAccountReactivationStatus(
  value: unknown,
): AccountReactivationStatus {
  const row = record(value);
  if (
    row.ok !== true ||
    (row.status !== "pending" &&
      row.status !== "leased" &&
      row.status !== "completed" &&
      row.status !== "cancelled")
  ) {
    throw new AccountReactivationFailure("invalid_reactivation_status");
  }
  const result = row.status === "completed"
    ? parseAccountReactivationCompleteResult(row.result)
    : row.status === "cancelled"
      ? parseAccountReactivationCancelledResult(row.result)
      : null;
  if (
    (
      (row.status === "completed" || row.status === "cancelled") &&
      !result
    ) ||
    (
      row.status !== "completed" &&
      row.status !== "cancelled" &&
      row.result !== null
    )
  ) {
    throw new AccountReactivationFailure(
      "invalid_reactivation_status_result",
    );
  }
  const nextAttemptAt =
    row.next_attempt_at === null
      ? null
      : timestamp(row.next_attempt_at, "next_attempt_at");
  return {
    status: row.status,
    requestId: uuid(row.request_id, "status_request_id"),
    adminId: uuid(row.admin_user_id, "status_admin_id"),
    userId: uuid(row.user_id, "status_user_id"),
    attemptCount: safeInteger(row.attempt_count, "status_attempt_count"),
    nextAttemptAt,
    result,
  };
}

function exactCorrelation(
  actual: AccountReactivationCorrelation,
  expected: AccountReactivationCorrelation,
): boolean {
  return (
    actual.requestId === expected.requestId &&
    actual.adminId === expected.adminId &&
    actual.userId === expected.userId
  );
}

async function readAuthUserOrMissing(
  admin: AdminClient,
  userId: string,
  deadline?: AccountReactivationDeadline,
): Promise<User | null> {
  const response = await beforeDeadline(
    deadline,
    () => admin.auth.admin.getUserById(userId),
  );
  if (response.error) {
    const error = response.error as {
      status?: unknown;
      code?: unknown;
    };
    if (error.status === 404 && error.code === "user_not_found") {
      return null;
    }
    await requireSupabaseSuccess(
      "account.reactivation.auth.read",
      async () => response,
    );
  }
  const user = response.data?.user;
  if (!user) return null;
  if (user.id !== userId) {
    throw new AccountReactivationFailure("auth_identity_mismatch");
  }
  return user;
}

async function readAuthUser(
  admin: AdminClient,
  userId: string,
  deadline?: AccountReactivationDeadline,
): Promise<User> {
  const user = await readAuthUserOrMissing(admin, userId, deadline);
  if (!user) {
    throw new AccountReactivationFailure("auth_user_missing");
  }
  return user;
}

function authFence(lease: AccountReactivationLease) {
  return {
    request_id: lease.requestId,
    admin_user_id: lease.adminId,
    user_id: lease.userId,
    lease_token: lease.leaseToken,
    lease_version: lease.leaseVersion,
    action: lease.action,
    expected_deleted_at: lease.expectedDeletedAt,
    expected_withdrawal_generation:
      lease.expectedWithdrawalGeneration,
  };
}

function exactAuthFence(
  user: User,
  lease: AccountReactivationLease,
): boolean {
  const value = user.app_metadata?.[REACTIVATION_AUTH_FENCE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const expected = authFence(lease);
  return (
    candidate.request_id === expected.request_id &&
    candidate.admin_user_id === expected.admin_user_id &&
    candidate.user_id === expected.user_id &&
    candidate.lease_token === expected.lease_token &&
    candidate.lease_version === expected.lease_version &&
    candidate.action === expected.action &&
    candidate.expected_deleted_at === expected.expected_deleted_at &&
    candidate.expected_withdrawal_generation ===
      expected.expected_withdrawal_generation
  );
}

function legacyRepairAuthFence(
  lease: LegacyAccountReactivationRepairLease,
) {
  return {
    action: "legacy_repair",
    legacy_repair_job_id: lease.jobId,
    user_id: lease.userId,
    lease_token: lease.leaseToken,
    lease_version: lease.leaseVersion,
    expected_withdrawal_generation:
      lease.expectedWithdrawalGeneration,
  };
}

function exactLegacyRepairAuthFence(
  user: User,
  lease: LegacyAccountReactivationRepairLease,
): boolean {
  const value = user.app_metadata?.[REACTIVATION_AUTH_FENCE_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Record<string, unknown>;
  const expected = legacyRepairAuthFence(lease);
  return (
    candidate.action === expected.action &&
    candidate.legacy_repair_job_id ===
      expected.legacy_repair_job_id &&
    candidate.user_id === expected.user_id &&
    candidate.lease_token === expected.lease_token &&
    candidate.lease_version === expected.lease_version &&
    candidate.expected_withdrawal_generation ===
      expected.expected_withdrawal_generation
  );
}

async function armAuthFence(
  admin: AdminClient,
  lease: AccountReactivationLease,
  deadline?: AccountReactivationDeadline,
): Promise<void> {
  const value = await beforeDeadline(
    deadline,
    () => requireSupabaseData(
      "account.reactivation.auth.arm_fence",
      () =>
        admin.rpc("arm_account_reactivation_auth_fence", {
          p_request_id: lease.requestId,
          p_admin_id: lease.adminId,
          p_user_id: lease.userId,
          p_lease_token: lease.leaseToken,
          p_lease_version: lease.leaseVersion,
        }),
    ),
  );
  const row = record(value);
  if (
    row.ok !== true ||
    uuid(row.request_id, "armed_request_id") !== lease.requestId ||
    uuid(row.user_id, "armed_user_id") !== lease.userId ||
    uuid(row.lease_token, "armed_lease_token") !== lease.leaseToken ||
    safeInteger(row.lease_version, "armed_lease_version", 1) !==
      lease.leaseVersion ||
    row.action !== lease.action
  ) {
    throw new AccountReactivationFailure("invalid_auth_fence_arm");
  }
}

async function armLegacyRepairAuthFence(
  admin: AdminClient,
  lease: LegacyAccountReactivationRepairLease,
  deadline?: AccountReactivationDeadline,
): Promise<void> {
  const value = await beforeDeadline(
    deadline,
    () => requireSupabaseData(
      "account.reactivation.legacy_repair.auth.arm_fence",
      () =>
        admin.rpc(
          "arm_account_reactivation_legacy_repair_auth_fence",
          {
            p_job_id: lease.jobId,
            p_user_id: lease.userId,
            p_lease_token: lease.leaseToken,
            p_lease_version: lease.leaseVersion,
          },
        ),
    ),
  );
  const row = record(value);
  if (
    row.ok !== true ||
    uuid(row.job_id, "armed_legacy_repair_job_id") !==
      lease.jobId ||
    uuid(row.user_id, "armed_legacy_repair_user_id") !==
      lease.userId ||
    uuid(row.lease_token, "armed_legacy_repair_lease_token") !==
      lease.leaseToken ||
    safeInteger(
        row.lease_version,
        "armed_legacy_repair_lease_version",
        1,
      ) !== lease.leaseVersion ||
    row.action !== "legacy_repair"
  ) {
    throw new AccountReactivationFailure(
      "invalid_legacy_repair_auth_fence_arm",
    );
  }
}

/**
 * The only permitted external mutation is marker -> the receipt-bound email.
 * The permanent auth.users trigger accepts that transition only while this
 * exact request/admin/user/token/version/deletion lease is live. A fresh
 * authoritative read proves both the email and fence persisted. If a response
 * is lost after GoTrue commits, the next attempt converges without changing a
 * different real identity.
 */
async function ensureReceiptBoundAuthEmail(
  admin: AdminClient,
  lease: AccountReactivationLease,
  deadline?: AccountReactivationDeadline,
): Promise<void> {
  if (lease.action !== "activate") {
    throw new AccountReactivationFailure(
      "reactivation_action_mismatch",
    );
  }
  const expected = normalizedEmail(lease.email);
  const marker = normalizedEmail(deletedEmailMarker(lease.userId));
  if (!expected || !marker || expected === marker) {
    throw new AccountReactivationFailure("invalid_reactivation_email");
  }

  let current = await readAuthUser(admin, lease.userId, deadline);
  let currentEmail = normalizedEmail(current.email);
  if (currentEmail !== expected && currentEmail !== marker) {
    throw new AccountReactivationFailure("auth_identity_conflict");
  }

  // GoTrue applies an Admin update in the order identity email -> users.email
  // -> app metadata. A combined request cannot satisfy the BEFORE-email
  // trigger, and re-sending a stale metadata map can overwrite concurrent
  // role/provider changes. Arm only this fence key through an exact
  // lease-validated DB RPC that atomically jsonb-merges the current row.
  if (!exactAuthFence(current, lease)) {
    let stageFailure: unknown = null;
    try {
      await armAuthFence(admin, lease, deadline);
    } catch (error) {
      stageFailure = error;
    }

    try {
      current = await readAuthUser(admin, lease.userId, deadline);
      currentEmail = normalizedEmail(current.email);
      if (
        !exactAuthFence(current, lease) ||
        (currentEmail !== marker && currentEmail !== expected)
      ) {
        throw new AccountReactivationFailure(
          "auth_fence_stage_not_observed",
        );
      }
    } catch (error) {
      throw new AccountReactivationFailure(
        stageFailure
          ? "auth_fence_stage_unconfirmed"
          : failureCode(error),
      );
    }
  }

  if (currentEmail === expected) return;
  if (currentEmail !== marker) {
    throw new AccountReactivationFailure("auth_identity_conflict");
  }

  let updateFailure: unknown = null;
  try {
    const update = await beforeDeadline(deadline, () =>
      admin.auth.admin.updateUserById(lease.userId, {
        email: lease.email,
        email_confirm: true,
      })
    );
    const updatedUser = update.data?.user;
    if (
      update.error ||
      !updatedUser ||
      updatedUser.id !== lease.userId ||
      normalizedEmail(updatedUser.email) !== expected
    ) {
      updateFailure =
        update.error ??
        new AccountReactivationFailure("invalid_auth_update_response");
    }
  } catch (error) {
    updateFailure = error;
  }

  // A resolved error or thrown response can still follow a committed update.
  // Only the fresh exact-ID/exact-email read is terminal evidence.
  try {
    const observed = await readAuthUser(
      admin,
      lease.userId,
      deadline,
    );
    if (
      normalizedEmail(observed.email) === expected &&
      exactAuthFence(observed, lease)
    ) {
      return;
    }
  } catch (error) {
    if (!updateFailure) updateFailure = error;
  }
  throw new AccountReactivationFailure(
    updateFailure
      ? "auth_email_update_unconfirmed"
      : "auth_email_not_observed",
  );
}

/**
 * Cancellation is the inverse fenced side effect. A missing Auth user or the
 * exact fixed marker already proves the account cannot authenticate under the
 * restored address. Only the receipt-bound real email may be scrubbed; a
 * third real identity is never overwritten. The SQL trigger accepts the
 * exact real -> marker transition only for this live cancel lease.
 */
async function ensureCancelledAuthEmail(
  admin: AdminClient,
  lease: AccountReactivationLease,
  deadline?: AccountReactivationDeadline,
): Promise<void> {
  if (lease.action !== "cancel") {
    throw new AccountReactivationFailure(
      "reactivation_action_mismatch",
    );
  }
  const expected = normalizedEmail(lease.email);
  const marker = normalizedEmail(deletedEmailMarker(lease.userId));
  if (!expected || !marker || expected === marker) {
    throw new AccountReactivationFailure(
      "invalid_reactivation_email",
    );
  }

  let current = await readAuthUserOrMissing(
    admin,
    lease.userId,
    deadline,
  );
  if (!current) return;
  let currentEmail = normalizedEmail(current.email);
  if (currentEmail === marker) return;
  if (currentEmail !== expected) {
    throw new AccountReactivationFailure(
      "auth_identity_conflict",
    );
  }

  if (!exactAuthFence(current, lease)) {
    let stageFailure: unknown = null;
    try {
      await armAuthFence(admin, lease, deadline);
    } catch (error) {
      stageFailure = error;
    }
    try {
      current = await readAuthUserOrMissing(
        admin,
        lease.userId,
        deadline,
      );
      if (!current) return;
      currentEmail = normalizedEmail(current.email);
      if (
        !exactAuthFence(current, lease) ||
        (currentEmail !== expected && currentEmail !== marker)
      ) {
        throw new AccountReactivationFailure(
          "auth_cancel_fence_stage_not_observed",
        );
      }
    } catch (error) {
      throw new AccountReactivationFailure(
        stageFailure
          ? "auth_cancel_fence_stage_unconfirmed"
          : failureCode(error),
      );
    }
  }
  if (!current) return;
  if (currentEmail === marker) return;
  if (currentEmail !== expected) {
    throw new AccountReactivationFailure(
      "auth_identity_conflict",
    );
  }

  let updateFailure: unknown = null;
  try {
    const update = await beforeDeadline(deadline, () =>
      admin.auth.admin.updateUserById(lease.userId, {
        email: marker,
        email_confirm: true,
      })
    );
    const updated = update.data?.user;
    if (
      update.error ||
      !updated ||
      updated.id !== lease.userId ||
      normalizedEmail(updated.email) !== marker
    ) {
      updateFailure =
        update.error ??
        new AccountReactivationFailure(
          "invalid_auth_cancel_update_response",
        );
    }
  } catch (error) {
    updateFailure = error;
  }

  try {
    const observed = await readAuthUserOrMissing(
      admin,
      lease.userId,
      deadline,
    );
    if (
      !observed ||
      (
        normalizedEmail(observed.email) === marker &&
        exactAuthFence(observed, lease)
      )
    ) {
      return;
    }
  } catch (error) {
    if (!updateFailure) updateFailure = error;
  }
  throw new AccountReactivationFailure(
    updateFailure
      ? "auth_cancel_update_unconfirmed"
      : "auth_marker_not_observed",
  );
}

async function ensureLegacyRepairAuthEmail(
  admin: AdminClient,
  lease: LegacyAccountReactivationRepairLease,
  deadline?: AccountReactivationDeadline,
): Promise<void> {
  const expected = normalizedEmail(lease.email);
  const marker = normalizedEmail(deletedEmailMarker(lease.userId));
  if (!expected || !marker || expected === marker) {
    throw new AccountReactivationFailure(
      "invalid_legacy_repair_email",
    );
  }

  let current = await readAuthUser(admin, lease.userId, deadline);
  let currentEmail = normalizedEmail(current.email);
  if (currentEmail === expected) return;
  if (currentEmail !== marker) {
    throw new AccountReactivationFailure(
      "legacy_repair_auth_identity_conflict",
    );
  }

  if (!exactLegacyRepairAuthFence(current, lease)) {
    let stageFailure: unknown = null;
    try {
      await armLegacyRepairAuthFence(admin, lease, deadline);
    } catch (error) {
      stageFailure = error;
    }
    try {
      current = await readAuthUser(admin, lease.userId, deadline);
      currentEmail = normalizedEmail(current.email);
      if (
        !exactLegacyRepairAuthFence(current, lease) ||
        (currentEmail !== marker && currentEmail !== expected)
      ) {
        throw new AccountReactivationFailure(
          "legacy_repair_auth_fence_stage_not_observed",
        );
      }
    } catch (error) {
      throw new AccountReactivationFailure(
        stageFailure
          ? "legacy_repair_auth_fence_stage_unconfirmed"
          : failureCode(error),
      );
    }
  }
  if (currentEmail === expected) return;
  if (currentEmail !== marker) {
    throw new AccountReactivationFailure(
      "legacy_repair_auth_identity_conflict",
    );
  }

  let updateFailure: unknown = null;
  try {
    const update = await beforeDeadline(deadline, () =>
      admin.auth.admin.updateUserById(lease.userId, {
        email: lease.email,
        email_confirm: true,
      })
    );
    const updated = update.data?.user;
    if (
      update.error ||
      !updated ||
      updated.id !== lease.userId ||
      normalizedEmail(updated.email) !== expected
    ) {
      updateFailure =
        update.error ??
        new AccountReactivationFailure(
          "invalid_legacy_repair_auth_update_response",
        );
    }
  } catch (error) {
    updateFailure = error;
  }

  try {
    current = await readAuthUser(admin, lease.userId, deadline);
    currentEmail = normalizedEmail(current.email);
    if (
      currentEmail === expected &&
      exactLegacyRepairAuthFence(current, lease)
    ) {
      return;
    }
  } catch (error) {
    if (!updateFailure) updateFailure = error;
  }
  throw new AccountReactivationFailure(
    updateFailure
      ? "legacy_repair_auth_update_unconfirmed"
      : "legacy_repair_auth_email_not_observed",
  );
}

async function finishAccountReactivation(
  admin: AdminClient,
  lease: AccountReactivationLease,
  options:
    | { success: true }
    | { success: false; error: string },
  deadline?: AccountReactivationDeadline,
): Promise<AccountReactivationTerminalResult | null> {
  const value = await beforeDeadline(
    deadline,
    () => requireSupabaseData(
      "account.reactivation.finish",
      () =>
        admin.rpc("finish_account_reactivation_job", {
          p_request_id: lease.requestId,
          p_admin_id: lease.adminId,
          p_user_id: lease.userId,
          p_lease_token: lease.leaseToken,
          p_lease_version: lease.leaseVersion,
          p_success: options.success,
          p_error: options.success ? null : options.error.slice(0, 500),
        }),
    ),
  );
  const row = record(value);
  if (
    row.ok !== true ||
    uuid(row.request_id, "finished_request_id") !== lease.requestId
  ) {
    throw new AccountReactivationFailure("invalid_reactivation_finish");
  }
  if (options.success) {
    if (
      (lease.action === "activate" && row.status !== "completed") ||
      (lease.action === "cancel" && row.status !== "cancelled")
    ) {
      throw new AccountReactivationFailure(
        "invalid_reactivation_finish_status",
      );
    }
    const result = lease.action === "activate"
      ? parseAccountReactivationCompleteResult(row.result)
      : parseAccountReactivationCancelledResult(row.result);
    if (!result || result.userId !== lease.userId) {
      throw new AccountReactivationFailure(
        "invalid_reactivation_finish_result",
      );
    }
    return result;
  }
  if (row.status !== "pending" || row.result !== null) {
    throw new AccountReactivationFailure(
      "invalid_reactivation_retry_result",
    );
  }
  return null;
}

async function finishLegacyAccountReactivationRepair(
  admin: AdminClient,
  lease: LegacyAccountReactivationRepairLease,
  options:
    | { success: true }
    | { success: false; error: string },
  deadline?: AccountReactivationDeadline,
): Promise<"completed" | "superseded" | "pending"> {
  const value = await beforeDeadline(
    deadline,
    () => requireSupabaseData(
      "account.reactivation.legacy_repair.finish",
      () =>
        admin.rpc("finish_account_reactivation_legacy_repair", {
          p_job_id: lease.jobId,
          p_user_id: lease.userId,
          p_lease_token: lease.leaseToken,
          p_lease_version: lease.leaseVersion,
          p_success: options.success,
          p_error: options.success ? null : options.error.slice(0, 500),
        }),
    ),
  );
  const row = record(value);
  if (
    row.ok !== true ||
    uuid(row.job_id, "finished_legacy_repair_job_id") !==
      lease.jobId ||
    (
      row.status !== "completed" &&
      row.status !== "superseded" &&
      row.status !== "pending"
    ) ||
    (options.success && row.status === "pending") ||
    (!options.success && row.status !== "pending")
  ) {
    throw new AccountReactivationFailure(
      "invalid_legacy_repair_finish",
    );
  }
  return row.status;
}

async function getLegacyAccountReactivationRepairStatus(
  admin: AdminClient,
  lease: LegacyAccountReactivationRepairLease,
  deadline?: AccountReactivationDeadline,
): Promise<"pending" | "leased" | "completed" | "superseded"> {
  const value = await beforeDeadline(
    deadline,
    () => requireSupabaseData(
      "account.reactivation.legacy_repair.status",
      () =>
        admin.rpc("get_account_reactivation_legacy_repair_status", {
          p_job_id: lease.jobId,
          p_user_id: lease.userId,
        }),
    ),
  );
  const row = record(value);
  if (
    row.ok !== true ||
    uuid(row.job_id, "legacy_repair_status_job_id") !==
      lease.jobId ||
    uuid(row.user_id, "legacy_repair_status_user_id") !==
      lease.userId ||
    (
      row.status !== "pending" &&
      row.status !== "leased" &&
      row.status !== "completed" &&
      row.status !== "superseded"
    )
  ) {
    throw new AccountReactivationFailure(
      "invalid_legacy_repair_status_response",
    );
  }
  return row.status;
}

export async function getAccountReactivationStatus(
  admin: AdminClient,
  correlation: AccountReactivationCorrelation,
  deadline?: AccountReactivationDeadline,
): Promise<AccountReactivationStatus> {
  const value = await beforeDeadline(
    deadline,
    () => requireSupabaseData(
      "account.reactivation.status",
      () =>
        admin.rpc("get_account_reactivation_status", {
          p_request_id: correlation.requestId,
          p_admin_id: correlation.adminId,
          p_user_id: correlation.userId,
        }),
    ),
  );
  const status = parseAccountReactivationStatus(value);
  if (!exactCorrelation(status, correlation)) {
    throw new AccountReactivationFailure(
      "reactivation_status_correlation_mismatch",
    );
  }
  if (status.result && status.result.userId !== correlation.userId) {
    throw new AccountReactivationFailure(
      "reactivation_status_target_mismatch",
    );
  }
  return status;
}

function failureCode(error: unknown): string {
  if (error instanceof AccountReactivationFailure) return error.code;
  if (
    error &&
    typeof error === "object" &&
    "operation" in error &&
    typeof (error as { operation?: unknown }).operation === "string"
  ) {
    return (error as { operation: string }).operation;
  }
  return error instanceof Error
    ? error.name
    : "unknown_account_reactivation_failure";
}

function terminalOutcome(
  lease: AccountReactivationLease,
  result: AccountReactivationTerminalResult,
): AccountReactivationOutcome {
  const correlation = {
    requestId: lease.requestId,
    adminId: lease.adminId,
    userId: lease.userId,
    attemptCount: lease.attemptCount,
  };
  if (lease.action === "activate" && result.accountReactivated) {
    return { kind: "completed", ...correlation, result };
  }
  if (
    lease.action === "cancel" &&
    !result.accountReactivated &&
    result.cancelled
  ) {
    return { kind: "cancelled", ...correlation, result };
  }
  throw new AccountReactivationFailure(
    "reactivation_terminal_action_mismatch",
  );
}

async function recoverTerminalStatus(
  admin: AdminClient,
  lease: AccountReactivationLease,
  deadline?: AccountReactivationDeadline,
): Promise<AccountReactivationTerminalResult | null> {
  try {
    const status = await getAccountReactivationStatus(
      admin,
      lease,
      deadline,
    );
    if (
      (lease.action === "activate" && status.status === "completed") ||
      (lease.action === "cancel" && status.status === "cancelled")
    ) {
      return status.result;
    }
    return null;
  } catch {
    return null;
  }
}

async function recordRetry(
  admin: AdminClient,
  lease: AccountReactivationLease,
  failure: string,
  deadline?: AccountReactivationDeadline,
): Promise<AccountReactivationOutcome> {
  try {
    await finishAccountReactivation(
      admin,
      lease,
      {
        success: false,
        error: failure,
      },
      deadline,
    );
    return {
      kind: "pending",
      requestId: lease.requestId,
      adminId: lease.adminId,
      userId: lease.userId,
      attemptCount: lease.attemptCount,
      failure,
      retryRecorded: true,
    };
  } catch {
    // A stale/lost finish cannot authorize success. The lease remains
    // reclaimable after expiry and the exact email mutation is idempotent.
    return {
      kind: "pending",
      requestId: lease.requestId,
      adminId: lease.adminId,
      userId: lease.userId,
      attemptCount: lease.attemptCount,
      failure,
      retryRecorded: false,
    };
  }
}

export async function processAccountReactivationJob(
  admin: AdminClient,
  correlation?: AccountReactivationCorrelation,
  deadline?: AccountReactivationDeadline,
): Promise<AccountReactivationOutcome> {
  const claim = await beforeDeadline(
    deadline,
    () => requireSupabaseSuccess(
      "account.reactivation.claim",
      () =>
        admin.rpc("claim_account_reactivation_job", {
          p_request_id: correlation?.requestId ?? null,
          p_admin_id: correlation?.adminId ?? null,
          p_user_id: correlation?.userId ?? null,
          p_lease_seconds: REACTIVATION_LEASE_SECONDS,
        }),
    ),
  );
  const lease = parseAccountReactivationLease(claim.data);
  if (!lease) return { kind: "idle" };
  if (correlation && !exactCorrelation(lease, correlation)) {
    throw new AccountReactivationFailure(
      "reactivation_claim_correlation_mismatch",
    );
  }

  if (lease.preflightError) {
    return recordRetry(
      admin,
      lease,
      lease.preflightError,
      deadline,
    );
  }

  try {
    if (lease.action === "activate") {
      await ensureReceiptBoundAuthEmail(admin, lease, deadline);
    } else {
      await ensureCancelledAuthEmail(admin, lease, deadline);
    }
  } catch (error) {
    const failure = failureCode(error);
    if (failure === "reactivation_deadline_exceeded") {
      return {
        kind: "pending",
        requestId: lease.requestId,
        adminId: lease.adminId,
        userId: lease.userId,
        attemptCount: lease.attemptCount,
        failure,
        retryRecorded: false,
      };
    }
    return recordRetry(admin, lease, failure, deadline);
  }

  try {
    const result = await finishAccountReactivation(
      admin,
      lease,
      { success: true },
      deadline,
    );
    if (!result) {
      throw new AccountReactivationFailure(
        "missing_reactivation_finish_result",
      );
    }
    return terminalOutcome(lease, result);
  } catch (error) {
    const terminal = await recoverTerminalStatus(
      admin,
      lease,
      deadline,
    );
    if (terminal) return terminalOutcome(lease, terminal);
    const failure = failureCode(error);
    if (failure === "reactivation_deadline_exceeded") {
      return {
        kind: "pending",
        requestId: lease.requestId,
        adminId: lease.adminId,
        userId: lease.userId,
        attemptCount: lease.attemptCount,
        failure,
        retryRecorded: false,
      };
    }
    return recordRetry(admin, lease, failure, deadline);
  }
}

async function processLegacyAccountReactivationRepair(
  admin: AdminClient,
  deadline?: AccountReactivationDeadline,
): Promise<LegacyAccountReactivationRepairOutcome> {
  const claim = await beforeDeadline(
    deadline,
    () => requireSupabaseSuccess(
      "account.reactivation.legacy_repair.claim",
      () =>
        admin.rpc("claim_account_reactivation_legacy_repair", {
          p_lease_seconds: REACTIVATION_LEASE_SECONDS,
        }),
    ),
  );
  const lease = parseLegacyAccountReactivationRepairClaim(claim.data);
  if (!lease) return { kind: "idle" };
  if (lease.status === "superseded") {
    return {
      kind: "superseded",
      jobId: lease.jobId,
      userId: lease.userId,
    };
  }

  const recordLegacyRetry = async (
    failure: string,
  ): Promise<LegacyAccountReactivationRepairOutcome> => {
    try {
      await finishLegacyAccountReactivationRepair(
        admin,
        lease,
        { success: false, error: failure },
        deadline,
      );
      return {
        kind: "pending",
        jobId: lease.jobId,
        userId: lease.userId,
        failure,
        retryRecorded: true,
      };
    } catch {
      return {
        kind: "pending",
        jobId: lease.jobId,
        userId: lease.userId,
        failure,
        retryRecorded: false,
      };
    }
  };

  if (lease.preflightError) {
    return recordLegacyRetry(lease.preflightError);
  }
  try {
    await ensureLegacyRepairAuthEmail(admin, lease, deadline);
  } catch (error) {
    const failure = failureCode(error);
    if (failure === "reactivation_deadline_exceeded") {
      return {
        kind: "pending",
        jobId: lease.jobId,
        userId: lease.userId,
        failure,
        retryRecorded: false,
      };
    }
    return recordLegacyRetry(failure);
  }

  try {
    const status = await finishLegacyAccountReactivationRepair(
      admin,
      lease,
      { success: true },
      deadline,
    );
    if (status === "pending") {
      throw new AccountReactivationFailure(
        "invalid_legacy_repair_success_status",
      );
    }
    return {
      kind: status,
      jobId: lease.jobId,
      userId: lease.userId,
    };
  } catch (error) {
    try {
      const status = await getLegacyAccountReactivationRepairStatus(
        admin,
        lease,
        deadline,
      );
      if (status === "completed" || status === "superseded") {
        return {
          kind: status,
          jobId: lease.jobId,
          userId: lease.userId,
        };
      }
    } catch {
      // A status read is only recovery evidence. The exact immutable job
      // remains retryable when it cannot prove a terminal durable state.
    }
    const failure = failureCode(error);
    if (failure === "reactivation_deadline_exceeded") {
      return {
        kind: "pending",
        jobId: lease.jobId,
        userId: lease.userId,
        failure,
        retryRecorded: false,
      };
    }
    return recordLegacyRetry(failure);
  }
}

async function getRetryBacklog(
  admin: AdminClient,
  deadline?: AccountReactivationDeadline,
): Promise<{
  count: number;
  sample: AccountReactivationDrainResult["backlogSample"];
}> {
  const value = await beforeDeadline(
    deadline,
    () => requireSupabaseData(
      "account.reactivation.queue_health",
      () => admin.rpc("get_account_reactivation_queue_health"),
    ),
  );
  const row = record(value);
  if (row.ok !== true) {
    throw new AccountReactivationFailure(
      "invalid_reactivation_queue_health",
    );
  }
  const currentCount = safeInteger(
    row.retry_pending,
    "retry_pending",
  );
  const legacyCount = safeInteger(
    row.legacy_repair_pending,
    "legacy_repair_pending",
  );
  const count = currentCount + legacyCount;
  const candidates: NonNullable<
    AccountReactivationDrainResult["backlogSample"]
  >[] = [];
  if (row.oldest_pending === null) {
    if (currentCount !== 0) {
      throw new AccountReactivationFailure(
        "missing_reactivation_backlog_sample",
      );
    }
  } else {
    const sample = record(row.oldest_pending);
    if (
      currentCount === 0 ||
      (sample.status !== "pending" && sample.status !== "leased") ||
      !(
        sample.last_error === null ||
        (
          typeof sample.last_error === "string" &&
          sample.last_error.length >= 1 &&
          sample.last_error.length <= 500
        )
      )
    ) {
      throw new AccountReactivationFailure(
        "invalid_reactivation_backlog_sample",
      );
    }
    candidates.push({
      requestId: uuid(sample.request_id, "backlog_request_id"),
      userId: uuid(sample.user_id, "backlog_user_id"),
      status: sample.status,
      lastError: sample.last_error as string | null,
      retryAt: timestamp(sample.retry_at, "backlog_retry_at"),
    });
  }
  if (row.oldest_legacy_repair === null) {
    if (legacyCount !== 0) {
      throw new AccountReactivationFailure(
        "missing_legacy_repair_backlog_sample",
      );
    }
  } else {
    const sample = record(row.oldest_legacy_repair);
    if (
      legacyCount === 0 ||
      (sample.status !== "pending" && sample.status !== "leased") ||
      !(
        sample.last_error === null ||
        (
          typeof sample.last_error === "string" &&
          sample.last_error.length >= 1 &&
          sample.last_error.length <= 500
        )
      )
    ) {
      throw new AccountReactivationFailure(
        "invalid_legacy_repair_backlog_sample",
      );
    }
    candidates.push({
      requestId: uuid(
        sample.job_id,
        "legacy_repair_backlog_job_id",
      ),
      userId: uuid(
        sample.user_id,
        "legacy_repair_backlog_user_id",
      ),
      status: sample.status,
      lastError: sample.last_error as string | null,
      retryAt: timestamp(
        sample.retry_at,
        "legacy_repair_backlog_retry_at",
      ),
    });
  }
  candidates.sort(
    (left, right) =>
      Date.parse(left.retryAt) - Date.parse(right.retryAt) ||
      left.requestId.localeCompare(right.requestId),
  );
  return { count, sample: candidates[0] ?? null };
}

export async function drainAccountReactivationJobs(
  admin: AdminClient,
  limit = 10,
  options?: { maxDurationMs?: number },
): Promise<AccountReactivationDrainResult> {
  const result: AccountReactivationDrainResult = {
    claimed: 0,
    completed: 0,
    pending: 0,
    retryBacklog: 0,
    claimErrors: 0,
    healthErrors: 0,
    failures: [],
    claimFailures: [],
    backlogSample: null,
  };
  const requestedDuration = options?.maxDurationMs;
  const deadline =
    requestedDuration === undefined
      ? undefined
      : createAccountReactivationDeadline(requestedDuration);
  const requested = Number.isFinite(limit) ? Math.trunc(limit) : 10;
  const bounded = Math.max(1, Math.min(requested, 50));
  for (let index = 0; index < bounded; index += 1) {
    let legacy: LegacyAccountReactivationRepairOutcome;
    try {
      legacy = await processLegacyAccountReactivationRepair(
        admin,
        deadline,
      );
    } catch (error) {
      result.claimErrors += 1;
      result.claimFailures.push(failureCode(error));
      break;
    }
    if (legacy.kind !== "idle") {
      result.claimed += 1;
      if (legacy.kind === "pending") {
        result.pending += 1;
        result.failures.push({
          requestId: legacy.jobId,
          userId: legacy.userId,
          failure: legacy.failure,
          retryRecorded: legacy.retryRecorded,
        });
      } else {
        result.completed += 1;
      }
      if (
        deadline &&
        performance.now() >= deadline.monotonicDeadlineMs
      ) {
        break;
      }
      continue;
    }

    let outcome: AccountReactivationOutcome;
    try {
      outcome = await processAccountReactivationJob(
        admin,
        undefined,
        deadline,
      );
    } catch (error) {
      result.claimErrors += 1;
      result.claimFailures.push(failureCode(error));
      break;
    }
    if (outcome.kind === "idle") break;
    result.claimed += 1;
    if (
      outcome.kind === "completed" ||
      outcome.kind === "cancelled"
    ) result.completed += 1;
    else {
      result.pending += 1;
      result.failures.push({
        requestId: outcome.requestId,
        userId: outcome.userId,
        failure: outcome.failure,
        retryRecorded: outcome.retryRecorded,
      });
    }
    if (
      deadline &&
      performance.now() >= deadline.monotonicDeadlineMs
    ) {
      break;
    }
  }
  try {
    const health = await getRetryBacklog(admin, deadline);
    result.retryBacklog = health.count;
    result.backlogSample = health.sample;
  } catch {
    result.healthErrors += 1;
  }
  return result;
}
