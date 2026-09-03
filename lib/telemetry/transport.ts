import type { TelemetryCollector } from "./collector";
import type { TelemetryPayload } from "./types";
import { runBoundedClientJsonFetch } from "../client-mutation.ts";

const ENDPOINT = "/api/telemetry";
const POSTGRES_INT_MAX = 2_147_483_647;
const RETRY_DEFAULT_MS = 10_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

type TelemetryHttpAck = {
  ok: true;
  mode: "full" | "summary" | "off";
  reason?: string;
  lastSeq: number;
};

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const keys = Object.keys(value);
  return (
    keys.length === expected.length &&
    keys.every((key) => expected.includes(key))
  );
}

/** Exact browser contract; failed/malformed responses must not discard deltas. */
export function parseTelemetryHttpAck(
  value: unknown,
): TelemetryHttpAck | null {
  const row = record(value);
  if (
    !row ||
    row.ok !== true ||
    (row.mode !== "full" &&
      row.mode !== "summary" &&
      row.mode !== "off") ||
    !Number.isSafeInteger(row.lastSeq) ||
    (row.lastSeq as number) < 0 ||
    (row.lastSeq as number) > POSTGRES_INT_MAX
  ) {
    return null;
  }
  if (hasExactKeys(row, ["ok", "mode", "lastSeq"])) {
    return {
      ok: true,
      mode: row.mode,
      lastSeq: row.lastSeq as number,
    };
  }
  if (
    hasExactKeys(row, ["ok", "mode", "reason", "lastSeq"]) &&
    typeof row.reason === "string" &&
    row.reason.length > 0 &&
    row.reason.length <= 100 &&
    row.reason === row.reason.trim()
  ) {
    return {
      ok: true,
      mode: row.mode,
      reason: row.reason,
      lastSeq: row.lastSeq as number,
    };
  }
  return null;
}

const MODE_RANK = {
  full: 0,
  summary: 1,
  off: 2,
} as const;

/** Parse Retry-After without allowing an upstream value to stall a session forever. */
export function telemetryRetryDelayMs(
  value: string | null,
  nowMs: number = Date.now(),
): number {
  let requestedMs = RETRY_DEFAULT_MS;
  const trimmed = value?.trim() ?? "";
  if (/^\d+$/.test(trimmed)) {
    requestedMs = Number(trimmed) * 1_000;
  } else if (trimmed) {
    const at = Date.parse(trimmed);
    if (Number.isFinite(at)) requestedMs = at - nowMs;
  }
  if (!Number.isFinite(requestedMs)) return RETRY_MAX_MS;
  return Math.min(
    RETRY_MAX_MS,
    Math.max(RETRY_MIN_MS, Math.ceil(requestedMs)),
  );
}

/**
 * 전송 — delta-only(미전송 이벤트만) + 누적 summary 스냅샷. in-flight 중 일반 flush 스킵.
 * 응답 mode(summary/off)면 timeline delta 전송 중단(요약만). 이탈은 sendBeacon(Blob json)로 마지막 delta.
 */
export class TelemetryTransport {
  private readonly collector: TelemetryCollector;
  private lastAckedSeq = 0;
  private inFlightCount = 0;
  private mode: "full" | "summary" | "off" = "full";
  private retryNotBefore = 0;
  private readonly now: () => number;

  constructor(
    collector: TelemetryCollector,
    options: { now?: () => number } = {},
  ) {
    this.collector = collector;
    this.now = options.now ?? Date.now;
  }

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
    if (!opts?.force && this.now() < this.retryNotBefore) return;
    if (this.inFlightCount > 0 && !opts?.force) return;
    this.inFlightCount += 1;
    try {
      const delivery = await runBoundedClientJsonFetch({
        input: ENDPOINT,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.build(endReason)),
          keepalive: true,
        },
        deadlineMs: 10_000,
        attemptMs: 8_000,
      });
      if (delivery.kind !== "confirmed") {
        this.retryNotBefore = Math.max(
          this.retryNotBefore,
          this.now() + RETRY_DEFAULT_MS,
        );
        return;
      }
      const { response: res, body } = delivery.value;
      if (!res.ok) {
        this.retryNotBefore = Math.max(
          this.retryNotBefore,
          this.now() +
            telemetryRetryDelayMs(
              res.headers.get("retry-after"),
              this.now(),
            ),
        );
        return;
      }
      const ack = parseTelemetryHttpAck(body);
      if (ack) {
        this.retryNotBefore = 0;
        this.lastAckedSeq = Math.max(this.lastAckedSeq, ack.lastSeq);
        if (MODE_RANK[ack.mode] > MODE_RANK[this.mode]) {
          this.mode = ack.mode;
        }
      } else {
        this.retryNotBefore = Math.max(
          this.retryNotBefore,
          this.now() + RETRY_DEFAULT_MS,
        );
      }
    } catch {
      // best-effort — 계측 실패는 게임/점수에 무영향
      this.retryNotBefore = Math.max(
        this.retryNotBefore,
        this.now() + RETRY_DEFAULT_MS,
      );
    } finally {
      this.inFlightCount -= 1;
    }
  }

  /** 이탈 시 — 마지막 미전송 delta 를 sendBeacon 으로(응답 없음). */
  beacon(endReason: string): void {
    try {
      const blob = new Blob([JSON.stringify(this.build(endReason))], {
        type: "application/json",
      });
      // 서버 진단용 표식 — 같은 세션의 다른 전송은 수락되는데 이탈 beacon 만 세션
      // 없이 도착하는 사례(2026-09-03)를 keepalive fetch 와 구분한다.
      navigator.sendBeacon(`${ENDPOINT}?beacon=1`, blob);
    } catch {
      // beacon 미지원/실패 무시
    }
  }
}
