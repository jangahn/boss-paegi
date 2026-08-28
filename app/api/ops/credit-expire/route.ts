import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { parseCreditSweepAck, resolveOpsRpc } from "@/lib/ops-rpc-result";
import {
  createOpsMaintenanceDeadline,
  opsMaintenanceDeadlineReached,
  opsMaintenanceResponseInit,
  opsMaintenanceStatus,
  runOpsMaintenanceWithDeadline,
} from "@/lib/ops-maintenance-status";
import { log, errInfo } from "@/lib/log";
import { recordOpsCronHeartbeat } from "@/lib/ops-cron-heartbeat";
import { cronSecretMatches } from "@/lib/ops-auth";

export const runtime = "nodejs";
// 외부 scheduler 90초보다 먼저 25초 platform ceiling이 종료한다.
// 20초 soft budget 뒤 failure heartbeat와 응답 직렬화 여유를 남긴다.
export const maxDuration = 25;

/**
 * 크레딧 로트 자연 만료 cron(§B.8.6) — cron-job.org 가 x-cron-secret 헤더로 주기 호출(머신).
 * drain 경로(만료는 1회성 전이·완전 멱등)라 유지보수 게이트와 무관하게 항상 동작한다.
 * sweep_expired(500) 를 배치 소진(expired<500) 또는 시간버짓(20s)까지 반복하고
 * ops_cron_heartbeat 로 심박을 남긴다. 응답 키는 snake_case 그대로(camel 변환 금지 — §10.2).
 */
const SWEEP_LIMIT = 500;

type HeartbeatPhase = "start" | "success" | "failure";

/** Best-effort heartbeat — 공용 기록기(lib/ops-cron-heartbeat) 위임; timeout callback passes a fresh bounded signal. */
async function heartbeat(
  admin: ReturnType<typeof createAdminClient>,
  phase: HeartbeatPhase,
  errorCode?: string,
  signal?: AbortSignal,
) {
  await recordOpsCronHeartbeat(admin, "credit-expire", phase, errorCode, signal);
}

function maintenanceTimeBudgetResponse() {
  return NextResponse.json(
    {
      ok: false,
      error: "maintenance_time_budget",
      retry_pending: 1,
    },
    opsMaintenanceResponseInit(429),
  );
}

export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "credit_expire_disabled" },
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
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }

      let expiredLots = 0;
      let iterations = 0;
      let done = false;
      for (;;) {
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        const sweepRpc = await resolveOpsRpc(() =>
          admin
            .rpc("sweep_expired", { p_limit: SWEEP_LIMIT })
            .abortSignal(deadline.signal),
        );
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        if (!sweepRpc.ok) {
          log.error("ops.credit_expire_fail", {
            iterations,
            expiredLots,
            ...errInfo(sweepRpc.error),
          });
          await heartbeat(admin, "failure", "sweep_failed", deadline.signal);
          return NextResponse.json(
            {
              ok: false,
              error: "sweep_failed",
              expired_lots: expiredLots,
              iterations,
            },
            opsMaintenanceResponseInit(503),
          );
        }
        const sweep = parseCreditSweepAck(sweepRpc.data, SWEEP_LIMIT);
        if (!sweep) {
          log.error("ops.credit_expire_invalid", {
            iterations,
            expiredLots,
            error: "invalid_sweep_response",
          });
          await heartbeat(
            admin,
            "failure",
            "invalid_sweep_response",
            deadline.signal,
          );
          return NextResponse.json(
            {
              ok: false,
              error: "sweep_failed",
              expired_lots: expiredLots,
              iterations,
            },
            opsMaintenanceResponseInit(503),
          );
        }
        iterations += 1;
        const expired = sweep.expired;
        expiredLots += expired;
        if (expired < SWEEP_LIMIT) {
          done = true; // 배치 소진 — 만료 대상 로트 없음
          break;
        }
        if (opsMaintenanceDeadlineReached(deadline, 2_000)) {
          break; // 시간버짓 도달 — 잔여는 다음 호출이 이어서 처리(멱등)
        }
      }

      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      const status = opsMaintenanceStatus({
        systemErrors: 0,
        retryPending: done ? 0 : 1,
      });
      if (status === 200) {
        await heartbeat(admin, "success", undefined, deadline.signal);
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        log.info("ops.credit_expire_ok", {
          expiredLots,
          iterations,
          done,
        });
      } else {
        await heartbeat(
          admin,
          "failure",
          "time_budget_backlog",
          deadline.signal,
        );
        if (opsMaintenanceDeadlineReached(deadline)) {
          return maintenanceTimeBudgetResponse();
        }
        log.warn("ops.credit_expire_incomplete", {
          expiredLots,
          iterations,
          done,
        });
      }
      return NextResponse.json(
        {
          ok: status === 200,
          expired_lots: expiredLots,
          iterations,
          done,
          retry_pending: done ? 0 : 1,
        },
        opsMaintenanceResponseInit(status),
      );
    },
    async () => {
      log.error("ops.credit_expire_maintenance_time_budget");
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
