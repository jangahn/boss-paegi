export type ReviewerStatus =
  | { ok: true; isReviewer: boolean }
  | { ok: false; error: unknown };

export function resolveReviewerAccountRead(result: {
  data: { active?: unknown; auth_sync_pending?: unknown } | null;
  error?: unknown;
}): ReviewerStatus {
  if (result.error !== null && result.error !== undefined) {
    return { ok: false, error: result.error };
  }
  if (result.data === null) return { ok: true, isReviewer: false };
  if (typeof result.data.active !== "boolean") {
    return {
      ok: false,
      error: new Error("reviewer_active_missing_or_invalid"),
    };
  }
  if (typeof result.data.auth_sync_pending !== "boolean") {
    return {
      ok: false,
      error: new Error("reviewer_auth_sync_pending_missing_or_invalid"),
    };
  }
  if (result.data.auth_sync_pending) {
    return {
      ok: false,
      error: new Error("reviewer_auth_sync_pending"),
    };
  }
  return { ok: true, isReviewer: result.data.active };
}
