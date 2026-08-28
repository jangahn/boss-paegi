import "server-only";
import type { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";

type AdminClient = ReturnType<typeof createAdminClient>;

/** ops cron 심박 대상 — DB RPC(ops_cron_heartbeat)의 허용 목록(0109)과 1:1. */
export type OpsCronJob = "credit-expire" | "reconcile" | "gen-recover";
export type OpsCronHeartbeatPhase = "start" | "success" | "failure";

/**
 * 잡별 침묵 임계 — 실행 주기(5분/일 1회)의 여유 배수. last_started_at 이 이보다 오래 멈추면
 * 스케줄러 쪽 고장(잡 삭제·비활성·URL/시크릿 드리프트)으로 보고 이웃 cron 이 error 로 승격한다.
 * cron-job.org 의 onFailure/onDisable 알림은 "실행됐지만 실패"만 덮고 "아예 안 옴"은 못 덮는다
 * (2026-08-28 점검에서 확인된 관측 공백 — gen-recover 는 DB 심박 자체가 없었음).
 */
export const OPS_CRON_STALE_THRESHOLD_MS: Record<OpsCronJob, number> = {
  reconcile: 20 * 60 * 1000,
  "gen-recover": 20 * 60 * 1000,
  "credit-expire": 26 * 60 * 60 * 1000,
};

/** cron 심박 기록 — best-effort: RPC 실패는 경고만 남긴다(심박이 cron 자체를 죽이면 안 됨). */
export async function recordOpsCronHeartbeat(
  admin: AdminClient,
  job: OpsCronJob,
  phase: OpsCronHeartbeatPhase,
  errorCode?: string,
  signal?: AbortSignal,
): Promise<void> {
  try {
    const request = admin.rpc("ops_cron_heartbeat", {
      p_job: job,
      p_phase: phase,
      p_error_code: errorCode ?? null,
    });
    const { error } = await (signal ? request.abortSignal(signal) : request);
    if (error) {
      log.warn("ops.cron_heartbeat_fail", { job, phase, ...errInfo(error) });
    }
  } catch (error) {
    log.warn("ops.cron_heartbeat_fail", { job, phase, ...errInfo(error) });
  }
}

/**
 * 이웃 cron 침묵 감시 — 대상 잡의 last_started_at 이 임계보다 오래 멈춰 있으면
 * `ops.cron_heartbeat_stale`(error → Sentry 이슈)로 승격한다. row 부재는 첫 심박
 * 이전(부트스트랩)이라 침묵으로 치지 않고, 감시 실패도 경고만(감시가 본 cron 을 죽이면 안 됨).
 */
export async function alertIfOpsCronSilent(
  admin: AdminClient,
  job: OpsCronJob,
  signal?: AbortSignal,
): Promise<void> {
  try {
    let query = admin
      .from("ops_cron_heartbeats")
      .select("last_started_at")
      .eq("job_name", job);
    if (signal) query = query.abortSignal(signal);
    const { data, error } = await query.maybeSingle();
    if (error) {
      log.warn("ops.cron_heartbeat_watch_fail", { job, ...errInfo(error) });
      return;
    }
    if (data === null) return;
    const lastStartedAt =
      typeof data.last_started_at === "string"
        ? Date.parse(data.last_started_at)
        : NaN;
    if (!Number.isFinite(lastStartedAt)) {
      log.warn("ops.cron_heartbeat_watch_fail", {
        job,
        reason: "invalid_last_started_at",
      });
      return;
    }
    const staleThresholdMs = OPS_CRON_STALE_THRESHOLD_MS[job];
    const silentForMs = Date.now() - lastStartedAt;
    if (silentForMs > staleThresholdMs) {
      log.error("ops.cron_heartbeat_stale", {
        job,
        lastStartedAt: data.last_started_at,
        silentForMs,
        staleThresholdMs,
      });
    }
  } catch (error) {
    log.warn("ops.cron_heartbeat_watch_fail", { job, ...errInfo(error) });
  }
}
