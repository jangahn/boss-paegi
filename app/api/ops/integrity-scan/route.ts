import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { ANTI_ABUSE_RULES_VERSION } from "@/lib/anti-abuse-rules";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 어뷰징 백스톱 스캔 — cron-job.org 가 x-cron-secret 로 호출(머신, requireAdmin 아님).
 * 최근 registered 점수를 확정 텔레메트리와 대조(C1 score·C1b duration·C2 세션apm·C8 suspicious)해
 * 사후 pending 처리(제출시점 payload 신호가 못 잡은 것 백스톱). registered→pending 만, idempotent.
 * (제출시점 즉시 신호는 /api/score; 이건 텔레메트리 지연분 보완.)
 */
export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: "scan_disabled" }, { status: 503 });
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("integrity_scan_recent", {
    p_hours: 6,
    p_rules: ANTI_ABUSE_RULES_VERSION,
  });
  if (error) {
    log.error("integrity.scan_fail", errInfo(error));
    return NextResponse.json({ error: "scan_failed" }, { status: 500 });
  }
  const result = (data ?? {}) as { scanned?: number; flagged?: number };
  log.info("integrity.scan_ok", { scanned: result.scanned ?? 0, flagged: result.flagged ?? 0 });
  return NextResponse.json({ ok: true, ...result });
}
