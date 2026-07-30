import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import {
  parseAnalyticsPruneAck,
  parseRollupMaintenanceAck,
  resolveOpsRpc,
} from "@/lib/ops-rpc-result";
import { log, errInfo } from "@/lib/log";
import { cronSecretMatches } from "@/lib/ops-auth";
import {
  createOpsMaintenanceDeadline,
  opsMaintenanceDeadlineReached,
  opsMaintenanceResponseInit,
  runOpsMaintenanceWithDeadline,
} from "@/lib/ops-maintenance-status";

export const runtime = "nodejs";
export const maxDuration = 25;
const ROLLUP_DAYS = 7;
const RETENTION_DAYS = 90;

function maintenanceTimeBudgetResponse() {
  return NextResponse.json(
    { ok: false, error: "maintenance_time_budget", retryPending: 1 },
    opsMaintenanceResponseInit(429),
  );
}

/**
 * 공유·유입 분석 유지보수 — cron-job.org 가 x-cron-secret(=CRON_SECRET) 으로 일1회 호출(머신, requireAdmin 아님).
 * 텔레메트리와 **별도 cron**(도메인 격리). 순서·게이팅: ①maintain_analytics_rollups(7)[idempotent
 * delete-재계산 + advisory lock] 성공 → ②prune_analytics_events(90)[당일 제외·raw 90일]. rollup 실패 시
 * prune 미실행(원시 삭제가 집계 앞지르지 않게). 전부 service_role RPC.
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

      // ① 롤업(idempotent — 선행)
      const rollupRpc = await resolveOpsRpc(() =>
        admin
          .rpc("maintain_analytics_rollups", { p_days: ROLLUP_DAYS })
          .abortSignal(deadline.signal),
      );
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (!rollupRpc.ok) {
        log.error("analytics.rollup_fail", errInfo(rollupRpc.error));
        return NextResponse.json(
          { error: "rollup_failed" },
          opsMaintenanceResponseInit(500),
        );
      }
      const rollup = parseRollupMaintenanceAck(rollupRpc.data, ROLLUP_DAYS);
      if (!rollup) {
        log.error("analytics.rollup_invalid", {
          error: "invalid_rollup_response",
        });
        return NextResponse.json(
          { error: "rollup_failed" },
          opsMaintenanceResponseInit(500),
        );
      }

      // ② prune(롤업 성공 후에만 — raw 90일·당일 보존)
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      const pruneRpc = await resolveOpsRpc(() =>
        admin
          .rpc("prune_analytics_events", {
            p_retention_days: RETENTION_DAYS,
          })
          .abortSignal(deadline.signal),
      );
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (!pruneRpc.ok) {
        log.error("analytics.prune_fail", errInfo(pruneRpc.error));
        return NextResponse.json(
          { error: "prune_failed" },
          opsMaintenanceResponseInit(500),
        );
      }
      const prune = parseAnalyticsPruneAck(pruneRpc.data);
      if (!prune) {
        log.error("analytics.prune_invalid", {
          error: "invalid_prune_response",
        });
        return NextResponse.json(
          { error: "prune_failed" },
          opsMaintenanceResponseInit(500),
        );
      }

      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      log.info("analytics.maintain_done", { rollup, prune });
      return NextResponse.json(
        { ok: true, rollup, prune },
        opsMaintenanceResponseInit(200),
      );
    },
    () => {
      log.error("analytics.maintenance_time_budget");
      return maintenanceTimeBudgetResponse();
    },
  );
}
