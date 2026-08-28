import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { cronSecretMatches } from "@/lib/ops-auth";
import {
  recoverQueuedGeneration,
  failGeneration,
} from "@/lib/generation-recovery";
import {
  CANDIDATE_TTL_MS,
  QUEUED_STALE_MS,
  SUBMIT_ACK_STALE_MS,
  cleanupCandidateStorage,
} from "@/lib/generation";
import {
  hasIncompleteCandidates,
  hasUnresolvedSubmitAcknowledgement,
} from "@/lib/character-gen/generation-state";
import { deleteFaceTmp, tmpFacePath } from "@/lib/character-gen/upload-face";
import { terminateDeletedOwnerGeneration } from "@/lib/character-gen/deleted-owner-generation";
import { completeGenerationArtifactCleanup } from "@/lib/character-gen/generation-artifact-cleanup";
import {
  boundedBatchMayHaveMore,
  createOpsMaintenanceDeadline,
  opsMaintenanceDeadlineReached,
  opsMaintenanceResponseInit,
  opsMaintenanceStatus,
  runOpsMaintenanceWithDeadline,
} from "@/lib/ops-maintenance-status";
import {
  advanceChronologicalCursor,
  chronologicalKeysetFilter,
  type ChronologicalCursor,
} from "@/lib/ops-keyset-pagination";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { log, errInfo } from "@/lib/log";
import {
  recordOpsCronHeartbeat,
  alertIfOpsCronSilent,
} from "@/lib/ops-cron-heartbeat";

export const runtime = "nodejs";
// 외부 scheduler의 90초 timeout보다 먼저 non-2xx로 끝나는 hard ceiling.
// 모든 전이는 durable CAS/receipt 기반이라 platform timeout 뒤 같은 job 재실행이 안전하다.
export const maxDuration = 25;

// 한 실행당 회수 시도 상한(fal 호출량·시간 보호). 더 있으면 다음 주기에.
const SWEEP_LIMIT = 20;
const RECOVERY_SCAN_PAGE_SIZE = 1000;
// fal result 만료(보통 단시간) 전에 회수해야 의미. 너무 오래된 건 어차피 만료라 스캔 제외.
const RECOVER_WINDOW_MS = 4 * 60 * 60 * 1000; // signed submit ack window 포함
// 방금 시작돼 fal 이 아직 도는 정상 생성이 5분 틱을 가로지르면 pending 으로 세어져
// sweep_incomplete(429·cron 실패)가 오탐된다 — 어린 행은 클라 폴링이 주 회수자이므로
// 대상에서 제외하고 다음 틱(그때 age≥2분)에 편입한다. 30분 force·webhook 백스톱 불변.
const RECOVER_MIN_AGE_MS = 2 * 60 * 1000;

function maintenanceTimeBudgetResponse() {
  return NextResponse.json(
    { ok: false, error: "maintenance_time_budget", retryPending: 1 },
    opsMaintenanceResponseInit(429),
  );
}

/** cron 심박 기록 — 공용 기록기(lib/ops-cron-heartbeat) 위임, 실패는 경고만(cron 자체를 죽이지 않음). */
async function heartbeat(
  admin: ReturnType<typeof createAdminClient>,
  phase: "start" | "success" | "failure",
  errorCode?: string,
  signal?: AbortSignal,
) {
  await recordOpsCronHeartbeat(admin, "gen-recover", phase, errorCode, signal);
}

/**
 * 캐릭터 생성 **서버측 회수 스윕** — cron-job.org 가 x-cron-secret 헤더로 수분 주기 호출(머신).
 *
 * 비동기 생성은 클라 폴링(`/api/generations`)이 fal 결과를 회수하는데, **탭 닫힘·앱 백그라운드로
 * 폴링이 멈추면** fal 은 완료돼도 우리가 못 채워 좀비가 된다(+ result 만료 시 영구 손실). 이 cron 이
 * 클라와 무관하게 미완(candidate < 요청수) 행을 fal 에 다시 물어 회수: 완료분 candidate 복사 + done,
 * 결정적 실패(no-face 등)면 `failGeneration`(환불). 모두 멱등(폴링과 동일 로직 재사용).
 *
 * force = age > 30분: 30분 넘은 건 스트래글러 포기하고 받은 만큼 확정. 그 전엔 비-force(아직 도는
 * 요청은 pending 유지 — 조기 확정/환불 방지, 클라 폴링이 곧 따라잡거나 다음 스윕이 처리).
 */
export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "disabled" },
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
      await heartbeat(admin, "start", undefined, deadline.signal);
      // 이웃 cron 침묵 감시(v1.02) — 잡 삭제·비활성은 스스로 알릴 수 없어 서로의 심박을 확인한다.
      await alertIfOpsCronSilent(admin, "reconcile", deadline.signal);
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      const cutoff = new Date(Date.now() - RECOVER_WINDOW_MS).toISOString();

      type Row = {
        id: string;
        owner_id: string;
        status: string;
        candidate_urls: unknown;
        fal_request_ids: unknown;
        gen_params: unknown;
        created_at: string;
        version: number;
      };
      // Filter-after-limit can permanently starve a newer incomplete row behind
      // 100 older complete `done` rows. Page the authoritative window first, then
      // bound only the provider-facing recovery work.
      const scannedRows: Row[] = [];
      const recoveryScanUpperBound = new Date().toISOString();
      let recoveryCursor: ChronologicalCursor | null = null;
      for (;;) {
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        let pageQuery = admin
          .from("ai_generations")
          .select(
            "id, owner_id, status, candidate_urls, fal_request_ids, gen_params, created_at, version",
          )
          .eq("cost_preflight_pending", false)
          .in("status", ["queued", "done"])
          .gte("created_at", cutoff)
          .lte("created_at", recoveryScanUpperBound)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true });
        if (recoveryCursor) {
          pageQuery = pageQuery.or(chronologicalKeysetFilter(recoveryCursor));
        }
        const { data: page, error: pageError } = await pageQuery
          .limit(RECOVERY_SCAN_PAGE_SIZE)
          .abortSignal(deadline.signal);
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        if (pageError) {
          log.error("gen.sweep_query_fail", errInfo(pageError));
          await heartbeat(admin, "failure", "query_failed", deadline.signal);
          return NextResponse.json(
            { error: "query_failed" },
            opsMaintenanceResponseInit(503),
          );
        }
        if (!Array.isArray(page)) {
          log.error("gen.sweep_query_invalid", { dataType: typeof page });
          await heartbeat(admin, "failure", "query_failed", deadline.signal);
          return NextResponse.json(
            { error: "query_failed" },
            opsMaintenanceResponseInit(503),
          );
        }
        let validatedPage: Row[];
        try {
          validatedPage = validateAdminRows<Row>("gen.sweep_page", page, {
            id: "uuid",
            owner_id: "uuid",
            status: "string",
            created_at: "timestamp",
            version: "nonnegativeInteger",
          });
          recoveryCursor = advanceChronologicalCursor(
            validatedPage,
            recoveryCursor,
          );
        } catch (error) {
          log.error("gen.sweep_query_invalid", errInfo(error));
          await heartbeat(admin, "failure", "query_failed", deadline.signal);
          return NextResponse.json(
            { error: "query_failed" },
            opsMaintenanceResponseInit(503),
          );
        }
        scannedRows.push(...validatedPage);
        if (validatedPage.length < RECOVERY_SCAN_PAGE_SIZE) break;
      }

      // 미완 = fal 요청 수 > 저장된 candidate 수. (fal_request_ids 없는 구버전 행은 회수 불가 → 제외.)
      const sweepScanTime = Date.now();
      const allTargets = scannedRows.filter(
        (r) =>
          sweepScanTime - new Date(r.created_at).getTime() >=
            RECOVER_MIN_AGE_MS &&
          hasIncompleteCandidates(
            r.candidate_urls,
            r.fal_request_ids,
            r.gen_params,
          ),
      );
      const targets = allTargets.slice(0, SWEEP_LIMIT);

      let recovered = 0;
      let failed = 0;
      let pending = 0;
      let deletedOwnersTerminalized = 0;
      let systemErrors = 0;
      let boundedBacklogs = 0;
      if (allTargets.length > SWEEP_LIMIT) {
        boundedBacklogs++;
      }

      // 탈퇴 전 생성 RPC가 먼저 commit한 queued/done은 profiles soft-delete 뒤에도 남는다.
      // provider 회수와 별개로 매 cron에서 먼저 terminal+artifact cleanup으로 수렴시켜,
      // cleanup 완료 후 재활성 시 ghost generation이 되살아나지 않게 한다.
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      const { data: deletedRows, error: deletedRowsError } = await admin
        .rpc("list_deleted_owner_inflight_generations", {
          p_limit: SWEEP_LIMIT,
        })
        .abortSignal(deadline.signal);
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (deletedRowsError) {
        systemErrors++;
        log.warn(
          "gen.deleted_owner_generation_sweep_fail",
          errInfo(deletedRowsError),
        );
      } else if (!Array.isArray(deletedRows)) {
        systemErrors++;
        log.warn("gen.deleted_owner_generation_sweep_invalid", {
          dataType: typeof deletedRows,
        });
      } else {
        if (boundedBatchMayHaveMore(deletedRows.length, SWEEP_LIMIT)) {
          boundedBacklogs++;
        }
        for (const row of deletedRows as {
          id: string;
          owner_id: string;
        }[]) {
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          const terminalized = await terminateDeletedOwnerGeneration(admin, {
            genId: row.id,
            ownerId: row.owner_id,
          });
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          if (terminalized) deletedOwnersTerminalized++;
          else pending++;
        }
      }

      for (const r of targets) {
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        try {
          const age = Date.now() - new Date(r.created_at).getTime();
          const awaitingSubmitAck = hasUnresolvedSubmitAcknowledgement(
            r.gen_params,
          );
          const rec = await recoverQueuedGeneration(
            admin,
            r.owner_id,
            r.id,
            r.fal_request_ids,
            !awaitingSubmitAck && age > QUEUED_STALE_MS,
          );
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          if (rec.status === "ready") {
            recovered++;
          } else if (rec.status === "owner_deleted") {
            const terminalized = await terminateDeletedOwnerGeneration(admin, {
              genId: r.id,
              ownerId: r.owner_id,
            });
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            if (terminalized) deletedOwnersTerminalized++;
            else pending++;
          } else if (rec.status === "failed" && rec.definitive) {
            const marked = await failGeneration(
              admin,
              r.id,
              r.owner_id,
              rec.reason,
              r.version,
            );
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            if (marked) failed++;
            else pending++;
          } else if (rec.status === "terminal") {
            // A concurrent pick/fail/expiry won. This row is intentionally not retried.
          } else {
            pending++;
          }
        } catch (e) {
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          pending++;
          log.warn("gen.sweep_row_fail", { genId: r.id, ...errInfo(e) });
        }
      }

      // ── 좀비 백스톱: 일반 queued는 30분, submit 응답이 불확실한 행은 fal의
      //    signed webhook 2시간 재전송 창+10분 뒤에만 failed+환불한다.
      //    (A) fal 이 IN_QUEUE 로 무한 정체(완료 0)라 recovery 가 pending 만 반환 / (B) submit~request_id
      //    영속 사이 하드크래시로 request_id 없어 recovery 대상서 제외. 클라의 age>30분 fall-through 를
      //    cron 에도 둬 **브라우저 종료 사용자도 크레딧을 잃지 않게** 한다. 정상 행은 수분 내 done/failed 로
      //    빠지므로 각 상태의 deadline 밖도 포함해 상한 없이 스캔한다.
      //    failGeneration(RPC 멱등)이 queued→failed+환불을 원자 처리.
      let stuckFailed = 0;
      const staleCutoff = new Date(Date.now() - QUEUED_STALE_MS).toISOString();
      type StuckRow = {
        id: string;
        owner_id: string;
        gen_params: unknown;
        created_at: string;
        version: number;
      };
      const allStuck: StuckRow[] = [];
      let stuckScanFailed = false;
      let stuckCursor: ChronologicalCursor | null = null;
      for (;;) {
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        let pageQuery = admin
          .from("ai_generations")
          .select("id, owner_id, gen_params, created_at, version")
          .eq("cost_preflight_pending", false)
          .eq("status", "queued")
          .lt("created_at", staleCutoff)
          .order("created_at", { ascending: true })
          .order("id", { ascending: true });
        if (stuckCursor) {
          pageQuery = pageQuery.or(chronologicalKeysetFilter(stuckCursor));
        }
        const { data: page, error: pageError } = await pageQuery
          .limit(RECOVERY_SCAN_PAGE_SIZE)
          .abortSignal(deadline.signal);
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        if (pageError || !Array.isArray(page)) {
          systemErrors++;
          stuckScanFailed = true;
          log.warn(
            "gen.stuck_sweep_query_fail",
            pageError ? errInfo(pageError) : { dataType: typeof page },
          );
          break;
        }
        let validatedPage: StuckRow[];
        try {
          validatedPage = validateAdminRows<StuckRow>(
            "gen.stuck_sweep_page",
            page,
            {
              id: "uuid",
              owner_id: "uuid",
              created_at: "timestamp",
              version: "nonnegativeInteger",
            },
          );
          stuckCursor = advanceChronologicalCursor(validatedPage, stuckCursor);
        } catch (error) {
          systemErrors++;
          stuckScanFailed = true;
          log.warn("gen.stuck_sweep_query_invalid", errInfo(error));
          break;
        }
        allStuck.push(...validatedPage);
        if (validatedPage.length < RECOVERY_SCAN_PAGE_SIZE) break;
      }
      if (!stuckScanFailed) {
        const now = Date.now();
        const eligibleStuck = allStuck.filter((row) => {
          if (!hasUnresolvedSubmitAcknowledgement(row.gen_params)) return true;
          const age = now - new Date(row.created_at).getTime();
          return age > SUBMIT_ACK_STALE_MS;
        });
        const stuck = eligibleStuck.slice(0, SWEEP_LIMIT);
        if (eligibleStuck.length > SWEEP_LIMIT) {
          boundedBacklogs++;
        }
        for (const g of stuck) {
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          try {
            const marked = await failGeneration(
              admin,
              g.id,
              g.owner_id,
              "timeout",
              g.version,
            );
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            if (marked) stuckFailed++;
            else pending++;
          } catch (e) {
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            pending++;
            log.warn("gen.stuck_sweep_item_fail", {
              genId: g.id,
              ...errInfo(e),
            });
          }
        }
      }

      // ── 미선택 완료 만료: 생성 성공은 소비 확정이라는 제품 정책을 지키며 환급 없이
      //    row-lock RPC로 done→expired. pick과 경합하면 conflict로 아무것도 지우지 않는다.
      let expired = 0;
      const doneCutoff = new Date(Date.now() - CANDIDATE_TTL_MS).toISOString();
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      const { data: staleDone, error: staleDoneError } = await admin
        .from("ai_generations")
        .select("id, owner_id, version")
        .eq("status", "done")
        .lt("created_at", doneCutoff)
        .order("created_at", { ascending: true })
        .limit(SWEEP_LIMIT)
        .abortSignal(deadline.signal);
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (staleDoneError) {
        systemErrors++;
        log.warn("gen.expiry_sweep_query_fail", errInfo(staleDoneError));
      } else if (!Array.isArray(staleDone)) {
        systemErrors++;
        log.warn("gen.expiry_sweep_query_invalid", {
          dataType: typeof staleDone,
        });
      } else {
        if (boundedBatchMayHaveMore(staleDone.length, SWEEP_LIMIT)) {
          boundedBacklogs++;
        }
        for (const g of staleDone as {
          id: string;
          owner_id: string;
          version: number;
        }[]) {
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          const { data: expiryData, error: expiryError } = await admin
            .rpc("expire_generation", {
              p_gen_id: g.id,
              p_expected_version: g.version,
            })
            .abortSignal(deadline.signal);
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          const outcome = (expiryData as { outcome?: string } | null)?.outcome;
          if (expiryError) {
            pending++;
            log.warn("gen.expiry_sweep_item_fail", {
              genId: g.id,
              ...errInfo(expiryError),
            });
          } else if (outcome === "expired" || outcome === "already_expired") {
            expired++;
          } else if (outcome === "conflict" || outcome === "version_conflict") {
            // The conflicting winner may still be an unexpired `done` update.
            // Without a re-read this run cannot prove the stale row disappeared.
            pending++;
          } else {
            pending++;
            log.warn("gen.expiry_sweep_item_unexpected", {
              genId: g.id,
              outcome: outcome ?? "missing",
            });
          }
        }
      }

      // ── terminal artifact saga: NULL marker가 durable retry manifest다.
      //    candidate와 tmp face를 모두 지운 뒤에만 marker를 쓴다.
      let artifactsCleaned = 0;
      let cleanupPending = 0;
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      const { data: cleanupRows, error: cleanupQueryError } = await admin
        .from("ai_generations")
        .select("id, owner_id, status")
        .in("status", ["failed", "picked", "expired"])
        .is("artifacts_cleaned_at", null)
        .order("updated_at", { ascending: true })
        .limit(SWEEP_LIMIT)
        .abortSignal(deadline.signal);
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (cleanupQueryError) {
        systemErrors++;
        log.warn("gen.artifact_sweep_query_fail", errInfo(cleanupQueryError));
      } else if (!Array.isArray(cleanupRows)) {
        systemErrors++;
        log.warn("gen.artifact_sweep_query_invalid", {
          dataType: typeof cleanupRows,
        });
      } else {
        if (boundedBatchMayHaveMore(cleanupRows.length, SWEEP_LIMIT)) {
          boundedBacklogs++;
        }
        for (const g of cleanupRows as {
          id: string;
          owner_id: string;
          status: "failed" | "picked" | "expired";
        }[]) {
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          const cleanup = await completeGenerationArtifactCleanup({
            beginCleanup: () =>
              admin.rpc("begin_generation_artifact_cleanup", {
                p_gen_id: g.id,
                p_expected_status: g.status,
              }),
            cleanupCandidates: () =>
              cleanupCandidateStorage(admin, g.owner_id, g.id),
            cleanupFace: () => deleteFaceTmp(tmpFacePath(g.owner_id, g.id)),
            markComplete: () =>
              admin.rpc("complete_generation_artifact_cleanup", {
                p_gen_id: g.id,
                p_expected_status: g.status,
              }),
          });
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          if (!cleanup.ok) {
            cleanupPending++;
            log.warn("gen.artifact_sweep_item_fail", {
              genId: g.id,
              stage: cleanup.stage,
              outcome: cleanup.outcome,
              ...errInfo(cleanup.error),
            });
          } else {
            artifactsCleaned++;
          }
        }
      }

      // ── 안전망: 미환급 실패 생성 재환급(§19) — status='failed'·refunded_at=NULL·credit_lot_id set 로
      //    고착된 소비 크레딧(failGeneration 의 done-fallback flip↔환급 RPC 사이 크래시 윈도우 잔여)을
      //    멱등 RPC 로 회수. idx_ai_generations_refund_pending 사용. ops(credit_lot_id NULL)는 predicate 로 제외.
      let reRefunded = 0;
      let refundPending = 0;
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      const { data: pendingRefunds, error: prErr } = await admin
        .from("ai_generations")
        .select("id, fail_reason")
        .eq("status", "failed")
        .is("refunded_at", null)
        .not("credit_lot_id", "is", null)
        .order("created_at", { ascending: true })
        .limit(SWEEP_LIMIT)
        .abortSignal(deadline.signal);
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (prErr) {
        systemErrors++;
        log.warn("gen.refund_sweep_query_fail", errInfo(prErr));
      } else if (!Array.isArray(pendingRefunds)) {
        systemErrors++;
        log.warn("gen.refund_sweep_query_invalid", {
          dataType: typeof pendingRefunds,
        });
      } else {
        if (boundedBatchMayHaveMore(pendingRefunds.length, SWEEP_LIMIT)) {
          boundedBacklogs++;
        }
        for (const g of pendingRefunds as {
          id: string;
          fail_reason: string | null;
        }[]) {
          if (opsMaintenanceDeadlineReached(deadline)) {
            return maintenanceTimeBudgetResponse();
          }
          try {
            const { error: rErr } = await admin
              .rpc("mark_generation_failed_and_refund", {
                p_gen_id: g.id,
                p_fail_reason: g.fail_reason ?? "recover_sweep",
              })
              .abortSignal(deadline.signal);
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            if (rErr) {
              refundPending++;
              log.warn("gen.refund_sweep_item_fail", {
                genId: g.id,
                ...errInfo(rErr),
              });
            } else reRefunded++;
          } catch (e) {
            if (opsMaintenanceDeadlineReached(deadline)) {
              return maintenanceTimeBudgetResponse();
            }
            refundPending++;
            log.warn("gen.refund_sweep_item_fail", {
              genId: g.id,
              ...errInfo(e),
            });
          }
        }
      }

      const retryPending = pending + cleanupPending + refundPending;
      const result = {
        scanned: scannedRows.length,
        targeted: targets.length,
        recovered,
        failed,
        pending,
        deletedOwnersTerminalized,
        stuckFailed,
        expired,
        artifactsCleaned,
        cleanupPending,
        reRefunded,
        refundPending,
        boundedBacklogs,
        retryPending,
        systemErrors,
      };
      const status = opsMaintenanceStatus({
        systemErrors,
        retryPending,
        boundedBacklogs,
      });
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (status === 200) {
        await heartbeat(admin, "success", undefined, deadline.signal);
      } else {
        await heartbeat(
          admin,
          "failure",
          status === 503 ? "system_error" : "incomplete",
          deadline.signal,
        );
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (status === 200) log.info("gen.sweep_done", result);
      else log.error("gen.sweep_incomplete", result);
      return NextResponse.json(
        { ok: status === 200, ...result },
        opsMaintenanceResponseInit(status),
      );
    },
    async () => {
      log.error("gen.maintenance_time_budget");
      await heartbeat(
        createAdminClient(),
        "failure",
        "time_budget",
        AbortSignal.timeout(1_000),
      );
      return maintenanceTimeBudgetResponse();
    },
  );
}
