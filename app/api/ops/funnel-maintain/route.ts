import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import {
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
const ROLLUP_DAYS = 3;

function maintenanceTimeBudgetResponse() {
  return NextResponse.json(
    { ok: false, error: "maintenance_time_budget", retryPending: 1 },
    opsMaintenanceResponseInit(429),
  );
}

/**
 * 가입·구매 퍼널 코호트 롤업(0112) — cron-job.org 가 x-cron-secret(=CRON_SECRET) 으로 일1회 호출.
 * `admin_funnel_rollup_days(3)`[idempotent delete-재계산 + advisory lock] 단일 스테이지.
 * 하이브리드(v1.06) 규약상 자정 직후(KST) 실행이 전제 — 어제가 롤업 관할로 넘어가는 경계를 봉인한다.
 * prune 없음(원천=계정·주문 영구 보존). 텔레메트리·공유유입 maintain 과 별도 잡(도메인 분리).
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

      const rollupRpc = await resolveOpsRpc(() =>
        admin
          .rpc("admin_funnel_rollup_days", { p_days: ROLLUP_DAYS })
          .abortSignal(deadline.signal),
      );
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (!rollupRpc.ok) {
        log.error("funnel.rollup_fail", errInfo(rollupRpc.error));
        return NextResponse.json(
          { error: "rollup_failed" },
          opsMaintenanceResponseInit(500),
        );
      }
      const rollup = parseRollupMaintenanceAck(rollupRpc.data, ROLLUP_DAYS);
      if (!rollup) {
        log.error("funnel.rollup_invalid", {
          error: "invalid_rollup_response",
        });
        return NextResponse.json(
          { error: "rollup_failed" },
          opsMaintenanceResponseInit(500),
        );
      }

      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      log.info("funnel.maintain_done", { rollup });
      return NextResponse.json(
        { ok: true, rollup },
        opsMaintenanceResponseInit(200),
      );
    },
    () => {
      log.error("funnel.maintenance_time_budget");
      return maintenanceTimeBudgetResponse();
    },
  );
}
