const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ReviewerMutationAction =
  | "provision"
  | "set_active"
  | "reset_password"
  | "delete";

export type ReviewerPendingError =
  | "create_pending"
  | "sync_pending"
  | "reset_pending"
  | "delete_pending";

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

export type ReviewerMutationSuccess = {
  userId: string;
  credentialResetRequired: boolean;
  password?: string;
};

export function parseReviewerMutationSuccess(
  value: unknown,
  expected: {
    action: ReviewerMutationAction;
    userId?: string;
  },
): ReviewerMutationSuccess | null {
  const row = record(value);
  const hasPassword = typeof row?.password === "string";
  if (
    !row ||
    !exactKeys(
      row,
      hasPassword
        ? ["ok", "userId", "password", "credentialResetRequired"]
        : ["ok", "userId", "credentialResetRequired"],
    ) ||
    row.ok !== true ||
    typeof row.userId !== "string" ||
    !UUID_RE.test(row.userId) ||
    (expected.userId !== undefined && row.userId !== expected.userId) ||
    typeof row.credentialResetRequired !== "boolean"
  ) {
    return null;
  }
  const needsCredential =
    expected.action === "provision" ||
    expected.action === "reset_password";
  if (
    needsCredential
      ? hasPassword === row.credentialResetRequired
      : hasPassword || row.credentialResetRequired
  ) {
    return null;
  }
  if (
    hasPassword &&
    ((row.password as string).length < 16 ||
      (row.password as string).length > 128 ||
      /\s/.test(row.password as string))
  ) {
    return null;
  }
  return {
    userId: row.userId,
    credentialResetRequired: row.credentialResetRequired,
    ...(hasPassword ? { password: row.password as string } : {}),
  };
}

export function parseReviewerPendingAck(
  value: unknown,
  expectedError: ReviewerPendingError,
): { error: ReviewerPendingError; jobId: string } | null {
  const row = record(value);
  if (
    !row ||
    !exactKeys(row, ["ok", "error", "jobId"]) ||
    row.ok !== false ||
    row.error !== expectedError ||
    typeof row.jobId !== "string" ||
    !UUID_RE.test(row.jobId)
  ) {
    return null;
  }
  return { error: expectedError, jobId: row.jobId };
}

export function reviewerHttpError(value: unknown): string | null {
  const row = record(value);
  return row &&
    typeof row.error === "string" &&
    row.error.length > 0 &&
    row.error.length <= 100 &&
    /^[a-z0-9_]+$/.test(row.error)
    ? row.error
    : null;
}
