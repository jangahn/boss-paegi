export type GenerationOwnerState = "active" | "deleted" | "unavailable";

export function ownerStateFromProfileRead(result: {
  data?: { deleted_at?: string | null } | null;
  error?: unknown | null;
}): GenerationOwnerState {
  if (result.error !== null && result.error !== undefined) return "unavailable";
  if (!result.data) return "unavailable";
  return result.data.deleted_at ? "deleted" : "active";
}

export type OwnerGuardedCopyResult<T> =
  | { kind: "copied"; value: T }
  | {
      kind: "blocked";
      ownerState: Exclude<GenerationOwnerState, "active">;
      cleanupError?: unknown;
    };

/**
 * Storage copy 직전·직후 owner lifecycle을 재확인한다. copy 중 탈퇴가 이기면
 * 방금 만든 candidate를 보상삭제하고 caller가 terminal 처리하도록 blocked를 반환한다.
 */
export async function runOwnerGuardedCopy<T>(input: {
  readOwnerState: () => Promise<GenerationOwnerState>;
  copy: () => Promise<T>;
  cleanupCopied: () => Promise<void>;
}): Promise<OwnerGuardedCopyResult<T>> {
  const before = await input.readOwnerState();
  if (before !== "active") return { kind: "blocked", ownerState: before };

  const value = await input.copy();
  const after = await input.readOwnerState();
  if (after === "active") return { kind: "copied", value };
  // DB read outage is not proof of deletion. Removing canonical paths could
  // destroy candidates persisted by a concurrent successful recovery.
  if (after === "unavailable") {
    return { kind: "blocked", ownerState: after };
  }

  try {
    await input.cleanupCopied();
    return { kind: "blocked", ownerState: after };
  } catch (cleanupError) {
    return { kind: "blocked", ownerState: after, cleanupError };
  }
}
