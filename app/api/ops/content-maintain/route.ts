import "server-only";
import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { cronSecretMatches } from "@/lib/ops-auth";
import { DOLLS_BUCKET } from "@/lib/storage-path";
import { drainAccountDeletionCleanupJobs } from "@/lib/account-delete-cleanup-job";
import { drainModerationPurgeJobs } from "@/lib/moderation-purge-job";
import {
  drainUploadCleanupJobs,
  drainStorageObjectCleanupJobs,
} from "@/lib/storage-cleanup-jobs";
import { drainReviewerAccountJobs } from "@/lib/reviewer-account-saga";
import { drainAccountReactivationJobs } from "@/lib/account-reactivation-job";
import { parseLegacyUploadOrphanSweep } from "@/lib/legacy-upload-orphan-sweep";
import {
  listStorageObjectsPaginated,
  removeStorageObjects,
  storagePathBatches,
} from "@/lib/supabase-operation";
import {
  boundedBatchMayHaveMore,
  createOpsMaintenanceDeadline,
  opsMaintenanceDeadlineReached,
  opsMaintenanceResponseInit,
  opsMaintenanceStatus,
  runOpsMaintenanceWithDeadline,
} from "@/lib/ops-maintenance-status";
import { log, errInfo } from "@/lib/log";
import { materializeGenerationPick } from "@/lib/character-gen/doll-pick-materialize";

export const runtime = "nodejs";
// 외부 scheduler 90초보다 짧은 fail-visible hard ceiling. Durable job/lease가
// timeout 뒤 다음 호출에서 이어받는다.
export const maxDuration = 25;

const TMP_FACE_PREFIX = "tmp/face";
// Every signed face-input URL expires after 10 minutes. The upload precedes URL
// minting by only one request step; a two-minute boundary margin guarantees the
// URL is dead before a crashed request's raw object becomes sweep-eligible.
export const TMP_FACE_MAX_AGE_MS = 12 * 60 * 1000;
const EXPIRE_LIMIT = 100;
const ACCOUNT_CLEANUP_LIMIT = 10;
const DURABLE_CLEANUP_LIMIT = 10;
const LEGACY_UPLOAD_SWEEP_LIMIT = 10;
const REACTIVATION_BUDGET_MS = 10_000;
const PICK_MATERIALIZATION_LIMIT = 2;
const GENERATION_COST_PRUNE_LIMIT = 100;

function maintenanceTimeBudgetResponse() {
  return NextResponse.json(
    { ok: false, error: "maintenance_time_budget", retryPending: 1 },
    opsMaintenanceResponseInit(429),
  );
}

/**
 * 콘텐츠 유지보수 cron — cron-job.org 가 x-cron-secret 헤더로 주기 호출(머신, requireAdmin 아님).
 * ① 재활성 Auth↔DB durable convergence(10초 단조시계 예산)
 * ② 만료 하이라이트(highlight_expires_at 경과) clip 물리삭제 + highlight_deleted_at set
 * ③ 고아 tmp/face 얼굴 백스톱 sweep(12분+)
 * ④ durable account_deletion_cleanup_jobs 재시도
 * (Phase 2: takedown 은 가역이라 자동 purge 없음 — 영구삭제는 어드민 수동 permanent-delete 만.
 *  탈퇴 자산은 0072 outbox가 별도로 소유.)
 */
export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "maintain_disabled" },
      opsMaintenanceResponseInit(503),
    );
  }
  if (!cronSecretMatches(req.headers.get("x-cron-secret"), secret)) {
    return NextResponse.json(
      { error: "unauthorized" },
      opsMaintenanceResponseInit(401),
    );
  }

  const deadline = createOpsMaintenanceDeadline();
  return runOpsMaintenanceWithDeadline<NextResponse>(
    deadline,
    async () => {
      const admin = createAdminClient();
      const result = {
        expired: 0,
        orphanFaces: 0,
        accountCleanupClaimed: 0,
        accountCleanupCompleted: 0,
        accountCleanupPending: 0,
        accountCleanupClaimErrors: 0,
        moderationPurgeClaimed: 0,
        moderationPurgeCompleted: 0,
        moderationPurgePending: 0,
        moderationPurgeClaimErrors: 0,
        uploadCleanupClaimed: 0,
        uploadCleanupCompleted: 0,
        uploadCleanupPending: 0,
        uploadCleanupClaimErrors: 0,
        objectCleanupClaimed: 0,
        objectCleanupCompleted: 0,
        objectCleanupPending: 0,
        objectCleanupClaimErrors: 0,
        reviewerSyncClaimed: 0,
        reviewerSyncCompleted: 0,
        reviewerSyncPending: 0,
        reviewerSyncFailed: 0,
        reviewerSyncClaimErrors: 0,
        reactivationClaimed: 0,
        reactivationCompleted: 0,
        reactivationPending: 0,
        reactivationRetryBacklog: 0,
        reactivationClaimErrors: 0,
        reactivationHealthErrors: 0,
        pickMaterializationClaimed: 0,
        pickMaterializationCompleted: 0,
        pickMaterializationPending: 0,
        pickMaterializationErrors: 0,
        generationCostExpired: 0,
        generationCostManualReviewObserved: 0,
        generationCostManualReviewOpen: 0,
        generationCostExpiryBacklog: 0,
        generationProviderOutputScrubbed: 0,
        generationProviderOutputScrubBacklog: 0,
        generationCostRetentionBacklog: 0,
        generationCostRetentionDeleted: 0,
        generationCostPruneErrors: 0,
        reactivationFailures: [] as Array<{
          requestId: string;
          userId: string;
          failure: string;
          retryRecorded: boolean;
        }>,
        reactivationClaimFailures: [] as string[],
        reactivationBacklogSample: null as {
          requestId: string;
          userId: string;
          status: "pending" | "leased";
          lastError: string | null;
          retryAt: string;
        } | null,
        legacyUploadSweepEnabled: false,
        legacyUploadOrphansExamined: 0,
        legacyUploadOrphansEnqueued: 0,
        legacyUploadReferencesProtected: 0,
        legacyUploadSweepErrors: 0,
        orphanFaceRetryPending: 0,
        boundedBacklogs: 0,
        systemErrors: 0,
      };

      // ── ① 재활성 GoTrue→DB durable convergence ───────────────────────────────
      // This is the first post-auth operation. Even a hung database RPC in an
      // unrelated maintenance stage cannot consume its monotonic budget.
      try {
        const reactivation = await drainAccountReactivationJobs(
          admin,
          DURABLE_CLEANUP_LIMIT,
          { maxDurationMs: REACTIVATION_BUDGET_MS },
        );
        result.reactivationClaimed = reactivation.claimed;
        result.reactivationCompleted = reactivation.completed;
        result.reactivationPending = reactivation.pending;
        result.reactivationRetryBacklog = reactivation.retryBacklog;
        result.reactivationClaimErrors = reactivation.claimErrors;
        result.reactivationHealthErrors = reactivation.healthErrors;
        result.reactivationFailures = reactivation.failures;
        result.reactivationClaimFailures = reactivation.claimFailures;
        result.reactivationBacklogSample = reactivation.backlogSample;
        if (
          boundedBatchMayHaveMore(reactivation.claimed, DURABLE_CLEANUP_LIMIT)
        ) {
          result.boundedBacklogs += 1;
        }
        if (reactivation.claimErrors > 0 || reactivation.healthErrors > 0) {
          result.systemErrors +=
            reactivation.claimErrors + reactivation.healthErrors;
          log.error("content_maintain.reactivation_incomplete", reactivation);
        }
      } catch (error) {
        result.reactivationClaimErrors += 1;
        result.reactivationClaimFailures = ["reactivation_drain_threw"];
        result.systemErrors += 1;
        log.error("content_maintain.reactivation_fail", errInfo(error));
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      // ── ② Cost-path expiry, reconciliation handoff, child-first retention ─
      // A raw provider POST whose acknowledgement was lost must never be
      // replayed. The DB moves expired ambiguity to a durable manual-review
      // ledger and reports its exact open backlog; any backlog keeps this
      // scheduler invocation non-2xx.
      try {
        const { data: pruneData, error: pruneError } = await admin
          .rpc("prune_generation_cost_controls", {
            p_limit: GENERATION_COST_PRUNE_LIMIT,
          })
          .abortSignal(deadline.signal);
        if (pruneError) throw pruneError;
        if (
          pruneData === null ||
          typeof pruneData !== "object" ||
          Array.isArray(pruneData)
        ) {
          throw new Error("generation_cost_prune_invalid");
        }
        const prune = pruneData as Record<string, unknown>;
        const deleted = prune.deleted;
        const exactNumbers = [
          prune.expired,
          prune.manual_review_observed,
          prune.manual_review_open,
          prune.expiry_backlog,
          prune.provider_output_scrubbed,
          prune.provider_output_scrub_backlog,
          prune.retention_backlog,
        ];
        if (
          typeof prune.ok !== "boolean" ||
          exactNumbers.some(
            (value) => !Number.isSafeInteger(value) || (value as number) < 0,
          ) ||
          deleted === null ||
          typeof deleted !== "object" ||
          Array.isArray(deleted)
        ) {
          throw new Error("generation_cost_prune_invalid");
        }
        const deletedRecord = deleted as Record<string, unknown>;
        const deletedKeys = Object.keys(deletedRecord).sort();
        const expectedDeletedKeys = [
          "face_costs",
          "face_intents",
          "flux_intents",
          "pick_costs",
          "pick_intents",
          "preflights",
          "upload_intents",
          "upload_token_issues",
        ];
        const deletedValues = expectedDeletedKeys.map(
          (key) => deletedRecord[key],
        );
        if (
          deletedKeys.length !== expectedDeletedKeys.length ||
          deletedKeys.some((key, index) => key !== expectedDeletedKeys[index]) ||
          deletedValues.some(
            (value) => !Number.isSafeInteger(value) || (value as number) < 0,
          )
        ) {
          throw new Error("generation_cost_prune_deleted_invalid");
        }
        result.generationCostExpired = prune.expired as number;
        result.generationCostManualReviewObserved =
          prune.manual_review_observed as number;
        result.generationCostManualReviewOpen =
          prune.manual_review_open as number;
        result.generationCostExpiryBacklog =
          prune.expiry_backlog as number;
        result.generationProviderOutputScrubbed =
          prune.provider_output_scrubbed as number;
        result.generationProviderOutputScrubBacklog =
          prune.provider_output_scrub_backlog as number;
        result.generationCostRetentionBacklog =
          prune.retention_backlog as number;
        result.generationCostRetentionDeleted = deletedValues.reduce<number>(
          (sum, value) => sum + (value as number),
          0,
        );
        if (
          result.generationCostExpiryBacklog > 0 ||
          result.generationProviderOutputScrubBacklog > 0 ||
          result.generationCostRetentionBacklog > 0
        ) {
          result.boundedBacklogs += 1;
        }
      } catch (error) {
        result.generationCostPruneErrors += 1;
        result.systemErrors += 1;
        log.error("content_maintain.generation_cost_prune_fail", errInfo(error));
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      // ── ③ FAL provider result → private durable doll materialization ──────
      // Provider StoreIO objects have a finite six-hour lifecycle. This worker
      // makes materialization independent of a browser/client retry.
      try {
        const { data: candidatesData, error: candidatesError } =
          await admin.rpc("list_generation_pick_materializations", {
            p_limit: PICK_MATERIALIZATION_LIMIT,
          });
        if (candidatesError) throw candidatesError;
        if (!Array.isArray(candidatesData)) {
          throw new Error("pick_materialization_candidates_invalid");
        }
        for (const candidate of candidatesData) {
          if (
            !candidate ||
            typeof candidate !== "object" ||
            Array.isArray(candidate) ||
            typeof candidate.generation_id !== "string" ||
            typeof candidate.owner_id !== "string"
          ) {
            throw new Error("pick_materialization_candidate_invalid");
          }
          result.pickMaterializationClaimed += 1;
          try {
            const materialized = await materializeGenerationPick({
              admin,
              userId: candidate.owner_id,
              generationId: candidate.generation_id,
              workerId: randomUUID(),
            });
            if (materialized.kind === "committed") {
              result.pickMaterializationCompleted += 1;
            } else {
              result.pickMaterializationPending += 1;
            }
          } catch (error) {
            result.pickMaterializationPending += 1;
            result.pickMaterializationErrors += 1;
            log.warn(
              "content_maintain.pick_materialization_deferred",
              {
                generationId: candidate.generation_id,
                ...errInfo(error),
              },
            );
          }
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
        }
        if (
          boundedBatchMayHaveMore(
            result.pickMaterializationClaimed,
            PICK_MATERIALIZATION_LIMIT,
          )
        ) {
          result.boundedBacklogs += 1;
        }
      } catch (error) {
        result.pickMaterializationErrors += 1;
        result.systemErrors += 1;
        log.error(
          "content_maintain.pick_materialization_fail",
          errInfo(error),
        );
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      // ── ③ 만료 하이라이트 purge ──
      try {
        const { data: expired, error: expiredQueryError } = await admin
          .rpc("request_expired_highlight_cleanup", {
            p_limit: EXPIRE_LIMIT,
          })
          .abortSignal(deadline.signal);
        if (expiredQueryError) throw expiredQueryError;
        const expiredResult = expired as {
          ok?: unknown;
          processed?: unknown;
          jobs?: unknown;
        } | null;
        const processed = expiredResult?.processed;
        const jobs = expiredResult?.jobs;
        if (
          expiredResult?.ok !== true ||
          !Number.isSafeInteger(processed) ||
          (processed as number) < 0 ||
          !Number.isSafeInteger(jobs) ||
          (jobs as number) < 0 ||
          (jobs as number) > (processed as number)
        ) {
          throw new Error("invalid expired highlight cleanup response");
        }
        result.expired = processed as number;
        if (boundedBatchMayHaveMore(result.expired, EXPIRE_LIMIT)) {
          result.boundedBacklogs += 1;
        }
      } catch (e) {
        result.systemErrors += 1;
        log.error("content_maintain.expire_fail", errInfo(e));
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      // ── ④ 고아 tmp/face sweep ──
      try {
        const cutoff = Date.now() - TMP_FACE_MAX_AGE_MS;
        const folders = await listStorageObjectsPaginated<{
          name: string;
        }>("content_maintain.face_folders.list", (options) =>
          admin.storage.from(DOLLS_BUCKET).list(TMP_FACE_PREFIX, options),
        );
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        for (const folder of folders) {
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          const prefix = `${TMP_FACE_PREFIX}/${folder.name}`;
          const files = await listStorageObjectsPaginated<{
            name: string;
            created_at?: string | null;
          }>("content_maintain.face_files.list", (options) =>
            admin.storage.from(DOLLS_BUCKET).list(prefix, options),
          );
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          const stale = files
            .filter((f) => {
              const t = f.created_at ? new Date(f.created_at).getTime() : 0;
              return t > 0 && t < cutoff;
            })
            .map((f) => `${prefix}/${f.name}`);
          for (const batch of storagePathBatches(stale)) {
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            try {
              await removeStorageObjects(
                "content_maintain.face_files.remove",
                batch,
                (paths) => admin.storage.from(DOLLS_BUCKET).remove(paths),
                (path) => admin.storage.from(DOLLS_BUCKET).exists(path),
              );
              if (opsMaintenanceDeadlineReached(deadline)) {
                return maintenanceTimeBudgetResponse();
              }
              result.orphanFaces += batch.length;
            } catch (error) {
              result.orphanFaceRetryPending += batch.length;
              log.warn("content_maintain.face_remove_fail", errInfo(error));
            }
          }
        }
      } catch (e) {
        result.systemErrors += 1;
        log.error("content_maintain.face_sweep_fail", errInfo(e));
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      // ── ⑤ 계정 탈퇴 durable cleanup 재시도 ──
      try {
        const cleanup = await drainAccountDeletionCleanupJobs(
          admin,
          ACCOUNT_CLEANUP_LIMIT,
        );
        result.accountCleanupClaimed = cleanup.claimed;
        result.accountCleanupCompleted = cleanup.completed;
        result.accountCleanupPending = cleanup.pending;
        result.accountCleanupClaimErrors = cleanup.claimErrors;
        if (boundedBatchMayHaveMore(cleanup.claimed, ACCOUNT_CLEANUP_LIMIT)) {
          result.boundedBacklogs += 1;
        }
        if (cleanup.claimErrors > 0) {
          result.systemErrors += cleanup.claimErrors;
          log.error("content_maintain.account_cleanup_claim_fail", cleanup);
        }
      } catch (error) {
        result.accountCleanupClaimErrors += 1;
        result.systemErrors += 1;
        log.error("content_maintain.account_cleanup_fail", errInfo(error));
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      // ── ⑥ 모더레이션 purge / signed-upload orphan / DB-first object cleanup ──
      for (const [name, run] of [
        [
          "moderationPurge",
          () => drainModerationPurgeJobs(admin, DURABLE_CLEANUP_LIMIT),
        ],
        [
          "uploadCleanup",
          () => drainUploadCleanupJobs(admin, DURABLE_CLEANUP_LIMIT),
        ],
        [
          "objectCleanup",
          () => drainStorageObjectCleanupJobs(admin, DURABLE_CLEANUP_LIMIT),
        ],
      ] as const) {
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        try {
          const cleanup = await run();
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          result[`${name}Claimed`] = cleanup.claimed;
          result[`${name}Completed`] = cleanup.completed;
          result[`${name}Pending`] = cleanup.pending;
          result[`${name}ClaimErrors`] = cleanup.claimErrors;
          if (boundedBatchMayHaveMore(cleanup.claimed, DURABLE_CLEANUP_LIMIT)) {
            result.boundedBacklogs += 1;
          }
          if (cleanup.claimErrors > 0) {
            result.systemErrors += cleanup.claimErrors;
            log.error(`content_maintain.${name}_claim_fail`, cleanup);
          }
        } catch (error) {
          result[`${name}ClaimErrors`] += 1;
          result.systemErrors += 1;
          log.error(`content_maintain.${name}_fail`, errInfo(error));
        }
      }

      // ── ⑦ reviewer Auth↔DB durable convergence ───────────────────────────────
      try {
        const reviewer = await drainReviewerAccountJobs(
          admin,
          DURABLE_CLEANUP_LIMIT,
        );
        result.reviewerSyncClaimed = reviewer.claimed;
        result.reviewerSyncCompleted = reviewer.completed;
        result.reviewerSyncPending = reviewer.pending;
        result.reviewerSyncFailed = reviewer.failed;
        result.reviewerSyncClaimErrors = reviewer.claimErrors;
        if (boundedBatchMayHaveMore(reviewer.claimed, DURABLE_CLEANUP_LIMIT)) {
          result.boundedBacklogs += 1;
        }
        if (reviewer.claimErrors > 0 || reviewer.failed > 0) {
          result.systemErrors += reviewer.claimErrors + reviewer.failed;
          log.error("content_maintain.reviewer_sync_incomplete", reviewer);
        }
      } catch (error) {
        result.reviewerSyncClaimErrors += 1;
        result.systemErrors += 1;
        log.error("content_maintain.reviewer_sync_fail", errInfo(error));
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      // ── ⑧ rolling-deploy legacy signed-upload inventory convergence ─────────
      // 0079 records the expand floor and 0092 enables one finite old-token
      // window. New receipts are drained on the next cron because the upload
      // cleanup pass above intentionally ran before this bounded inventory probe.
      try {
        const { data: sweepData, error: sweepError } = await admin
          .rpc("enqueue_legacy_signed_upload_orphans", {
            p_limit: LEGACY_UPLOAD_SWEEP_LIMIT,
          })
          .abortSignal(deadline.signal);
        if (sweepError) throw sweepError;
        const sweep = parseLegacyUploadOrphanSweep(
          sweepData,
          LEGACY_UPLOAD_SWEEP_LIMIT,
        );
        if (!sweep) {
          throw new Error("invalid legacy upload sweep response");
        }
        result.legacyUploadSweepEnabled = sweep.enabled;
        result.legacyUploadOrphansExamined = sweep.examined;
        result.legacyUploadOrphansEnqueued = sweep.enqueued;
        result.legacyUploadReferencesProtected = sweep.protected;
        if (!sweep.enabled) {
          result.legacyUploadSweepErrors += 1;
          result.systemErrors += 1;
          log.error("content_maintain.legacy_upload_sweep_disabled");
        }
        if (
          boundedBatchMayHaveMore(sweep.examined, LEGACY_UPLOAD_SWEEP_LIMIT)
        ) {
          result.boundedBacklogs += 1;
        }
      } catch (error) {
        result.legacyUploadSweepErrors += 1;
        result.systemErrors += 1;
        log.error("content_maintain.legacy_upload_sweep_fail", errInfo(error));
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      const retryPending =
        result.accountCleanupPending +
        result.moderationPurgePending +
        result.uploadCleanupPending +
        result.objectCleanupPending +
        result.reviewerSyncPending +
        result.reviewerSyncFailed +
        Math.max(result.reactivationPending, result.reactivationRetryBacklog) +
        result.legacyUploadOrphansEnqueued +
        result.orphanFaceRetryPending +
        result.pickMaterializationPending +
        result.generationCostManualReviewOpen +
        result.generationCostExpiryBacklog +
        result.generationProviderOutputScrubBacklog +
        result.generationCostRetentionBacklog;
      const status = opsMaintenanceStatus({
        systemErrors: result.systemErrors,
        retryPending,
        boundedBacklogs: result.boundedBacklogs,
      });
      const ok = status === 200;
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (ok) log.info("content_maintain.done", result);
      else
        log.error("content_maintain.incomplete", { ...result, retryPending });
      return NextResponse.json(
        { ok, retryPending, ...result },
        opsMaintenanceResponseInit(status),
      );
    },
    () => {
      log.error("content_maintain.maintenance_time_budget");
      return maintenanceTimeBudgetResponse();
    },
  );
}
