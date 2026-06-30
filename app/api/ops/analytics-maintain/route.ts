import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 공유·유입 분석 유지보수 — cron-job.org 가 x-cron-secret(=CRON_SECRET) 으로 일1회 호출(머신, requireAdmin 아님).
 * 텔레메트리와 **별도 cron**(도메인 격리). 순서·게이팅: ①maintain_analytics_rollups(7)[idempotent
 * delete-재계산 + advisory lock] 성공 → ②prune_analytics_events(90)[당일 제외·raw 90일]. rollup 실패 시
 * prune 미실행(원시 삭제가 집계 앞지르지 않게). 전부 service_role RPC.
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

  // ① 롤업(idempotent — 선행)
  const { data: rollup, error: rollupErr } = await admin.rpc("maintain_analytics_rollups", { p_days: 7 });
  if (rollupErr) {
    log.error("analytics.rollup_fail", errInfo(rollupErr));
    return NextResponse.json({ error: "rollup_failed" }, { status: 500 });
  }

  // ② prune(롤업 성공 후에만 — raw 90일·당일 보존)
  const { data: prune, error: pruneErr } = await admin.rpc("prune_analytics_events", { p_retention_days: 90 });
  if (pruneErr) {
    log.warn("analytics.prune_fail", errInfo(pruneErr));
  }

  log.info("analytics.maintain_done", { rollup: rollup ?? null, prune: pruneErr ? "fail" : prune ?? null });
  return NextResponse.json({ ok: true, rollup, prune: prune ?? null });
}
