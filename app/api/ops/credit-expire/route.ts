import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { SERVER_ENV } from "@/lib/env.server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
// sweep 반복 시간버짓(45s) + 마무리 여유.
export const maxDuration = 60;

/**
 * 크레딧 로트 자연 만료 cron(§B.8.6) — cron-job.org 가 x-cron-secret 헤더로 주기 호출(머신).
 * drain 경로(만료는 1회성 전이·완전 멱등)라 유지보수 게이트와 무관하게 항상 동작한다.
 * sweep_expired(500) 를 배치 소진(expired<500) 또는 시간버짓(45s)까지 반복하고
 * ops_cron_heartbeat 로 심박을 남긴다. 응답 키는 snake_case 그대로(camel 변환 금지 — §10.2).
 */
const SWEEP_LIMIT = 500;
const TIME_BUDGET_MS = 45_000;

export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json({ error: "credit_expire_disabled" }, { status: 503 });
  }
  if (req.headers.get("x-cron-secret") !== secret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const admin = createAdminClient();
  // 심박은 best-effort — 기록 실패가 만료 sweep 자체를 막지 않는다(경고만).
  const heartbeat = async (phase: "start" | "success" | "failure", errorCode?: string) => {
    const { error } = await admin.rpc("ops_cron_heartbeat", {
      p_job: "credit-expire",
      p_phase: phase,
      p_error_code: errorCode ?? null,
    });
    if (error) log.warn("ops.credit_expire_heartbeat_fail", { phase, ...errInfo(error) });
  };

  await heartbeat("start");

  const startedAt = Date.now();
  let expiredLots = 0;
  let iterations = 0;
  let done = false;
  for (;;) {
    const { data, error } = await admin.rpc("sweep_expired", { p_limit: SWEEP_LIMIT });
    if (error) {
      log.error("ops.credit_expire_fail", { iterations, expiredLots, ...errInfo(error) });
      await heartbeat("failure", "sweep_failed");
      return NextResponse.json(
        { ok: false, error: "sweep_failed", expired_lots: expiredLots, iterations },
        { status: 500 }
      );
    }
    iterations += 1;
    const expired = (data as { expired?: number } | null)?.expired ?? 0;
    expiredLots += expired;
    if (expired < SWEEP_LIMIT) {
      done = true; // 배치 소진 — 만료 대상 로트 없음
      break;
    }
    if (Date.now() - startedAt >= TIME_BUDGET_MS) {
      break; // 시간버짓 도달 — 잔여는 다음 호출이 이어서 처리(멱등)
    }
  }

  await heartbeat("success");
  log.info("ops.credit_expire_ok", { expiredLots, iterations, done });
  return NextResponse.json({ ok: true, expired_lots: expiredLots, iterations, done });
}
