import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import {
  parseRollupMaintenanceAck,
  parseTelemetryBudgetAck,
  parseTelemetryPruneAck,
  resolveOpsRpc,
} from "@/lib/ops-rpc-result";
import { runPublicWriteQuotaPrune } from "@/lib/public-write-quota-maintenance";
import {
  createOpsMaintenanceDeadline,
  opsMaintenanceDeadlineReached,
  opsMaintenanceResponseInit,
  runOpsMaintenanceWithDeadline,
} from "@/lib/ops-maintenance-status";
import { log, errInfo } from "@/lib/log";
import { cronSecretMatches } from "@/lib/ops-auth";

export const runtime = "nodejs";
// 외부 scheduler 90초보다 짧아 hung DB work도 non-2xx로 보인다.
export const maxDuration = 25;
const ROLLUP_DAYS = 3;

function maintenanceTimeBudgetResponse() {
  return NextResponse.json(
    { ok: false, error: "maintenance_time_budget", retryPending: 1 },
    opsMaintenanceResponseInit(429),
  );
}

/**
 * 텔레메트리 유지보수 — cron-job.org 가 x-cron-secret 헤더로 일1회 호출(머신, requireAdmin 아님).
 * 순서·실패 게이팅: ①prune_public_write_quota_buckets(80000) 최대2회
 * [독립 3일 target·78005 일일 생성 ceiling보다 큰 단일 batch]
 * → ②telemetry_rollup_days(3)[KST·최근3일 delete-재계산] 성공 → ③telemetry_prune()
 * [30일 timeline null·target 초과 우선순위 삭제] → ④telemetry_budget_refresh()[크기 기준 degrade].
 * rollup 실패 시 prune 미실행(롤업 선행 보존). 전부 service_role RPC.
 * (공유·유입 analytics 롤업은 별도 cron `/api/ops/analytics-maintain` — 도메인 격리.)
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

      // ① public-write opaque actor quota retention. Run this independent
      // privacy target first so later telemetry failures cannot suppress it.
      const quotaPruneRun = await runPublicWriteQuotaPrune((limit) =>
        admin
          .rpc("prune_public_write_quota_buckets", {
            p_limit: limit,
          })
          .abortSignal(deadline.signal),
      );
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (!quotaPruneRun.ok) {
        log.error("telemetry.public_write_quota_prune_fail", {
          stage: quotaPruneRun.reason,
          ...(quotaPruneRun.cause ? errInfo(quotaPruneRun.cause) : {}),
        });
      } else if (!quotaPruneRun.summary.done) {
        log.warn(
          "telemetry.public_write_quota_prune_backlog",
          quotaPruneRun.summary,
        );
      }

      // ② 롤업(영구 — telemetry prune 선행)
      const rollupRpc = await resolveOpsRpc(() =>
        admin
          .rpc("telemetry_rollup_days", { p_days: ROLLUP_DAYS })
          .abortSignal(deadline.signal),
      );
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (!rollupRpc.ok) {
        log.error("telemetry.rollup_fail", errInfo(rollupRpc.error));
        return NextResponse.json(
          { error: "rollup_failed" },
          opsMaintenanceResponseInit(500),
        );
      }
      const rollup = parseRollupMaintenanceAck(rollupRpc.data, ROLLUP_DAYS);
      if (!rollup) {
        log.error("telemetry.rollup_invalid", {
          error: "invalid_rollup_response",
        });
        return NextResponse.json(
          { error: "rollup_failed" },
          opsMaintenanceResponseInit(500),
        );
      }

      // ③ prune(롤업 성공 후에만 — 원시 삭제가 집계를 앞지르지 않게)
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      const pruneRpc = await resolveOpsRpc(() =>
        admin.rpc("telemetry_prune").abortSignal(deadline.signal),
      );
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (!pruneRpc.ok) {
        log.error("telemetry.prune_fail", errInfo(pruneRpc.error));
        return NextResponse.json(
          { error: "prune_failed" },
          opsMaintenanceResponseInit(500),
        );
      }
      const prune = parseTelemetryPruneAck(pruneRpc.data);
      if (!prune) {
        log.error("telemetry.prune_invalid", {
          error: "invalid_prune_response",
        });
        return NextResponse.json(
          { error: "prune_failed" },
          opsMaintenanceResponseInit(500),
        );
      }

      // ④ budget 갱신(크기 기준 degrade_mode)
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      const budgetRpc = await resolveOpsRpc(() =>
        admin.rpc("telemetry_budget_refresh").abortSignal(deadline.signal),
      );
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (!budgetRpc.ok) {
        log.error("telemetry.budget_refresh_fail", errInfo(budgetRpc.error));
        return NextResponse.json(
          { error: "budget_refresh_failed" },
          opsMaintenanceResponseInit(500),
        );
      }
      const budget = parseTelemetryBudgetAck(budgetRpc.data);
      if (!budget) {
        log.error("telemetry.budget_refresh_invalid", {
          error: "invalid_budget_refresh_response",
        });
        return NextResponse.json(
          { error: "budget_refresh_failed" },
          opsMaintenanceResponseInit(500),
        );
      }

      // Quota retention is independent: defer its non-green decision until
      // every otherwise-valid telemetry maintenance stage above has run.
      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      if (!quotaPruneRun.ok) {
        return NextResponse.json(
          {
            ok: false,
            error: "public_write_quota_prune_failed",
            rollup,
            prune,
            budget,
          },
          opsMaintenanceResponseInit(500),
        );
      }
      const quotaPrune = quotaPruneRun.summary;
      if (!quotaPrune.done) {
        return NextResponse.json(
          {
            ok: false,
            error: "public_write_quota_prune_backlog",
            rollup,
            prune,
            budget,
            quota_prune: quotaPrune,
          },
          opsMaintenanceResponseInit(503),
        );
      }
      if (budget.degrade_mode !== "full") {
        log.warn("telemetry.budget_backlog", {
          rollup,
          prune,
          budget,
          quota_prune: quotaPrune,
        });
        return NextResponse.json(
          {
            ok: false,
            error: "telemetry_budget_backlog",
            rollup,
            prune,
            budget,
            quota_prune: quotaPrune,
          },
          opsMaintenanceResponseInit(429),
        );
      }

      if (opsMaintenanceDeadlineReached(deadline)) {
        return maintenanceTimeBudgetResponse();
      }
      log.info("telemetry.maintain_done", {
        rollup,
        prune,
        budget,
        quota_prune: quotaPrune,
      });
      return NextResponse.json(
        {
          ok: true,
          rollup,
          prune,
          budget,
          quota_prune: quotaPrune,
        },
        opsMaintenanceResponseInit(200),
      );
    },
    () => {
      log.error("telemetry.maintenance_time_budget");
      return maintenanceTimeBudgetResponse();
    },
  );
}
