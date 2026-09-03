import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
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
  opsMaintenanceDeadlineReached,
  type OpsMaintenanceDeadline,
} from "@/lib/ops-maintenance-status";
import {
  advanceChronologicalCursor,
  chronologicalKeysetFilter,
  type ChronologicalCursor,
} from "@/lib/ops-keyset-pagination";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { log, errInfo } from "@/lib/log";
import { selectProvider } from "@/lib/character-gen";
import { continueReservationServerSide } from "@/lib/character-gen/generation-continuation";
import {
  PREFLIGHT_CONTINUE_MAX_AGE_COMMITTED_MS,
  PREFLIGHT_CONTINUE_MIN_AGE_MS,
  PREFLIGHT_STALE_OWNER_LIMIT,
  PREFLIGHT_STALE_RELEASE_AGE_MS,
  selectContinuationTargets,
  type PreflightContinuationRow,
} from "@/lib/character-gen/preflight-continuation-targets";

/**
 * gen-recover 스윕의 스테이지 분해(v1.04) — route(app/api/ops/gen-recover)는 인증·심박·
 * 스케줄러 응답 계약만 갖고, 회수/종결/정리의 실체는 여기 스테이지 함수들이 갖는다.
 * 각 스테이지는 deadline 을 넘기면 SWEEP_STAGE_DEADLINE 을 반환하고(응답은 route 가 결정),
 * 카운터는 공유 SweepCounters 에 누적한다. 로직·순서·카운터 의미는 원 구현 그대로 이동.
 */

/** 한 실행당 회수 시도 상한(fal 호출량·시간 보호). 더 있으면 다음 주기에. */
export const SWEEP_LIMIT = 20;
export const RECOVERY_SCAN_PAGE_SIZE = 1000;
/** fal result 만료(보통 단시간) 전에 회수해야 의미. 너무 오래된 건 어차피 만료라 스캔 제외. */
export const RECOVER_WINDOW_MS = 4 * 60 * 60 * 1000; // signed submit ack window 포함
/**
 * 방금 시작돼 fal 이 아직 도는 정상 생성이 5분 틱을 가로지르면 pending 으로 세어져
 * sweep_incomplete(429·cron 실패)가 오탐된다 — 어린 행은 클라 폴링이 주 회수자이므로
 * 대상에서 제외하고 다음 틱(그때 age≥2분)에 편입한다. 30분 force·webhook 백스톱 불변.
 */
export const RECOVER_MIN_AGE_MS = 2 * 60 * 1000;

export const SWEEP_STAGE_DEADLINE = { kind: "deadline" } as const;
export const SWEEP_STAGE_DONE = { kind: "done" } as const;
export type SweepStageEnd =
  | typeof SWEEP_STAGE_DEADLINE
  | typeof SWEEP_STAGE_DONE;
export const SWEEP_SCAN_QUERY_FAILED = { kind: "query_failed" } as const;

export type RecoverySweepRow = {
  id: string;
  owner_id: string;
  status: string;
  candidate_urls: unknown;
  fal_request_ids: unknown;
  gen_params: unknown;
  created_at: string;
  version: number;
};

export type RecoveryScanOutcome =
  | typeof SWEEP_STAGE_DEADLINE
  | typeof SWEEP_SCAN_QUERY_FAILED
  | { kind: "rows"; rows: RecoverySweepRow[] };

export type SweepCounters = {
  /** 얼굴검사 accepted/committed 인데 제출이 안 된 예약을 서버가 이어간 수(v1.20). */
  continued: number;
  continuePending: number;
  /** 10분+ 방치된 claimed/accepted 예약을 소유자 단위로 환불·종결한 수(v1.20). */
  stalePreflightsReleased: number;
  recovered: number;
  failed: number;
  pending: number;
  deletedOwnersTerminalized: number;
  systemErrors: number;
  boundedBacklogs: number;
  stuckFailed: number;
  expired: number;
  artifactsCleaned: number;
  cleanupPending: number;
  reRefunded: number;
  refundPending: number;
};

export function createSweepCounters(): SweepCounters {
  return {
    continued: 0,
    continuePending: 0,
    stalePreflightsReleased: 0,
    recovered: 0,
    failed: 0,
    pending: 0,
    deletedOwnersTerminalized: 0,
    systemErrors: 0,
    boundedBacklogs: 0,
    stuckFailed: 0,
    expired: 0,
    artifactsCleaned: 0,
    cleanupPending: 0,
    reRefunded: 0,
    refundPending: 0,
  };
}

/**
 * accepted(얼굴검사 통과·미제출)·committed(크레딧 확정·lease 만료) 예약을 서버가 이어간다.
 * 웹훅이 이미 처리했으면 claim 이 submitted/processing 을 돌려줘 아무 것도 바꾸지 않는다.
 */
export async function continuePendingPreflights(
  admin: SupabaseClient,
  deadline: OpsMaintenanceDeadline,
  counters: SweepCounters,
): Promise<SweepStageEnd> {
  if (opsMaintenanceDeadlineReached(deadline)) return SWEEP_STAGE_DEADLINE;
  const now = Date.now();
  const { data: rows, error } = await admin
    .from("generation_preflight_reservations")
    .select("id, owner_id, state, continuation_state, continuation_leased_until, created_at")
    .in("state", ["accepted", "committed"])
    .neq("continuation_state", "submitted")
    .gte("created_at", new Date(now - PREFLIGHT_CONTINUE_MAX_AGE_COMMITTED_MS).toISOString())
    .lte("created_at", new Date(now - PREFLIGHT_CONTINUE_MIN_AGE_MS).toISOString())
    .order("created_at", { ascending: true })
    .limit(50)
    .abortSignal(deadline.signal);
  if (opsMaintenanceDeadlineReached(deadline)) return SWEEP_STAGE_DEADLINE;
  if (error || !Array.isArray(rows)) {
    counters.systemErrors++;
    log.warn(
      "gen.continue_sweep_query_fail",
      error ? errInfo(error) : { dataType: typeof rows },
    );
    return SWEEP_STAGE_DONE;
  }
  let validated: PreflightContinuationRow[];
  try {
    validated = validateAdminRows<PreflightContinuationRow>(
      "gen.continue_sweep_page",
      rows,
      {
        id: "uuid",
        owner_id: "uuid",
        state: "string",
        continuation_state: "string",
        continuation_leased_until: "nullableTimestamp",
        created_at: "timestamp",
      },
    );
  } catch (validationError) {
    counters.systemErrors++;
    log.warn("gen.continue_sweep_query_invalid", errInfo(validationError));
    return SWEEP_STAGE_DONE;
  }
  const eligible = selectContinuationTargets(validated, now, Number.MAX_SAFE_INTEGER);
  const targets = selectContinuationTargets(validated, now);
  if (eligible.length > targets.length) counters.boundedBacklogs++;
  const provider = selectProvider(null);
  for (const row of targets) {
    if (opsMaintenanceDeadlineReached(deadline)) return SWEEP_STAGE_DEADLINE;
    try {
      const outcome = await continueReservationServerSide({
        admin,
        provider,
        requestId: row.id,
        trigger: "sweep",
      });
      if (opsMaintenanceDeadlineReached(deadline)) return SWEEP_STAGE_DEADLINE;
      if (
        outcome.kind === "continued" &&
        (outcome.result.kind === "submitted" ||
          outcome.result.kind === "submit_pending")
      ) {
        counters.continued++;
      } else {
        counters.continuePending++;
      }
    } catch (e) {
      if (opsMaintenanceDeadlineReached(deadline)) return SWEEP_STAGE_DEADLINE;
      counters.continuePending++;
      log.warn("gen.continue_sweep_item_fail", {
        requestId: row.id,
        ...errInfo(e),
      });
    }
  }
  return SWEEP_STAGE_DONE;
}

/**
 * 10분+ 방치된 claimed/accepted 예약을 소유자 단위 RPC(release_stale_generation_preflights —
 * 폴링 허브가 재진입 때 쓰는 것과 동일)로 환불·종결한다. 종전엔 사용자가 /generate 에 다시
 * 들어와야만 실행돼 크레딧이 무기한 묶였다(2026-09-03 실관측 1시간 40분).
 */
export async function releaseStalePreflights(
  admin: SupabaseClient,
  deadline: OpsMaintenanceDeadline,
  counters: SweepCounters,
): Promise<SweepStageEnd> {
  if (opsMaintenanceDeadlineReached(deadline)) return SWEEP_STAGE_DEADLINE;
  const cutoff = new Date(Date.now() - PREFLIGHT_STALE_RELEASE_AGE_MS).toISOString();
  const { data: rows, error } = await admin
    .from("generation_preflight_reservations")
    .select("owner_id")
    .in("state", ["claimed", "accepted"])
    .lt("created_at", cutoff)
    .order("created_at", { ascending: true })
    .limit(100)
    .abortSignal(deadline.signal);
  if (opsMaintenanceDeadlineReached(deadline)) return SWEEP_STAGE_DEADLINE;
  if (error || !Array.isArray(rows)) {
    counters.systemErrors++;
    log.warn(
      "gen.stale_preflight_query_fail",
      error ? errInfo(error) : { dataType: typeof rows },
    );
    return SWEEP_STAGE_DONE;
  }
  const owners = [...new Set(
    rows
      .map((row) => (row as { owner_id?: unknown }).owner_id)
      .filter((value): value is string => typeof value === "string"),
  )];
  if (owners.length > PREFLIGHT_STALE_OWNER_LIMIT) counters.boundedBacklogs++;
  for (const ownerId of owners.slice(0, PREFLIGHT_STALE_OWNER_LIMIT)) {
    if (opsMaintenanceDeadlineReached(deadline)) return SWEEP_STAGE_DEADLINE;
    const { data, error: releaseError } = await admin.rpc(
      "release_stale_generation_preflights",
      { p_owner_id: ownerId },
    );
    if (opsMaintenanceDeadlineReached(deadline)) return SWEEP_STAGE_DEADLINE;
    const released =
      !releaseError &&
      data &&
      typeof data === "object" &&
      (data as { ok?: unknown }).ok === true &&
      typeof (data as { released?: unknown }).released === "number"
        ? (data as { released: number }).released
        : 0;
    if (releaseError) {
      counters.systemErrors++;
      log.warn("gen.stale_preflight_release_fail", {
        userId: ownerId,
        ...errInfo(releaseError),
      });
    } else if (released > 0) {
      counters.stalePreflightsReleased += released;
      log.info("gen.preflight_released", { userId: ownerId, released, trigger: "sweep" });
    }
  }
  return SWEEP_STAGE_DONE;
}

export async function scanRecoveryWindow(
  admin: SupabaseClient,
  deadline: OpsMaintenanceDeadline,
): Promise<RecoveryScanOutcome> {
  const cutoff = new Date(Date.now() - RECOVER_WINDOW_MS).toISOString();

  // Filter-after-limit can permanently starve a newer incomplete row behind
  // 100 older complete `done` rows. Page the authoritative window first, then
  // bound only the provider-facing recovery work.
  const scannedRows: RecoverySweepRow[] = [];
  const recoveryScanUpperBound = new Date().toISOString();
  let recoveryCursor: ChronologicalCursor | null = null;
  for (;;) {
    if (opsMaintenanceDeadlineReached(deadline)) {
      return SWEEP_STAGE_DEADLINE;
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
      return SWEEP_STAGE_DEADLINE;
    }
    if (pageError) {
      log.error("gen.sweep_query_fail", errInfo(pageError));
      return SWEEP_SCAN_QUERY_FAILED;
    }
    if (!Array.isArray(page)) {
      log.error("gen.sweep_query_invalid", { dataType: typeof page });
      return SWEEP_SCAN_QUERY_FAILED;
    }
    let validatedPage: RecoverySweepRow[];
    try {
      validatedPage = validateAdminRows<RecoverySweepRow>("gen.sweep_page", page, {
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
      return SWEEP_SCAN_QUERY_FAILED;
    }
    scannedRows.push(...validatedPage);
    if (validatedPage.length < RECOVERY_SCAN_PAGE_SIZE) break;
  }
  return { kind: "rows", rows: scannedRows } as const;
}

/** 미완(=fal 요청 수 > 저장된 candidate 수) 중 어린 행을 제외해 회수 대상을 고른다. */
export function selectRecoveryTargets(
  rows: RecoverySweepRow[],
  counters: SweepCounters,
): RecoverySweepRow[] {
  const sweepScanTime = Date.now();
  const allTargets = rows.filter(
    (r) =>
      sweepScanTime - new Date(r.created_at).getTime() >= RECOVER_MIN_AGE_MS &&
      hasIncompleteCandidates(r.candidate_urls, r.fal_request_ids, r.gen_params),
  );
  const targets = allTargets.slice(0, SWEEP_LIMIT);
  if (allTargets.length > SWEEP_LIMIT) {
    counters.boundedBacklogs++;
  }
  return targets;
}

export async function terminalizeDeletedOwnerGenerations(
  admin: SupabaseClient,
  deadline: OpsMaintenanceDeadline,
  counters: SweepCounters,
): Promise<SweepStageEnd> {
  // 탈퇴 전 생성 RPC가 먼저 commit한 queued/done은 profiles soft-delete 뒤에도 남는다.
  // provider 회수와 별개로 매 cron에서 먼저 terminal+artifact cleanup으로 수렴시켜,
  // cleanup 완료 후 재활성 시 ghost generation이 되살아나지 않게 한다.
  if (opsMaintenanceDeadlineReached(deadline)) {
    return SWEEP_STAGE_DEADLINE;
  }
  const { data: deletedRows, error: deletedRowsError } = await admin
    .rpc("list_deleted_owner_inflight_generations", {
      p_limit: SWEEP_LIMIT,
    })
    .abortSignal(deadline.signal);
  if (opsMaintenanceDeadlineReached(deadline)) {
    return SWEEP_STAGE_DEADLINE;
  }
  if (deletedRowsError) {
    counters.systemErrors++;
    log.warn(
      "gen.deleted_owner_generation_sweep_fail",
      errInfo(deletedRowsError),
    );
  } else if (!Array.isArray(deletedRows)) {
    counters.systemErrors++;
    log.warn("gen.deleted_owner_generation_sweep_invalid", {
      dataType: typeof deletedRows,
    });
  } else {
    if (boundedBatchMayHaveMore(deletedRows.length, SWEEP_LIMIT)) {
      counters.boundedBacklogs++;
    }
    for (const row of deletedRows as {
      id: string;
      owner_id: string;
    }[]) {
      if (opsMaintenanceDeadlineReached(deadline)) {
        return SWEEP_STAGE_DEADLINE;
      }
      const terminalized = await terminateDeletedOwnerGeneration(admin, {
        genId: row.id,
        ownerId: row.owner_id,
      });
      if (opsMaintenanceDeadlineReached(deadline)) {
        return SWEEP_STAGE_DEADLINE;
      }
      if (terminalized) counters.deletedOwnersTerminalized++;
      else counters.pending++;
    }
  }
  return SWEEP_STAGE_DONE;
}

export async function recoverIncompleteTargets(
  admin: SupabaseClient,
  deadline: OpsMaintenanceDeadline,
  counters: SweepCounters,
  targets: RecoverySweepRow[],
): Promise<SweepStageEnd> {
  for (const r of targets) {
    if (opsMaintenanceDeadlineReached(deadline)) {
      return SWEEP_STAGE_DEADLINE;
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
        return SWEEP_STAGE_DEADLINE;
      }
      if (rec.status === "ready") {
        counters.recovered++;
      } else if (rec.status === "owner_deleted") {
        const terminalized = await terminateDeletedOwnerGeneration(admin, {
          genId: r.id,
          ownerId: r.owner_id,
        });
        if (opsMaintenanceDeadlineReached(deadline)) {
          return SWEEP_STAGE_DEADLINE;
        }
        if (terminalized) counters.deletedOwnersTerminalized++;
        else counters.pending++;
      } else if (rec.status === "failed" && rec.definitive) {
        const marked = await failGeneration(
          admin,
          r.id,
          r.owner_id,
          rec.reason,
          r.version,
        );
        if (opsMaintenanceDeadlineReached(deadline)) {
          return SWEEP_STAGE_DEADLINE;
        }
        if (marked) counters.failed++;
        else counters.pending++;
      } else if (rec.status === "terminal") {
        // A concurrent pick/fail/expiry won. This row is intentionally not retried.
      } else {
        counters.pending++;
      }
    } catch (e) {
      if (opsMaintenanceDeadlineReached(deadline)) {
        return SWEEP_STAGE_DEADLINE;
      }
      counters.pending++;
      log.warn("gen.sweep_row_fail", { genId: r.id, ...errInfo(e) });
    }
  }
  return SWEEP_STAGE_DONE;
}

export async function failStuckQueuedGenerations(
  admin: SupabaseClient,
  deadline: OpsMaintenanceDeadline,
  counters: SweepCounters,
): Promise<SweepStageEnd> {
  // ── 좀비 백스톱: 일반 queued는 30분, submit 응답이 불확실한 행은 fal의
  //    signed webhook 2시간 재전송 창+10분 뒤에만 failed+환불한다.
  //    (A) fal 이 IN_QUEUE 로 무한 정체(완료 0)라 recovery 가 pending 만 반환 / (B) submit~request_id
  //    영속 사이 하드크래시로 request_id 없어 recovery 대상서 제외. 클라의 age>30분 fall-through 를
  //    cron 에도 둬 **브라우저 종료 사용자도 크레딧을 잃지 않게** 한다. 정상 행은 수분 내 done/failed 로
  //    빠지므로 각 상태의 deadline 밖도 포함해 상한 없이 스캔한다.
  //    failGeneration(RPC 멱등)이 queued→failed+환불을 원자 처리.
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
      return SWEEP_STAGE_DEADLINE;
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
      return SWEEP_STAGE_DEADLINE;
    }
    if (pageError || !Array.isArray(page)) {
      counters.systemErrors++;
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
      counters.systemErrors++;
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
      counters.boundedBacklogs++;
    }
    for (const g of stuck) {
      if (opsMaintenanceDeadlineReached(deadline)) {
        return SWEEP_STAGE_DEADLINE;
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
          return SWEEP_STAGE_DEADLINE;
        }
        if (marked) counters.stuckFailed++;
        else counters.pending++;
      } catch (e) {
        if (opsMaintenanceDeadlineReached(deadline)) {
          return SWEEP_STAGE_DEADLINE;
        }
        counters.pending++;
        log.warn("gen.stuck_sweep_item_fail", {
          genId: g.id,
          ...errInfo(e),
        });
      }
    }
  }
  return SWEEP_STAGE_DONE;
}

export async function expireStaleDoneGenerations(
  admin: SupabaseClient,
  deadline: OpsMaintenanceDeadline,
  counters: SweepCounters,
): Promise<SweepStageEnd> {
  // ── 미선택 완료 만료: 생성 성공은 소비 확정이라는 제품 정책을 지키며 환급 없이
  //    row-lock RPC로 done→expired. pick과 경합하면 conflict로 아무것도 지우지 않는다.
  const doneCutoff = new Date(Date.now() - CANDIDATE_TTL_MS).toISOString();
  if (opsMaintenanceDeadlineReached(deadline)) {
    return SWEEP_STAGE_DEADLINE;
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
    return SWEEP_STAGE_DEADLINE;
  }
  if (staleDoneError) {
    counters.systemErrors++;
    log.warn("gen.expiry_sweep_query_fail", errInfo(staleDoneError));
  } else if (!Array.isArray(staleDone)) {
    counters.systemErrors++;
    log.warn("gen.expiry_sweep_query_invalid", {
      dataType: typeof staleDone,
    });
  } else {
    if (boundedBatchMayHaveMore(staleDone.length, SWEEP_LIMIT)) {
      counters.boundedBacklogs++;
    }
    for (const g of staleDone as {
      id: string;
      owner_id: string;
      version: number;
    }[]) {
      if (opsMaintenanceDeadlineReached(deadline)) {
        return SWEEP_STAGE_DEADLINE;
      }
      const { data: expiryData, error: expiryError } = await admin
        .rpc("expire_generation", {
          p_gen_id: g.id,
          p_expected_version: g.version,
        })
        .abortSignal(deadline.signal);
      if (opsMaintenanceDeadlineReached(deadline)) {
        return SWEEP_STAGE_DEADLINE;
      }
      const outcome = (expiryData as { outcome?: string } | null)?.outcome;
      if (expiryError) {
        counters.pending++;
        log.warn("gen.expiry_sweep_item_fail", {
          genId: g.id,
          ...errInfo(expiryError),
        });
      } else if (outcome === "expired" || outcome === "already_expired") {
        counters.expired++;
      } else if (outcome === "conflict" || outcome === "version_conflict") {
        // The conflicting winner may still be an unexpired `done` update.
        // Without a re-read this run cannot prove the stale row disappeared.
        counters.pending++;
      } else {
        counters.pending++;
        log.warn("gen.expiry_sweep_item_unexpected", {
          genId: g.id,
          outcome: outcome ?? "missing",
        });
      }
    }
  }
  return SWEEP_STAGE_DONE;
}

export async function cleanupTerminalArtifacts(
  admin: SupabaseClient,
  deadline: OpsMaintenanceDeadline,
  counters: SweepCounters,
): Promise<SweepStageEnd> {
  // ── terminal artifact saga: NULL marker가 durable retry manifest다.
  //    candidate와 tmp face를 모두 지운 뒤에만 marker를 쓴다.
  if (opsMaintenanceDeadlineReached(deadline)) {
    return SWEEP_STAGE_DEADLINE;
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
    return SWEEP_STAGE_DEADLINE;
  }
  if (cleanupQueryError) {
    counters.systemErrors++;
    log.warn("gen.artifact_sweep_query_fail", errInfo(cleanupQueryError));
  } else if (!Array.isArray(cleanupRows)) {
    counters.systemErrors++;
    log.warn("gen.artifact_sweep_query_invalid", {
      dataType: typeof cleanupRows,
    });
  } else {
    if (boundedBatchMayHaveMore(cleanupRows.length, SWEEP_LIMIT)) {
      counters.boundedBacklogs++;
    }
    for (const g of cleanupRows as {
      id: string;
      owner_id: string;
      status: "failed" | "picked" | "expired";
    }[]) {
      if (opsMaintenanceDeadlineReached(deadline)) {
        return SWEEP_STAGE_DEADLINE;
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
        return SWEEP_STAGE_DEADLINE;
      }
      if (!cleanup.ok) {
        counters.cleanupPending++;
        log.warn("gen.artifact_sweep_item_fail", {
          genId: g.id,
          stage: cleanup.stage,
          outcome: cleanup.outcome,
          ...errInfo(cleanup.error),
        });
      } else {
        counters.artifactsCleaned++;
      }
    }
  }
  return SWEEP_STAGE_DONE;
}

export async function reRefundFailedGenerations(
  admin: SupabaseClient,
  deadline: OpsMaintenanceDeadline,
  counters: SweepCounters,
): Promise<SweepStageEnd> {
  // ── 안전망: 미환급 실패 생성 재환급(§19) — status='failed'·refunded_at=NULL·credit_lot_id set 로
  //    고착된 소비 크레딧(failGeneration 의 done-fallback flip↔환급 RPC 사이 크래시 윈도우 잔여)을
  //    멱등 RPC 로 회수. idx_ai_generations_refund_pending 사용. ops(credit_lot_id NULL)는 predicate 로 제외.
  if (opsMaintenanceDeadlineReached(deadline)) {
    return SWEEP_STAGE_DEADLINE;
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
    return SWEEP_STAGE_DEADLINE;
  }
  if (prErr) {
    counters.systemErrors++;
    log.warn("gen.refund_sweep_query_fail", errInfo(prErr));
  } else if (!Array.isArray(pendingRefunds)) {
    counters.systemErrors++;
    log.warn("gen.refund_sweep_query_invalid", {
      dataType: typeof pendingRefunds,
    });
  } else {
    if (boundedBatchMayHaveMore(pendingRefunds.length, SWEEP_LIMIT)) {
      counters.boundedBacklogs++;
    }
    for (const g of pendingRefunds as {
      id: string;
      fail_reason: string | null;
    }[]) {
      if (opsMaintenanceDeadlineReached(deadline)) {
        return SWEEP_STAGE_DEADLINE;
      }
      try {
        const { error: rErr } = await admin
          .rpc("mark_generation_failed_and_refund", {
            p_gen_id: g.id,
            p_fail_reason: g.fail_reason ?? "recover_sweep",
          })
          .abortSignal(deadline.signal);
        if (opsMaintenanceDeadlineReached(deadline)) {
          return SWEEP_STAGE_DEADLINE;
        }
        if (rErr) {
          counters.refundPending++;
          log.warn("gen.refund_sweep_item_fail", {
            genId: g.id,
            ...errInfo(rErr),
          });
        } else counters.reRefunded++;
      } catch (e) {
        if (opsMaintenanceDeadlineReached(deadline)) {
          return SWEEP_STAGE_DEADLINE;
        }
        counters.refundPending++;
        log.warn("gen.refund_sweep_item_fail", {
          genId: g.id,
          ...errInfo(e),
        });
      }
    }
  }
  return SWEEP_STAGE_DONE;
}

