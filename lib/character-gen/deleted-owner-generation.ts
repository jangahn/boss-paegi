import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cleanupCandidateStorage } from "@/lib/generation";
import { deleteFaceTmp, tmpFacePath } from "@/lib/character-gen/upload-face";
import { completeGenerationArtifactCleanup } from "@/lib/character-gen/generation-artifact-cleanup";
import { log, errInfo } from "@/lib/log";

type GenerationStatus = "queued" | "done" | "failed" | "picked" | "expired";

/**
 * 삭제 owner의 남은 generation을 외부 provider 조회 없이 종결한다.
 *
 * 먼저 terminal 전이를 확정하고, write lease가 없는 terminal row만 Storage cleanup
 * 후 marker를 쓴다. 실패/active lease는 artifacts_cleaned_at=NULL인 durable retry다.
 */
export async function terminateDeletedOwnerGeneration(
  admin: SupabaseClient,
  input: { genId: string; ownerId: string },
): Promise<boolean> {
  const { genId, ownerId } = input;
  const { data: row, error: rowError } = await admin
    .from("ai_generations")
    .select("status, version")
    .eq("id", genId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (rowError) {
    log.warn("gen.deleted_owner_lookup_fail", {
      ownerId,
      genId,
      ...errInfo(rowError),
    });
    return false;
  }
  if (!row) return true;

  let status = row.status as GenerationStatus;

  if (status === "queued") {
    const { error } = await admin.rpc("mark_generation_failed_and_refund", {
      p_gen_id: genId,
      p_fail_reason: "account_deleted",
      p_expected_version:
        typeof row.version === "number" ? row.version : null,
    });
    if (error && !error.message.includes("invalid_state")) {
      log.warn("gen.deleted_owner_fail_transition_error", {
        ownerId,
        genId,
        ...errInfo(error),
      });
      return false;
    }
  } else if (status === "done") {
    const { data, error } = await admin.rpc("expire_generation", {
      p_gen_id: genId,
      p_expected_version:
        typeof row.version === "number" ? row.version : null,
    });
    const outcome = (data as { outcome?: string } | null)?.outcome;
    if (error) {
      log.warn("gen.deleted_owner_expire_error", {
        ownerId,
        genId,
        ...errInfo(error),
      });
      return false;
    }
    if (
      outcome !== "expired" &&
      outcome !== "already_expired" &&
      outcome !== "conflict" &&
      outcome !== "version_conflict"
    ) {
      return false;
    }
  }

  // 전이 경합 결과를 정본에서 다시 읽는다.
  const { data: current, error: currentError } = await admin
    .from("ai_generations")
    .select("status")
    .eq("id", genId)
    .eq("owner_id", ownerId)
    .maybeSingle();
  if (currentError) {
    log.warn("gen.deleted_owner_recheck_fail", {
      ownerId,
      genId,
      ...errInfo(currentError),
    });
    return false;
  }
  if (!current) return true;
  status = current.status as GenerationStatus;
  if (status === "queued" || status === "done") return false;

  if (status === "failed" || status === "picked" || status === "expired") {
    const cleanup = await completeGenerationArtifactCleanup({
      beginCleanup: () =>
        admin.rpc("begin_generation_artifact_cleanup", {
          p_gen_id: genId,
          p_expected_status: status,
        }),
      cleanupCandidates: () => cleanupCandidateStorage(admin, ownerId, genId),
      cleanupFace: () => deleteFaceTmp(tmpFacePath(ownerId, genId)),
      markComplete: () =>
        admin.rpc("complete_generation_artifact_cleanup", {
          p_gen_id: genId,
          p_expected_status: status,
        }),
    });
    if (!cleanup.ok) {
      log.warn("gen.deleted_owner_cleanup_fail", {
        ownerId,
        genId,
        status,
        stage: cleanup.stage,
        outcome: cleanup.outcome,
        ...errInfo(cleanup.error),
      });
      return false;
    }
  }

  log.info("gen.deleted_owner_terminal", { ownerId, genId, status });
  return true;
}
