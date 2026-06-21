import { create } from "zustand";
import { MAX_COMBO_MULTIPLIER } from "@/lib/score-limits";
import type { ScoreSample } from "@/lib/highlight";

const COMBO_DECAY_MS = 1500;
/** 궁극기 게이지 풀 충전에 필요한 명중 횟수 */
export const ULT_HITS = 100;
/** score timeline ring buffer 상한 (100ms 샘플 → 60s≈600) */
const SCORE_SAMPLE_CAP = 600;

/** 콤보 → 점수 배율. 상한 있음 (무한 증가 시 서버 점수 한도 초과). */
export function comboMultiplier(combo: number): number {
  return Math.min(MAX_COMBO_MULTIPLIER, 1 + Math.floor(combo / 5) * 0.5);
}

type GameState = {
  score: number;
  combo: number;
  maxCombo: number;
  /** 총 타격 횟수 (보고서용) */
  hitCount: number;
  /** 무기별 타격 횟수 — 주력 무기 산정 (보고서용) */
  weaponCounts: Record<string, number>;
  /** 무기별 누적 점수(콤보배율 적용 final gain) — 점수기여 기준 주력무기 (해석 리포트용) */
  weaponScores: Record<string, number>;
  /** 궁극기 발동 횟수 (해석 리포트용) */
  ultimateCount: number;
  /** 첫 타격까지 걸린 시간(ms) — startedAt 기준, 미타격이면 null */
  firstHitMs: number | null;
  /** 궁극기 게이지 0~1 */
  ultProgress: number;
  /** 게이지 풀 충전 — 궁극기 발동 가능 */
  ultReady: boolean;
  lastHitAt: number;
  isPlaying: boolean;
  startedAt: number;
  endedAt: number | null;
  /** 하이라이트 검출용 score timeline (100ms 샘플, 절대 performance.now()) */
  scoreSamples: ScoreSample[];

  /** charge=false 면 점수만 올리고 게이지는 충전 안 함 (궁극기 난타 중 타격) */
  hit: (strength: number, weaponKey?: string, charge?: boolean) => void;
  /** 현재 점수를 timeline 에 1샘플 추가 (recorder 가 100ms 마다 호출) */
  pushScoreSample: () => void;
  /** 궁극기 발동 — 게이지 소진 */
  consumeUlt: () => void;
  start: () => void;
  end: () => void;
  reset: () => void;
};

/** weaponCounts 에서 가장 많이 쓴 무기 key */
export function topWeapon(counts: Record<string, number>): string | null {
  let best: string | null = null;
  let max = 0;
  for (const [k, v] of Object.entries(counts)) {
    if (v > max) {
      max = v;
      best = k;
    }
  }
  return best;
}

export const useGameStore = create<GameState>((set, get) => ({
  score: 0,
  combo: 0,
  maxCombo: 0,
  hitCount: 0,
  weaponCounts: {},
  weaponScores: {},
  ultimateCount: 0,
  firstHitMs: null,
  ultProgress: 0,
  ultReady: false,
  lastHitAt: 0,
  isPlaying: false,
  startedAt: 0,
  endedAt: null,
  scoreSamples: [],

  hit: (strength, weaponKey, charge = true) => {
    const now = performance.now();
    const {
      combo,
      lastHitAt,
      maxCombo,
      score,
      hitCount,
      weaponCounts,
      weaponScores,
      startedAt,
      firstHitMs,
      ultProgress,
      ultReady,
    } = get();
    const continued = now - lastHitAt < COMBO_DECAY_MS;
    const nextCombo = continued ? combo + 1 : 1;
    const gain = Math.round(strength * comboMultiplier(nextCombo));

    const nextCounts = weaponKey
      ? { ...weaponCounts, [weaponKey]: (weaponCounts[weaponKey] ?? 0) + 1 }
      : weaponCounts;
    // final gain(콤보배율 적용 후) 누적 — 점수기여 기준 주력무기 산정
    const nextScores = weaponKey
      ? { ...weaponScores, [weaponKey]: (weaponScores[weaponKey] ?? 0) + gain }
      : weaponScores;

    // 게이지 충전 — 이미 ready 거나 난타 중(charge=false)이면 그대로
    let nextProgress = ultProgress;
    let nextReady = ultReady;
    if (charge && !ultReady) {
      nextProgress = Math.min(1, ultProgress + 1 / ULT_HITS);
      if (nextProgress >= 1) nextReady = true;
    }

    set({
      score: score + gain,
      combo: nextCombo,
      maxCombo: Math.max(maxCombo, nextCombo),
      hitCount: hitCount + 1,
      weaponCounts: nextCounts,
      weaponScores: nextScores,
      firstHitMs:
        hitCount === 0 && startedAt ? Math.round(now - startedAt) : firstHitMs,
      ultProgress: nextProgress,
      ultReady: nextReady,
      lastHitAt: now,
    });
  },

  // 궁극기 발동 — 게이지 소진 + 발동 횟수 누적
  consumeUlt: () =>
    set((s) => ({
      ultReady: false,
      ultProgress: 0,
      ultimateCount: s.ultimateCount + 1,
    })),

  pushScoreSample: () => {
    const { scoreSamples, score } = get();
    const next =
      scoreSamples.length >= SCORE_SAMPLE_CAP
        ? scoreSamples.slice(scoreSamples.length - SCORE_SAMPLE_CAP + 1)
        : scoreSamples.slice();
    next.push({ t: performance.now(), score });
    set({ scoreSamples: next });
  },

  start: () => {
    set({
      score: 0,
      combo: 0,
      maxCombo: 0,
      hitCount: 0,
      weaponCounts: {},
      weaponScores: {},
      ultimateCount: 0,
      firstHitMs: null,
      ultProgress: 0,
      ultReady: false,
      lastHitAt: 0,
      isPlaying: true,
      startedAt: performance.now(),
      endedAt: null,
      scoreSamples: [],
    });
  },

  end: () => {
    set({ isPlaying: false, endedAt: performance.now() });
  },

  reset: () => {
    set({
      score: 0,
      combo: 0,
      maxCombo: 0,
      hitCount: 0,
      weaponCounts: {},
      weaponScores: {},
      ultimateCount: 0,
      firstHitMs: null,
      ultProgress: 0,
      ultReady: false,
      lastHitAt: 0,
      isPlaying: false,
      startedAt: 0,
      endedAt: null,
      scoreSamples: [],
    });
  },
}));

export const COMBO_DECAY_MS_EXPORT = COMBO_DECAY_MS;
