import { resolveConsentMutation } from "@/lib/auth-read-policy";

export const CONSENT_WITH_PROFILE_RPC =
  "public.create_or_update_member_consent_with_profile";

type MutationCall = () => PromiseLike<{
  data: unknown;
  error: unknown | null;
}>;

export type ConsentOnboardMutation =
  | {
      ok: true;
      isNew: boolean;
      mode: "atomic" | "legacy";
    }
  | {
      ok: false;
      error: unknown;
      phase: "atomic" | "legacy_consent" | "legacy_profile_sync" | "legacy_verify";
      legacyCommitted: boolean;
    };

type DbResult<T> = {
  data: T | null;
  error: unknown | null;
};

export type LegacyProfileRow = {
  id: string;
  deleted_at: string | null;
  display_name: string | null;
  avatar_url: string | null;
};

export type LegacyMemberEmailRow = {
  user_id: string;
  email: string | null;
};

export type LegacyOAuthProfile = {
  displayName: string | null;
  avatarUrl: string | null;
  email: string;
};

export type LegacyOAuthSyncOperations = {
  /**
   * Applies the non-null OAuth profile fields only while deleted_at is null,
   * and returns the affected row (or reads the active row when there is no
   * profile field to write).
   */
  writeActiveProfile: () => PromiseLike<DbResult<LegacyProfileRow>>;
  writeMemberEmail: () => PromiseLike<DbResult<LegacyMemberEmailRow>>;
  readProfile: () => PromiseLike<DbResult<LegacyProfileRow>>;
  readMemberEmail: () => PromiseLike<DbResult<LegacyMemberEmailRow>>;
  /**
   * Conservative compensation for an ambiguous email write or a deletion
   * observed after it. A missing member row is also a safe scrubbed state.
   */
  scrubMemberEmail: () => PromiseLike<DbResult<LegacyMemberEmailRow>>;
};

export class ConsentCompatibilityError extends Error {
  readonly operationError: unknown;
  readonly cleanupError: unknown | null;

  constructor(
    code: string,
    operationError: unknown,
    cleanupError: unknown | null = null,
  ) {
    const detail = errorMessage(operationError);
    const cleanupDetail =
      cleanupError == null ? "" : `; cleanup=${errorMessage(cleanupError)}`;
    super(`${code}${detail ? `: ${detail}` : ""}${cleanupDetail}`);
    this.name = "ConsentCompatibilityError";
    this.operationError = operationError;
    this.cleanupError = cleanupError;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(error ?? "");
}

/**
 * App-first rollout fallback is deliberately narrower than a generic schema
 * error check. Only PostgREST PGRST202 naming this exact public function may
 * activate the legacy, non-atomic compatibility path.
 */
export function isMissingConsentWithProfileRpcError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const shape = error as { code?: unknown; message?: unknown };
  return (
    shape.code === "PGRST202" &&
    typeof shape.message === "string" &&
    shape.message.includes(`${CONSENT_WITH_PROFILE_RPC}(`)
  );
}

function profileStateError(
  row: LegacyProfileRow | null,
  userId: string,
  expected: LegacyOAuthProfile,
): Error | null {
  if (row === null || row.id !== userId || row.deleted_at !== null) {
    return new Error("invalid_account");
  }
  if (
    expected.displayName !== null &&
    row.display_name !== expected.displayName
  ) {
    return new Error("legacy_profile_display_name_mismatch");
  }
  if (expected.avatarUrl !== null && row.avatar_url !== expected.avatarUrl) {
    return new Error("legacy_profile_avatar_url_mismatch");
  }
  return null;
}

function memberEmailStateError(
  row: LegacyMemberEmailRow | null,
  userId: string,
  expectedEmail: string,
): Error | null {
  if (row === null || row.user_id !== userId) {
    return new Error("member_not_found");
  }
  if (row.email !== expectedEmail) {
    return new Error("legacy_member_email_mismatch");
  }
  return null;
}

async function resolveDbOperation<T>(
  operation: () => PromiseLike<DbResult<T>>,
): Promise<DbResult<T>> {
  try {
    const result = await operation();
    if (
      !result ||
      typeof result !== "object" ||
      !("data" in result) ||
      !("error" in result)
    ) {
      return {
        data: null,
        error: new Error("invalid_legacy_sync_db_response"),
      };
    }
    return result;
  } catch (error) {
    return { data: null, error };
  }
}

function resultError<T>(
  result: DbResult<T>,
  validate: (data: T | null) => Error | null,
): unknown | null {
  if (result.error != null) return result.error;
  return validate(result.data);
}

async function scrubAfterAmbiguousEmailWrite(
  operations: LegacyOAuthSyncOperations,
  userId: string,
): Promise<unknown | null> {
  const cleanup = await resolveDbOperation(operations.scrubMemberEmail);
  if (cleanup.error != null) return cleanup.error;
  if (
    cleanup.data !== null &&
    (cleanup.data.user_id !== userId || cleanup.data.email !== null)
  ) {
    return new Error("legacy_member_email_scrub_postcondition_failed");
  }
  return null;
}

/**
 * Compatibility-only profile/email sync for databases predating the atomic
 * RPC. The final active-profile read is intentionally after the email write:
 *
 * - deletion before the guarded profile write => no row, no email write
 * - deletion before/during the email write => final read observes deletion and
 *   the email is conservatively scrubbed
 * - deletion after final verification => the deletion transaction scrubs the
 *   values written before it
 *
 * Any ambiguous write/read failure after the email stage also triggers the
 * scrub compensation. Callers must keep the onboarding retry cookie on error.
 */
export async function syncLegacyOAuthProfileStrict(
  operations: LegacyOAuthSyncOperations,
  userId: string,
  expected: LegacyOAuthProfile,
): Promise<void> {
  const profileWrite = await resolveDbOperation(operations.writeActiveProfile);
  const profileWriteError = resultError(profileWrite, (row) =>
    profileStateError(row, userId, expected),
  );
  if (profileWriteError != null) {
    throw new ConsentCompatibilityError(
      "legacy_profile_write_failed",
      profileWriteError,
    );
  }

  const emailWrite = await resolveDbOperation(operations.writeMemberEmail);
  const emailWriteError = resultError(emailWrite, (row) =>
    memberEmailStateError(row, userId, expected.email),
  );
  if (emailWriteError != null) {
    const cleanupError = await scrubAfterAmbiguousEmailWrite(
      operations,
      userId,
    );
    throw new ConsentCompatibilityError(
      "legacy_email_write_failed",
      emailWriteError,
      cleanupError,
    );
  }

  const profileRead = await resolveDbOperation(operations.readProfile);
  const profileReadError = resultError(profileRead, (row) =>
    profileStateError(row, userId, expected),
  );
  if (profileReadError != null) {
    const cleanupError = await scrubAfterAmbiguousEmailWrite(
      operations,
      userId,
    );
    throw new ConsentCompatibilityError(
      "legacy_profile_verify_failed",
      profileReadError,
      cleanupError,
    );
  }

  const memberRead = await resolveDbOperation(operations.readMemberEmail);
  const memberReadError = resultError(memberRead, (row) =>
    memberEmailStateError(row, userId, expected.email),
  );
  if (memberReadError != null) {
    const cleanupError = await scrubAfterAmbiguousEmailWrite(
      operations,
      userId,
    );
    throw new ConsentCompatibilityError(
      "legacy_email_verify_failed",
      memberReadError,
      cleanupError,
    );
  }
}

/**
 * Runs the modern atomic mutation first. A legacy mutation is allowed only for
 * the exact rollout error above, and its success is not terminal until strict
 * profile/email synchronization and a caller-provided consent/lifecycle
 * postcondition both succeed.
 */
export async function runConsentOnboardMutation(input: {
  atomic: MutationCall;
  legacy: MutationCall;
  syncLegacyProfile: () => PromiseLike<void>;
  verifyLegacyCommit: () => PromiseLike<void>;
}): Promise<ConsentOnboardMutation> {
  const atomic = await resolveConsentMutation(input.atomic);
  if (atomic.ok) {
    return { ...atomic, mode: "atomic" };
  }
  if (!isMissingConsentWithProfileRpcError(atomic.error)) {
    return {
      ok: false,
      error: atomic.error,
      phase: "atomic",
      legacyCommitted: false,
    };
  }

  const legacy = await resolveConsentMutation(input.legacy);
  if (!legacy.ok) {
    return {
      ok: false,
      error: legacy.error,
      phase: "legacy_consent",
      legacyCommitted: false,
    };
  }

  try {
    await input.syncLegacyProfile();
  } catch (error) {
    return {
      ok: false,
      error,
      phase: "legacy_profile_sync",
      legacyCommitted: true,
    };
  }

  try {
    await input.verifyLegacyCommit();
  } catch (error) {
    return {
      ok: false,
      error,
      phase: "legacy_verify",
      legacyCommitted: true,
    };
  }

  return { ok: true, isNew: legacy.isNew, mode: "legacy" };
}
