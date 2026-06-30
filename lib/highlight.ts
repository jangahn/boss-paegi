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

/** 하이라이트 윈도우 길이 범위(카드 + 영상 공용 검출 기준) */
export const HIGHLIGHT_MIN_MS = 3000;
export const HIGHLIGHT_MAX_MS = 5000;

// ── 롤링버퍼 연속 녹화 튜닝(useHighlightRecorder 소비) ──
/** MediaRecorder timeslice — 청크 1개 길이 */
export const TIMESLICE_MS = 500;
/** 롤링 버퍼 보존 길이(MAX 윈도우 + 여유) — 이보다 오래되고 후보 미참조면 폐기 */
export const BUFFER_MS = 8000;
/** best-window 폴백 평가 주기(score 갱신 직후 평가 + 이 interval) */
export const EVAL_INTERVAL_MS = 250;
/** 폴백용으로 보관할 스냅샷 후보 최대 개수 */
export const SNAPSHOT_CANDIDATES = 3;
/** 클립 양끝 여유(청크 경계로 급상승 초입/끝 잘림 완화) */
export const PRE_ROLL_MS = 250;
export const POST_ROLL_MS = 500;
/** 연속 녹화 비트레이트 상한(전체 게임 녹화 메모리/발열) */
export const VIDEO_BITRATE = 2_000_000;

/** 서버 검증용 windowMs 허용 범위(검출 윈도우 3~5s + tolerance) */
export const WINDOW_MS_MIN = 2500;
export const WINDOW_MS_MAX = 5500;

/** 하이라이트 윈도우 1개 */
export type HighlightWindow = { startAt: number; endAt: number; delta: number };

/**
 * 윈도우 우열 비교(영상·카드 공용 tie-breaker). a 가 더 좋으면 >0.
 * ① Δscore 큰 것 ② 동률이면 더 긴 window ③ 그래도 동률이면 더 이른 start.
 * pickHighlightWindow / findBestScoreWindowIncremental 둘 다 이 함수를 써서
 * 영상과 카드가 같은 동률 처리를 하도록 한다.
 */
export function compareHighlightWindow(
  a: HighlightWindow,
  b: HighlightWindow
): number {
  if (a.delta !== b.delta) return a.delta - b.delta;
  const da = a.endAt - a.startAt;
  const db = b.endAt - b.startAt;
  if (da !== db) return da - db;
  return b.startAt - a.startAt;
}

/**
 * timeline 전체에서 Δscore 가 최대인 [minMs, maxMs] 윈도우(카드용 — 1회 계산).
 * 샘플 부족/무득점이면 null. 반환 t 는 샘플과 동일 시계(절대 performance.now()).
 */
export function pickHighlightWindow(
  samples: ScoreSample[],
  opts: { minMs?: number; maxMs?: number } = {}
): HighlightWindow | null {
  const minMs = opts.minMs ?? HIGHLIGHT_MIN_MS;
  const maxMs = opts.maxMs ?? HIGHLIGHT_MAX_MS;
  if (samples.length < 2) return null;

  let best: HighlightWindow | null = null;
  let i = 0;
  for (let j = 1; j < samples.length; j++) {
    // i 를 윈도우 상한(maxMs) 안으로 당김
    while (samples[j].t - samples[i].t > maxMs && i < j) i++;
    // i..j 안에서 minMs 이상 되는 가장 큰 Δscore 후보 — i 부터 minMs 충족하는 지점 탐색
    for (let k = i; k < j; k++) {
      const dt = samples[j].t - samples[k].t;
      if (dt < minMs) break; // k 가 커질수록 dt 작아짐 → 더 볼 필요 없음
      const delta = samples[j].score - samples[k].score;
      if (delta > 0) {
        const cand: HighlightWindow = { startAt: samples[k].t, endAt: samples[j].t, delta };
        if (!best || compareHighlightWindow(cand, best) > 0) best = cand;
      }
    }
  }
  return best;
}

/**
 * **마지막 샘플에서 끝나는** [minMs, maxMs] 윈도우 중 Δscore 최대(영상 recorder 증분 추적용).
 * score 갱신마다 호출하며 호출부가 globalBest 를 누적하면, 매 샘플이 한 번씩 끝점이 되므로
 * 누적 결과는 pickHighlightWindow(전체) 와 동일해진다(영상·카드 검출 기준 일치).
 * 샘플 부족/무득점이면 null.
 */
export function findBestScoreWindowIncremental(
  samples: ScoreSample[],
  opts: { minMs?: number; maxMs?: number } = {}
): HighlightWindow | null {
  const minMs = opts.minMs ?? HIGHLIGHT_MIN_MS;
  const maxMs = opts.maxMs ?? HIGHLIGHT_MAX_MS;
  if (samples.length < 2) return null;
  const j = samples.length - 1;
  const endT = samples[j].t;
  const endScore = samples[j].score;
  let best: HighlightWindow | null = null;
  for (let k = j - 1; k >= 0; k--) {
    const dt = endT - samples[k].t;
    if (dt > maxMs) break; // 더 이르면 윈도우 상한 초과
    if (dt < minMs) continue; // 아직 최소 길이 미달
    const delta = endScore - samples[k].score;
    if (delta > 0) {
      const cand: HighlightWindow = { startAt: samples[k].t, endAt: endT, delta };
      if (!best || compareHighlightWindow(cand, best) > 0) best = cand;
    }
  }
  return best;
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
