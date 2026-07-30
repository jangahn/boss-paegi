import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { ANTI_ABUSE_RULES_VERSION } from "@/lib/anti-abuse-rules";
import { parseIntegrityScanAck, resolveOpsRpc } from "@/lib/ops-rpc-result";
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

function maintenanceTimeBudgetResponse() {
  return NextResponse.json(
    { ok: false, error: "maintenance_time_budget", retryPending: 1 },
    opsMaintenanceResponseInit(429),
  );
}

/**
 * 어뷰징 백스톱 스캔 — cron-job.org 가 x-cron-secret 로 호출(머신, requireAdmin 아님).
 * 최근 registered 점수를 확정 텔레메트리와 대조(C1 score·C1b duration·C2 세션apm·C8 suspicious)해
 * 사후 pending 처리(제출시점 payload 신호가 못 잡은 것 백스톱). registered→pending 만, idempotent.
 * (제출시점 즉시 신호는 /api/score; 이건 텔레메트리 지연분 보완.)
 */
export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "scan_disabled" },
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
      const scanRpc = await resolveOpsRpc(() =>
        admin
          .rpc("integrity_scan_recent", {
            p_hours: 6,
            p_rules: ANTI_ABUSE_RULES_VERSION,
          })
          .abortSignal(deadline.signal),
      );
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (!scanRpc.ok) {
        log.error("integrity.scan_fail", errInfo(scanRpc.error));
        return NextResponse.json(
          { error: "scan_failed" },
          opsMaintenanceResponseInit(500),
        );
      }
      const result = parseIntegrityScanAck(scanRpc.data);
      if (!result) {
        log.error("integrity.scan_invalid", {
          error: "invalid_scan_response",
        });
        return NextResponse.json(
          { error: "scan_failed" },
          opsMaintenanceResponseInit(500),
        );
      }
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      log.info("integrity.scan_ok", result);
      return NextResponse.json(
        { ok: true, ...result },
        opsMaintenanceResponseInit(200),
      );
    },
    () => {
      log.error("integrity.maintenance_time_budget");
      return maintenanceTimeBudgetResponse();
    },
  );
}
