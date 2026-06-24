/**
 * 게임플레이 텔레메트리 — 클라/서버 공용 타입.
 * 신뢰 등급=분석 전용(자기보고). 서버가 deep validation + clamp + 멱등 merge.
 */

/** 무기/맵별 세션 누적 집계(요약 — 익명·회원 공통 저장). */
export type DimAgg = {
  hits: number;
  score: number;
  /** 선택 시도(버튼 탭) 횟수 */
  attempts: number;
  /** 실제 전환(활성 변경) 횟수 */
  switches: number;
};

/** 세션 펀널 마일스톤(ms, started_at 기준). 미도달은 null. */
export type Milestones = {
  firstHitMs: number | null;
  firstSwitchMs: number | null;
  firstUltMs: number | null;
  abandonAtMs: number | null;
};

/** 세션 누적 요약(매 flush 갱신 — latest-wins). */
export type TelemetrySummary = {
  /** 클라가 지금까지 만든 최대 seq(staleness guard) */
  seqHigh: number;
  endedAt: string | null;
  endReason: string | null;
  durationMs: number;
  startMap: string | null;
  startWeapon: string | null;
  totals: {
    score: number;
    hitCount: number;
    maxCombo: number;
    ultFireCount: number;
    distinctWeapons: number;
    distinctMaps: number;
    apm: number;
    /** tap 카테고리 타격 비중 0~1(파생: tap hits / 전체 hits) */
    tapShare: number;
    /** 세션 중 관측된 최대 동시 터치 수 */
    maxTouch: number;
  };
  weaponSummary: Record<string, DimAgg>;
  mapSummary: Record<string, DimAgg>;
  milestones: Milestones;
};

/** timeline 이벤트(회원 풀 캡처만 저장; 익명은 요약만). 각 이벤트에 monotonic seq. */
export type TelemetryEvent = {
  seq: number;
  type: string;
  t: number; // ms since session start
  [k: string]: unknown;
};

/** 한 flush payload(클라 → /api/telemetry). */
export type TelemetryPayload = {
  sessionId: string;
  /** 최초 flush 에만 의미(immutable). 서버가 device_class allowlist clamp. */
  deviceClass: string;
  startedAt: string;
  summary: TelemetrySummary;
  /** 미전송 timeline delta(full 모드에서만 서버가 append). */
  events: TelemetryEvent[];
};

/** 서버 응답 — 적용된 degrade 모드. 클라가 mode 에 따라 timeline 전송 중단. */
export type TelemetryAck = {
  ok: boolean;
  mode: "full" | "summary" | "off";
  reason?: string;
  /** 서버가 받아들인 최대 seq — 클라가 이만큼 ack 처리 */
  lastSeq?: number;
};
