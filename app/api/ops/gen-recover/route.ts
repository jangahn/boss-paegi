import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { cronSecretMatches } from "@/lib/ops-auth";
import {
  createOpsMaintenanceDeadline,
  opsMaintenanceDeadlineReached,
  opsMaintenanceResponseInit,
  opsMaintenanceStatus,
  runOpsMaintenanceWithDeadline,
} from "@/lib/ops-maintenance-status";
import {
  cleanupTerminalArtifacts,
  continuePendingPreflights,
  createSweepCounters,
  releaseStalePreflights,
  expireStaleDoneGenerations,
  failStuckQueuedGenerations,
  recoverIncompleteTargets,
  reRefundFailedGenerations,
  scanRecoveryWindow,
  selectRecoveryTargets,
  terminalizeDeletedOwnerGenerations,
} from "@/lib/character-gen/generation-sweep";
import { log } from "@/lib/log";
import {
  recordOpsCronHeartbeat,
  alertIfOpsCronSilent,
} from "@/lib/ops-cron-heartbeat";

export const runtime = "nodejs";
// 외부 scheduler의 90초 timeout보다 먼저 non-2xx로 끝나는 hard ceiling.
// 모든 전이는 durable CAS/receipt 기반이라 platform timeout 뒤 같은 job 재실행이 안전하다.
export const maxDuration = 25;

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

      // 스테이지 실체는 lib/character-gen/generation-sweep(v1.04) — 순서·카운터 의미는
      // 원 구현 그대로. 어느 스테이지든 deadline 을 넘기면 남은 작업을 다음 틱에 넘기고
      // 스케줄러에는 non-2xx(재시도)로 알린다.
      const counters = createSweepCounters();
      const scan = await scanRecoveryWindow(admin, deadline);
      if (scan.kind === "deadline") {
        return maintenanceTimeBudgetResponse();
      }
      if (scan.kind === "query_failed") {
        await heartbeat(admin, "failure", "query_failed", deadline.signal);
        return NextResponse.json(
          { error: "query_failed" },
          opsMaintenanceResponseInit(503),
        );
      }
      const targets = selectRecoveryTargets(scan.rows, counters);

      for (const stage of [
        // v1.20: 웹훅이 놓친 accepted/committed 예약을 서버가 먼저 이어간다(사용자 대기 최소화).
        () => continuePendingPreflights(admin, deadline, counters),
        () => terminalizeDeletedOwnerGenerations(admin, deadline, counters),
        () => recoverIncompleteTargets(admin, deadline, counters, targets),
        () => failStuckQueuedGenerations(admin, deadline, counters),
        () => expireStaleDoneGenerations(admin, deadline, counters),
        () => cleanupTerminalArtifacts(admin, deadline, counters),
        () => reRefundFailedGenerations(admin, deadline, counters),
        // v1.20: 10분+ 방치된 예약은 사용자 재진입 없이도 환불·종결.
        () => releaseStalePreflights(admin, deadline, counters),
      ]) {
        const end = await stage();
        if (end.kind === "deadline") {
          return maintenanceTimeBudgetResponse();
        }
      }

      const retryPending =
        counters.pending + counters.cleanupPending + counters.refundPending;
      const result = {
        scanned: scan.rows.length,
        targeted: targets.length,
        continued: counters.continued,
        continuePending: counters.continuePending,
        stalePreflightsReleased: counters.stalePreflightsReleased,
        recovered: counters.recovered,
        failed: counters.failed,
        pending: counters.pending,
        deletedOwnersTerminalized: counters.deletedOwnersTerminalized,
        stuckFailed: counters.stuckFailed,
        expired: counters.expired,
        artifactsCleaned: counters.artifactsCleaned,
        cleanupPending: counters.cleanupPending,
        reRefunded: counters.reRefunded,
        refundPending: counters.refundPending,
        boundedBacklogs: counters.boundedBacklogs,
        retryPending,
        systemErrors: counters.systemErrors,
      };
      const status = opsMaintenanceStatus({
        systemErrors: counters.systemErrors,
        retryPending,
        boundedBacklogs: counters.boundedBacklogs,
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
