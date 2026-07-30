import { randomBytes } from "node:crypto";
import type { User } from "@supabase/supabase-js";
import type { createAdminClient } from "./supabase/admin.ts";
import {
  requireSupabaseData,
  requireSupabaseSuccess,
  SupabaseOperationError,
} from "./supabase-operation.ts";

type AdminClient = ReturnType<typeof createAdminClient>;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const BAN_FOREVER = "876000h";
const AUTH_PAGE_SIZE = 1_000;
const PW_ALPHABET =
  "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789";

export type ReviewerJobAction =
  | "provision"
  | "set_active"
  | "reset_password"
  | "delete";

export type ReviewerJobStart = {
  jobId: string;
  action: ReviewerJobAction;
  status: "pending" | "leased" | "completed" | "failed";
  userId: string | null;
  replayed: boolean;
};

type ReviewerJobLease = {
  jobId: string;
  operationId: string;
  action: ReviewerJobAction;
  userId: string | null;
  email: string;
  desiredActive: boolean | null;
  leaseToken: string;
  leaseVersion: number;
  attemptCount: number;
};

export type ReviewerJobOutcome =
  | { kind: "idle" }
  | {
      kind: "completed";
      jobId: string;
      action: ReviewerJobAction;
      userId: string;
      attemptCount: number;
      issuedPassword?: string;
    }
  | {
      kind: "pending" | "failed";
      jobId: string;
      action: ReviewerJobAction;
      attemptCount: number;
      failure: string;
      retryRecorded: boolean;
    };

export type ReviewerJobDrainResult = {
  claimed: number;
  completed: number;
  pending: number;
  failed: number;
  claimErrors: number;
};

export function reviewerCredentialResetRequired(
  action: ReviewerJobAction,
  issuedPassword?: string,
): boolean {
  return (
    (action === "provision" || action === "reset_password") &&
    !issuedPassword
  );
}

class ReviewerSagaFailure extends Error {
  readonly code: string;
  readonly terminal: boolean;

  constructor(code: string, terminal = false) {
    super(code);
    this.name = "ReviewerSagaFailure";
    this.code = code;
    this.terminal = terminal;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ReviewerSagaFailure("invalid_rpc_response");
  }
  return value as Record<string, unknown>;
}

function uuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_RE.test(value)) {
    throw new ReviewerSagaFailure(`invalid_${field}`);
  }
  return value;
}

function safeInteger(value: unknown, field: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new ReviewerSagaFailure(`invalid_${field}`);
  }
  return value as number;
}

export function parseReviewerJobStart(value: unknown): ReviewerJobStart {
  const row = record(value);
  if (
    row.ok !== true ||
    (row.action !== "provision" &&
      row.action !== "set_active" &&
      row.action !== "reset_password" &&
      row.action !== "delete") ||
    (row.status !== "pending" &&
      row.status !== "leased" &&
      row.status !== "completed" &&
      row.status !== "failed") ||
    typeof row.replayed !== "boolean"
  ) {
    throw new ReviewerSagaFailure("invalid_job_start");
  }
  const userId =
    row.user_id === null ? null : uuid(row.user_id, "job_start_user_id");
  if (
    (row.status === "completed" && userId === null) ||
    (row.action !== "provision" && userId === null)
  ) {
    throw new ReviewerSagaFailure("job_start_user_missing");
  }
  return {
    jobId: uuid(row.job_id, "job_id"),
    action: row.action,
    status: row.status,
    userId,
    replayed: row.replayed,
  };
}

function parseLease(value: unknown): ReviewerJobLease | null {
  if (value === null) return null;
  const row = record(value);
  if (
    row.action !== "provision" &&
    row.action !== "set_active" &&
    row.action !== "reset_password" &&
    row.action !== "delete"
  ) {
    throw new ReviewerSagaFailure("invalid_job_action");
  }
  if (
    typeof row.email !== "string" ||
    row.email.length < 3 ||
    row.email.length > 320 ||
    row.email !== row.email.trim().toLowerCase()
  ) {
    throw new ReviewerSagaFailure("invalid_job_email");
  }
  if (
    row.desired_active !== null &&
    typeof row.desired_active !== "boolean"
  ) {
    throw new ReviewerSagaFailure("invalid_job_desired_active");
  }
  if (
    (row.action === "set_active" &&
      typeof row.desired_active !== "boolean") ||
    (row.action !== "set_active" && row.desired_active !== null)
  ) {
    throw new ReviewerSagaFailure("invalid_job_action_shape");
  }
  const userId =
    row.user_id === null ? null : uuid(row.user_id, "user_id");
  if (row.action !== "provision" && userId === null) {
    throw new ReviewerSagaFailure("missing_job_user_id");
  }
  return {
    jobId: uuid(row.job_id, "job_id"),
    operationId: uuid(row.operation_id, "operation_id"),
    action: row.action,
    userId,
    email: row.email,
    desiredActive: row.desired_active as boolean | null,
    leaseToken: uuid(row.lease_token, "lease_token"),
    leaseVersion: safeInteger(row.lease_version, "lease_version", 1),
    attemptCount: safeInteger(row.attempt_count, "attempt_count", 1),
  };
}

export function generateReviewerPassword(length = 16): string {
  const requested = Number.isFinite(length) ? Math.trunc(length) : 16;
  const boundedLength = Math.max(16, Math.min(requested, 128));
  const unbiasedLimit =
    256 - (256 % PW_ALPHABET.length);
  let password = "";
  while (password.length < boundedLength) {
    const bytes = randomBytes(boundedLength - password.length);
    for (const byte of bytes) {
      if (byte >= unbiasedLimit) continue;
      password += PW_ALPHABET[byte % PW_ALPHABET.length];
      if (password.length === boundedLength) break;
    }
  }
  return password;
}

function isReviewerManagedAuthUser(
  user: User,
  expectedEmail: string,
  expectedJobId: string,
): boolean {
  return (
    user.email?.trim().toLowerCase() === expectedEmail &&
    user.app_metadata?.reviewer === true &&
    user.app_metadata?.reviewer_job_id === expectedJobId
  );
}

async function getAuthUserById(
  admin: AdminClient,
  userId: string,
): Promise<User> {
  const result = await requireSupabaseSuccess(
    "reviewer.auth.get_by_id",
    () => admin.auth.admin.getUserById(userId),
  );
  if (!result.data?.user) {
    throw new ReviewerSagaFailure("auth_user_missing", true);
  }
  if (result.data.user.id !== userId) {
    throw new ReviewerSagaFailure("invalid_auth_get_response");
  }
  return result.data.user;
}

/**
 * GoTrue has no get-by-email admin endpoint. Traverse every page and reject a
 * repeated/malformed page rather than interpreting a partial listing as
 * absence and attempting a duplicate create.
 */
async function findAuthUserByEmail(
  admin: AdminClient,
  email: string,
): Promise<User | null> {
  let page = 1;
  const seenIds = new Set<string>();
  while (true) {
    const result = await requireSupabaseSuccess(
      `reviewer.auth.list[page=${page}]`,
      () => admin.auth.admin.listUsers({ page, perPage: AUTH_PAGE_SIZE }),
    );
    const users = result.data?.users;
    if (!Array.isArray(users)) {
      throw new ReviewerSagaFailure("invalid_auth_user_page");
    }
    for (const user of users) {
      if (
        !user ||
        typeof user.id !== "string" ||
        !UUID_RE.test(user.id) ||
        seenIds.has(user.id)
      ) {
        throw new ReviewerSagaFailure("invalid_or_repeated_auth_user_page");
      }
      seenIds.add(user.id);
      if (user.email?.trim().toLowerCase() === email) return user;
    }
    if (users.length < AUTH_PAGE_SIZE) return null;
    page += 1;
  }
}

async function ensureProvisionAuthUser(
  admin: AdminClient,
  lease: ReviewerJobLease,
): Promise<{ user: User; issuedPassword?: string }> {
  if (lease.userId) {
    const user = await getAuthUserById(admin, lease.userId);
    if (!isReviewerManagedAuthUser(user, lease.email, lease.jobId)) {
      throw new ReviewerSagaFailure("auth_identity_conflict", true);
    }
    return { user };
  }

  const existing = await findAuthUserByEmail(admin, lease.email);
  if (existing) {
    if (!isReviewerManagedAuthUser(existing, lease.email, lease.jobId)) {
      throw new ReviewerSagaFailure("auth_email_conflict", true);
    }
    return { user: existing };
  }

  const password = generateReviewerPassword();
  let createResult;
  try {
    createResult = await admin.auth.admin.createUser({
      email: lease.email,
      password,
      email_confirm: true,
      app_metadata: {
        reviewer: true,
        reviewer_job_id: lease.jobId,
      },
    });
  } catch (error) {
    throw new ReviewerSagaFailure(
      error instanceof Error ? "auth_create_threw" : "auth_create_failed",
    );
  }
  if (createResult.error || !createResult.data?.user) {
    // A timeout/duplicate response can hide a committed create. Rediscover by
    // email before deciding this attempt failed.
    const recovered = await findAuthUserByEmail(admin, lease.email);
    if (recovered) {
      if (!isReviewerManagedAuthUser(recovered, lease.email, lease.jobId)) {
        throw new ReviewerSagaFailure("auth_email_conflict", true);
      }
      return { user: recovered };
    }
    throw new ReviewerSagaFailure("auth_create_failed");
  }
  if (
    !UUID_RE.test(createResult.data.user.id) ||
    !isReviewerManagedAuthUser(
      createResult.data.user,
      lease.email,
      lease.jobId,
    )
  ) {
    throw new ReviewerSagaFailure("auth_create_response_invalid");
  }
  return { user: createResult.data.user, issuedPassword: password };
}

async function recordProvisionIdentity(
  admin: AdminClient,
  lease: ReviewerJobLease,
  userId: string,
): Promise<void> {
  const value = await requireSupabaseData(
    "reviewer.provision.record_auth",
    () =>
      admin.rpc("record_reviewer_provision_auth", {
        p_job_id: lease.jobId,
        p_lease_token: lease.leaseToken,
        p_lease_version: lease.leaseVersion,
        p_user_id: userId,
      }),
  );
  const row = record(value);
  if (
    row.ok !== true ||
    uuid(row.job_id, "recorded_job_id") !== lease.jobId ||
    uuid(row.user_id, "recorded_user_id") !== userId
  ) {
    throw new ReviewerSagaFailure("invalid_provision_checkpoint");
  }
}

async function finalizeProvision(
  admin: AdminClient,
  lease: ReviewerJobLease,
): Promise<string> {
  const value = await requireSupabaseData(
    "reviewer.provision.finalize",
    () =>
      admin.rpc("finalize_reviewer_provision", {
        p_job_id: lease.jobId,
        p_lease_token: lease.leaseToken,
        p_lease_version: lease.leaseVersion,
      }),
  );
  const row = record(value);
  if (
    row.ok !== true ||
    row.status !== "completed" ||
    uuid(row.job_id, "finalized_job_id") !== lease.jobId
  ) {
    throw new ReviewerSagaFailure("invalid_provision_finalize");
  }
  return uuid(row.user_id, "finalized_user_id");
}

async function syncAuthBanState(
  admin: AdminClient,
  lease: ReviewerJobLease,
): Promise<string> {
  if (!lease.userId) {
    throw new ReviewerSagaFailure("sync_user_missing", true);
  }
  const shouldBeActive =
    lease.action === "set_active" && lease.desiredActive === true;
  const result = await requireSupabaseSuccess(
    "reviewer.auth.sync_ban",
    () =>
      admin.auth.admin.updateUserById(lease.userId!, {
        ban_duration: shouldBeActive ? "none" : BAN_FOREVER,
      }),
  );
  const user = result.data?.user;
  if (!user || user.id !== lease.userId) {
    throw new ReviewerSagaFailure("invalid_auth_sync_response");
  }
  const bannedUntil =
    typeof user.banned_until === "string"
      ? Date.parse(user.banned_until)
      : Number.NaN;
  if (shouldBeActive) {
    if (Number.isFinite(bannedUntil) && bannedUntil > Date.now()) {
      throw new ReviewerSagaFailure("auth_unban_not_observed");
    }
  } else if (!Number.isFinite(bannedUntil) || bannedUntil <= Date.now()) {
    throw new ReviewerSagaFailure("auth_ban_not_observed");
  }
  return user.id;
}

async function syncReviewerPassword(
  admin: AdminClient,
  lease: ReviewerJobLease,
): Promise<{ userId: string; issuedPassword: string }> {
  if (!lease.userId) {
    throw new ReviewerSagaFailure("password_user_missing", true);
  }
  const password = generateReviewerPassword();
  const result = await requireSupabaseSuccess(
    "reviewer.auth.reset_password",
    () =>
      admin.auth.admin.updateUserById(lease.userId!, {
        password,
      }),
  );
  if (!result.data?.user || result.data.user.id !== lease.userId) {
    throw new ReviewerSagaFailure("invalid_password_reset_response");
  }
  return { userId: result.data.user.id, issuedPassword: password };
}

async function finishJob(
  admin: AdminClient,
  lease: ReviewerJobLease,
  options:
    | { success: true }
    | { success: false; terminal: boolean; error: string },
): Promise<"completed" | "pending" | "failed"> {
  const value = await requireSupabaseData("reviewer.job.finish", () =>
    admin.rpc("finish_reviewer_account_job", {
      p_job_id: lease.jobId,
      p_lease_token: lease.leaseToken,
      p_lease_version: lease.leaseVersion,
      p_success: options.success,
      p_terminal: options.success ? false : options.terminal,
      p_error: options.success ? null : options.error.slice(0, 500),
    }),
  );
  const row = record(value);
  const status = row.status;
  if (
    row.ok !== true ||
    uuid(row.job_id, "finished_job_id") !== lease.jobId ||
    (status !== "completed" &&
      status !== "pending" &&
      status !== "failed")
  ) {
    throw new ReviewerSagaFailure("invalid_job_finish");
  }
  return status;
}

function failureDetails(error: unknown): {
  code: string;
  terminal: boolean;
} {
  if (error instanceof ReviewerSagaFailure) {
    return { code: error.code, terminal: error.terminal };
  }
  if (
    error &&
    typeof error === "object" &&
    "operation" in error &&
    typeof (error as { operation?: unknown }).operation === "string"
  ) {
    return {
      code: (error as { operation: string }).operation,
      terminal: false,
    };
  }
  return {
    code: error instanceof Error ? error.name : "unknown_reviewer_failure",
    terminal: false,
  };
}

export async function processReviewerAccountJob(
  admin: AdminClient,
  jobId?: string,
): Promise<ReviewerJobOutcome> {
  const claim = await requireSupabaseSuccess("reviewer.job.claim", () =>
    admin.rpc("claim_reviewer_account_job", {
      p_job_id: jobId ?? null,
      p_lease_seconds: 120,
    }),
  );
  const lease = parseLease(claim.data);
  if (!lease) return { kind: "idle" };
  if (jobId && lease.jobId !== jobId) {
    throw new ReviewerSagaFailure("reviewer_job_mismatch");
  }

  try {
    if (lease.action === "provision") {
      const auth = await ensureProvisionAuthUser(admin, lease);
      await recordProvisionIdentity(admin, lease, auth.user.id);
      const userId = await finalizeProvision(admin, lease);
      return {
        kind: "completed",
        jobId: lease.jobId,
        action: lease.action,
        userId,
        attemptCount: lease.attemptCount,
        ...(auth.issuedPassword
          ? { issuedPassword: auth.issuedPassword }
          : {}),
      };
    }

    if (lease.action === "reset_password") {
      const auth = await syncReviewerPassword(admin, lease);
      await finishJob(admin, lease, { success: true });
      return {
        kind: "completed",
        jobId: lease.jobId,
        action: lease.action,
        userId: auth.userId,
        attemptCount: lease.attemptCount,
        issuedPassword: auth.issuedPassword,
      };
    }

    const userId = await syncAuthBanState(admin, lease);
    await finishJob(admin, lease, { success: true });
    return {
      kind: "completed",
      jobId: lease.jobId,
      action: lease.action,
      userId,
      attemptCount: lease.attemptCount,
    };
  } catch (error) {
    const failure = failureDetails(error);
    try {
      const status = await finishJob(admin, lease, {
        success: false,
        terminal: failure.terminal,
        error: failure.code,
      });
      return {
        kind: status === "failed" ? "failed" : "pending",
        jobId: lease.jobId,
        action: lease.action,
        attemptCount: lease.attemptCount,
        failure: failure.code,
        retryRecorded: true,
      };
    } catch {
      // A successful external operation with a lost finish response is safe:
      // the fenced lease expires and the idempotent Auth mutation is retried.
      return {
        kind: "pending",
        jobId: lease.jobId,
        action: lease.action,
        attemptCount: lease.attemptCount,
        failure: failure.code,
        retryRecorded: false,
      };
    }
  }
}

export async function drainReviewerAccountJobs(
  admin: AdminClient,
  limit = 10,
): Promise<ReviewerJobDrainResult> {
  const result: ReviewerJobDrainResult = {
    claimed: 0,
    completed: 0,
    pending: 0,
    failed: 0,
    claimErrors: 0,
  };
  const bounded = Math.max(1, Math.min(Math.trunc(limit), 50));
  for (let index = 0; index < bounded; index += 1) {
    let outcome: ReviewerJobOutcome;
    try {
      outcome = await processReviewerAccountJob(admin);
    } catch (error) {
      result.claimErrors += 1;
      if (error instanceof SupabaseOperationError) break;
      continue;
    }
    if (outcome.kind === "idle") break;
    result.claimed += 1;
    if (outcome.kind === "completed") result.completed += 1;
    else if (outcome.kind === "failed") result.failed += 1;
    else result.pending += 1;
  }
  return result;
}
