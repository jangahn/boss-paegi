/**
 * 하이라이트 구간 검출 — 순수 로직 (클라 녹화/카드, 서버 검증 공용).
 * score timeline 에서 점수가 가장 가파르게 오른 3~5초 윈도우를 찾는다.
 */

export type ScoreSample = { t: number; score: number };

/** 공유할 최종 하이라이트 클립 (메모리 보관, 공유 시점에 업로드). */
export type HighlightClip = {
  blob: Blob;
  mime: string;
  ext: "mp4" | "webm";
  delta: number;
  windowMs: number;
};

/** 하이라이트(카드용) 윈도우 길이 범위 */
export const HIGHLIGHT_MIN_MS = 3000;
export const HIGHLIGHT_MAX_MS = 5000;

/** 녹화 1회 길이(iOS 안전 위해 짧게) + 게임당 최대 녹화 시도 */
export const RECORD_WINDOW_MS = 4000;
export const MAX_RECORD_ATTEMPTS = 3;

/** 라이브 velocity 측정 윈도우 + 녹화 트리거 임계(이 window 동안 오른 점수) */
export const VELOCITY_WINDOW_MS = 1000;
export const VELOCITY_TRIGGER = 250;

/** 서버 검증용 windowMs 허용 범위(녹화 ~4s 라 tolerance 포함) */
export const WINDOW_MS_MIN = 2500;
export const WINDOW_MS_MAX = 5500;

/**
 * timeline 에서 Δscore 가 최대인 [minMs, maxMs] 윈도우.
 * 샘플 부족/무득점이면 null. 반환 t 는 샘플과 동일 시계(절대 performance.now()).
 */
export function pickHighlightWindow(
  samples: ScoreSample[],
  opts: { minMs?: number; maxMs?: number } = {}
): { startAt: number; endAt: number; delta: number } | null {
  const minMs = opts.minMs ?? HIGHLIGHT_MIN_MS;
  const maxMs = opts.maxMs ?? HIGHLIGHT_MAX_MS;
  if (samples.length < 2) return null;

  let best: { startAt: number; endAt: number; delta: number } | null = null;
  let i = 0;
  for (let j = 1; j < samples.length; j++) {
    // i 를 윈도우 상한(maxMs) 안으로 당김
    while (samples[j].t - samples[i].t > maxMs && i < j) i++;
    // i..j 안에서 minMs 이상 되는 가장 큰 Δscore 후보 — i 부터 minMs 충족하는 지점 탐색
    for (let k = i; k < j; k++) {
      const dt = samples[j].t - samples[k].t;
      if (dt < minMs) break; // k 가 커질수록 dt 작아짐 → 더 볼 필요 없음
      const delta = samples[j].score - samples[k].score;
      if (delta > 0 && (!best || delta > best.delta)) {
        best = { startAt: samples[k].t, endAt: samples[j].t, delta };
      }
    }
  }
  return best;
}

/** 최근 windowMs 동안 오른 점수(라이브 트리거용). */
export function recentVelocity(
  samples: ScoreSample[],
  nowT: number,
  windowMs = VELOCITY_WINDOW_MS
): number {
  if (samples.length === 0) return 0;
  const cutoff = nowT - windowMs;
  let baseScore = samples[samples.length - 1].score;
  for (let i = samples.length - 1; i >= 0; i--) {
    if (samples[i].t <= cutoff) {
      baseScore = samples[i].score;
      break;
    }
    baseScore = samples[i].score;
  }
  return samples[samples.length - 1].score - baseScore;
}

/**
 * 서버 PATCH 표시용 메타 검증/클램프 (클라 값 불신, 랭킹 아님이라 방어만).
 * delta: 0..finalScore, windowMs: [WINDOW_MS_MIN, WINDOW_MS_MAX]. 벗어나면 null(표시 생략).
 */
export function sanitizeHighlightMeta(
  raw: { delta?: unknown; windowMs?: unknown },
  finalScore: number
): { delta: number | null; windowMs: number | null } {
  const d =
    typeof raw.delta === "number" && Number.isFinite(raw.delta)
      ? Math.round(raw.delta)
      : null;
  const w =
    typeof raw.windowMs === "number" && Number.isFinite(raw.windowMs)
      ? Math.round(raw.windowMs)
      : null;
  return {
    delta: d !== null && d >= 0 && d <= finalScore ? d : null,
    windowMs: w !== null && w >= WINDOW_MS_MIN && w <= WINDOW_MS_MAX ? w : null,
  };
}
