export type GenerationArtifactCleanupStage =
  | "cleanup_begin"
  | "candidate_cleanup"
  | "face_cleanup"
  | "cleanup_marker";

export type GenerationArtifactCleanupResult =
  | { ok: true; outcome: "cleaned" | "already_cleaned" }
  | {
      ok: false;
      stage: GenerationArtifactCleanupStage;
      error: unknown;
      outcome?: string;
    };

/**
 * Terminal generation의 candidate와 tmp face를 모두 지운 뒤에만 DB marker를
 * 쓴다. marker RPC의 resolved `{ error }`와 예상 밖 outcome도 실패로 취급한다.
 */
export async function completeGenerationArtifactCleanup(input: {
  beginCleanup?: () => PromiseLike<{
    data?: unknown;
    error?: unknown | null;
  }>;
  cleanupCandidates: () => Promise<void>;
  cleanupFace: () => Promise<void>;
  markComplete: () => PromiseLike<{
    data?: unknown;
    error?: unknown | null;
  }>;
}): Promise<GenerationArtifactCleanupResult> {
  if (input.beginCleanup) {
    try {
      const result = await input.beginCleanup();
      const outcome =
        result.data && typeof result.data === "object"
          ? (result.data as { outcome?: unknown }).outcome
          : undefined;
      if (result.error !== null && result.error !== undefined) {
        return {
          ok: false,
          stage: "cleanup_begin",
          error: result.error,
          outcome: typeof outcome === "string" ? outcome : undefined,
        };
      }
      if (outcome === "already_cleaned") {
        return { ok: true, outcome };
      }
      if (outcome !== "ready") {
        return {
          ok: false,
          stage: "cleanup_begin",
          error: new Error("unexpected_cleanup_begin_outcome"),
          outcome: typeof outcome === "string" ? outcome : undefined,
        };
      }
    } catch (error) {
      return { ok: false, stage: "cleanup_begin", error };
    }
  }

  try {
    await input.cleanupCandidates();
  } catch (error) {
    return { ok: false, stage: "candidate_cleanup", error };
  }

  try {
    await input.cleanupFace();
  } catch (error) {
    return { ok: false, stage: "face_cleanup", error };
  }

  try {
    const result = await input.markComplete();
    const outcome =
      result.data && typeof result.data === "object"
        ? (result.data as { outcome?: unknown }).outcome
        : undefined;
    if (result.error !== null && result.error !== undefined) {
      return {
        ok: false,
        stage: "cleanup_marker",
        error: result.error,
        outcome: typeof outcome === "string" ? outcome : undefined,
      };
    }
    if (outcome !== "cleaned" && outcome !== "already_cleaned") {
      return {
        ok: false,
        stage: "cleanup_marker",
        error: new Error("unexpected_cleanup_marker_outcome"),
        outcome: typeof outcome === "string" ? outcome : undefined,
      };
    }
    return { ok: true, outcome };
  } catch (error) {
    return { ok: false, stage: "cleanup_marker", error };
  }
}
