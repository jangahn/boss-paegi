import type { TelemetryCollector } from "./collector";
import type { TelemetryAck, TelemetryPayload } from "./types";

const ENDPOINT = "/api/telemetry";

/**
 * 전송 — delta-only(미전송 이벤트만) + 누적 summary 스냅샷. in-flight 중 일반 flush 스킵.
 * 응답 mode(summary/off)면 timeline delta 전송 중단(요약만). 이탈은 sendBeacon(Blob json)로 마지막 delta.
 */
export class TelemetryTransport {
  private lastAckedSeq = 0;
  private inFlight = false;
  private mode: "full" | "summary" | "off" = "full";

  constructor(private readonly collector: TelemetryCollector) {}

  private build(endReason: string | null): TelemetryPayload {
    return {
      sessionId: this.collector.sessionId,
      deviceClass: this.collector.deviceClass,
      startedAt: this.collector.startedAtIso,
      summary: this.collector.snapshot(endReason),
      events: this.mode === "full" ? this.collector.eventsSince(this.lastAckedSeq) : [],
    };
  }

  /** 주기 flush(fetch keepalive). force=true 면 in-flight 무시(최종 flush). */
  async flush(endReason: string | null, opts?: { force?: boolean }): Promise<void> {
    if (this.inFlight && !opts?.force) return;
    this.inFlight = true;
    try {
      const res = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(this.build(endReason)),
        keepalive: true,
      });
      const ack = (await res.json().catch(() => null)) as TelemetryAck | null;
      if (ack) {
        if (typeof ack.lastSeq === "number") this.lastAckedSeq = Math.max(this.lastAckedSeq, ack.lastSeq);
        if (ack.mode) this.mode = ack.mode;
      }
    } catch {
      // best-effort — 계측 실패는 게임/점수에 무영향
    } finally {
      this.inFlight = false;
    }
  }

  /** 이탈 시 — 마지막 미전송 delta 를 sendBeacon 으로(응답 없음). */
  beacon(endReason: string): void {
    try {
      const blob = new Blob([JSON.stringify(this.build(endReason))], {
        type: "application/json",
      });
      navigator.sendBeacon(ENDPOINT, blob);
    } catch {
      // beacon 미지원/실패 무시
    }
  }
}
