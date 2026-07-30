/** Bounded score/report convergence retry schedule (failed attempt is 1-based). */
export const SCORE_SUBMISSION_MAX_AUTO_ATTEMPTS = 4;

export type ScoreSubmissionIdentity = {
  startedAt: number;
  submissionId: string;
};

const SCORE_SUBMISSION_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** PostgreSQL migration 0074 accepts exactly the same RFC 4122 UUID shape. */
export function isScoreSubmissionId(value: unknown): value is string {
  return typeof value === "string" && SCORE_SUBMISSION_UUID_RE.test(value);
}

/**
 * A performance timestamp of zero is valid. Truthiness checks would erase the
 * first millisecond of the mathematical domain and produce a false 0 duration.
 */
export function elapsedScoreDurationMs(
  startedAt: number,
  endedAt: number | null,
): number {
  if (
    !Number.isFinite(startedAt) ||
    typeof endedAt !== "number" ||
    !Number.isFinite(endedAt) ||
    endedAt <= startedAt
  ) {
    return 0;
  }
  return endedAt - startedAt;
}

/** Same game retains its key; a changed startedAt mints exactly one new key. */
export function scoreSubmissionIdentityForGame(
  current: ScoreSubmissionIdentity | null,
  startedAt: number,
  mint: () => string,
  forceNew = false,
): ScoreSubmissionIdentity {
  return !forceNew && current?.startedAt === startedAt
    ? current
    : { startedAt, submissionId: mint() };
}

export function scoreSubmissionRetryDelayMs(
  failedAttempt: number,
): number | null {
  if (!Number.isSafeInteger(failedAttempt) || failedAttempt < 1) return null;
  const delays = [1_000, 2_000, 4_000] as const;
  return delays[failedAttempt - 1] ?? null;
}
