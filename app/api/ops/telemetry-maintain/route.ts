import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 텔레메트리 유지보수 — cron-job.org 가 x-cron-secret 헤더로 일1회 호출(머신, requireAdmin 아님).
 * 순서·실패 게이팅: ①telemetry_rollup_days(3)[KST·최근3일 delete-재계산] 성공 → ②telemetry_prune()
 * [30일 timeline null·target 초과 우선순위 삭제] → ③telemetry_budget_refresh()[크기 기준 degrade]
 * → ④공유·유입 analytics(maintain_analytics_rollups → prune_analytics_events, 격리 도메인·실패 무영향).
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

  // ④ 공유·유입 analytics 롤업 + prune — 격리 도메인. 실패해도 텔레메트리 결과·응답 무영향(try/catch).
  //    maintain(idempotent·advisory lock) 성공 시에만 prune(원시 삭제가 집계 앞지르지 않게).
  let analytics: unknown = null;
  let analyticsErr: string | null = null;
  try {
    const { data: aRollup, error: aErr } = await admin.rpc("maintain_analytics_rollups", { p_days: 7 });
    if (aErr) throw aErr;
    const { error: apErr } = await admin.rpc("prune_analytics_events", { p_retention_days: 90 });
    if (apErr) log.warn("analytics.prune_fail", errInfo(apErr));
    analytics = aRollup ?? null;
  } catch (e) {
    analyticsErr = "fail";
    log.warn("analytics.maintain_fail", errInfo(e));
  }

  log.info("telemetry.maintain_done", {
    rollup: rollup ?? null,
    prune: pruneErr ? "fail" : prune ?? null,
    budget: budgetErr ? "fail" : budget ?? null,
    analytics: analyticsErr ?? analytics,
  });
  return NextResponse.json({
    ok: true,
    rollup,
    prune: prune ?? null,
    budget: budget ?? null,
    analytics: analyticsErr ?? analytics,
  });
}
