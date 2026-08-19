import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { SERVER_ENV } from "@/lib/env.server";
import { cronSecretMatches } from "@/lib/ops-auth";
import {
  createOpsMaintenanceDeadline,
  opsMaintenanceDeadlineReached,
  opsMaintenanceResponseInit,
  runOpsMaintenanceWithDeadline,
} from "@/lib/ops-maintenance-status";
import { SITE_URL } from "@/lib/site";
import { log } from "@/lib/log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 25;

/**
 * 함수 웜 유지 스윕 — cron-job.org 가 x-cron-secret 헤더로 수분 주기 호출(머신).
 *
 * Vercel Hobby + 저트래픽에서는 라우트별 람다가 대부분 콜드라, 사용자가 상호작용하는
 * 순간(로그인 콜백 체인·재방문 reconcile 문서·랭킹 조회)마다 콜드스타트를 문다
 * (2026-08-19 실측: oauth-flow/status cold 2.08s·finalize 1.44s·/auth/reconcile 문서
 * 2.55s ↔ 웜 0.2~0.5s). 이 라우트는 그 표면들을 자기 origin 으로 짧게 fetch 해
 * 함수 인스턴스를 웜 상태로 유지한다.
 *
 * - 대상 응답 코드는 무관(빈 body POST 는 4xx 가 정상) — 목적은 함수 초기화뿐이라
 *   status 는 관측용으로만 요약한다.
 * - 이 라우트 자신은 대상 실패와 무관하게 200 — cron-job.org 가 4xx/5xx 연속 실패로
 *   잡을 자동 비활성 방지(reconcile 잡이 실제로 그렇게 죽어 있던 전례, 2026-08-19).
 */
const WARM_TARGETS: ReadonlyArray<{
  path: string;
  method: "GET" | "POST";
}> = [
  { path: "/api/auth/oauth-flow/status", method: "POST" },
  { path: "/api/auth/oauth-flow/preflight", method: "POST" },
  { path: "/api/auth/oauth-flow/bind-target", method: "POST" },
  { path: "/api/auth/oauth-flow/finalize", method: "POST" },
  { path: "/api/auth/oauth-flow/release", method: "POST" },
  { path: "/auth/reconcile", method: "GET" },
  { path: "/api/events/active", method: "GET" },
  { path: "/api/leaderboard?range=month", method: "GET" },
];

const WARM_FETCH_TIMEOUT_MS = 8_000;

export async function POST(req: NextRequest) {
  const secret = SERVER_ENV.CRON_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "disabled" },
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
      const results = await Promise.all(
        WARM_TARGETS.map(async ({ path, method }) => {
          // 남은 예산이 부족하면 남은 대상은 다음 주기로 넘긴다(협조적 펜스).
          if (opsMaintenanceDeadlineReached(deadline, 1_000)) {
            return { path, status: -1 };
          }
          try {
            const res = await fetch(`${SITE_URL}${path}`, {
              method,
              cache: "no-store",
              redirect: "manual",
              headers:
                method === "POST"
                  ? { "content-type": "application/json" }
                  : undefined,
              body: method === "POST" ? "{}" : undefined,
              signal: AbortSignal.any([
                deadline.signal,
                AbortSignal.timeout(WARM_FETCH_TIMEOUT_MS),
              ]),
            });
            // 연결 정리를 위해 body 는 소비만 하고 버린다(대상 응답은 전부 소형).
            await res.arrayBuffer().catch(() => undefined);
            return { path, status: res.status };
          } catch {
            return { path, status: 0 };
          }
        }),
      );
      const unreachable = results.filter((r) => r.status === 0);
      if (unreachable.length > 0) {
        log.warn("ops.warm_target_unreachable", {
          targets: unreachable.map((r) => r.path).join(","),
        });
      }
      return NextResponse.json({ ok: true, results });
    },
    () =>
      NextResponse.json(
        { error: "maintenance_time_budget" },
        opsMaintenanceResponseInit(429),
      ),
  );
}
