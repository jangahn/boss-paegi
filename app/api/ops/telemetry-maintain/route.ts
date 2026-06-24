import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 텔레메트리 유지보수 — cron-job.org 가 x-cron-secret 헤더로 일1회 호출(머신, requireAdmin 아님).
 * 순서·실패 게이팅: ①telemetry_rollup_days(3)[KST·최근3일 delete-재계산] 성공 → ②telemetry_prune()
 * [30일 timeline null·target 초과 우선순위 삭제] → ③telemetry_budget_refresh()[크기 기준 degrade].
 * rollup 실패 시 prune 미실행(롤업 선행 보존). 전부 service_role RPC.
 */
export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "maintain_disabled" }, { status: 503 });
  }
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();

  // ① 롤업(영구 — 선행)
  const { data: rollup, error: rollupErr } = await admin.rpc("telemetry_rollup_days", { p_days: 3 });
  if (rollupErr) {
    log.error("telemetry.rollup_fail", errInfo(rollupErr));
    return NextResponse.json({ error: "rollup_failed" }, { status: 500 });
  }

  // ② prune(롤업 성공 후에만 — 원시 삭제가 집계를 앞지르지 않게)
  const { data: prune, error: pruneErr } = await admin.rpc("telemetry_prune");
  if (pruneErr) {
    log.warn("telemetry.prune_fail", errInfo(pruneErr));
  }

  // ③ budget 갱신(크기 기준 degrade_mode)
  const { data: budget, error: budgetErr } = await admin.rpc("telemetry_budget_refresh");
  if (budgetErr) {
    log.warn("telemetry.budget_refresh_fail", errInfo(budgetErr));
  }

  log.info("telemetry.maintain_done", {
    rollup: rollup ?? null,
    prune: pruneErr ? "fail" : prune ?? null,
    budget: budgetErr ? "fail" : budget ?? null,
  });
  return NextResponse.json({ ok: true, rollup, prune: prune ?? null, budget: budget ?? null });
}
