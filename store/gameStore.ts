import { create } from "zustand";
import { MAX_COMBO_MULTIPLIER } from "@/lib/score-limits";

const COMBO_DECAY_MS = 1500;
/** 궁극기 게이지 풀 충전에 필요한 명중 횟수 */
export const ULT_HITS = 100;

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
  /** 궁극기 게이지 0~1 */
  ultProgress: number;
  /** 게이지 풀 충전 — 궁극기 발동 가능 */
  ultReady: boolean;
  lastHitAt: number;
  isPlaying: boolean;
  startedAt: number;
  endedAt: number | null;

  /** charge=false 면 점수만 올리고 게이지는 충전 안 함 (궁극기 난타 중 타격) */
  hit: (strength: number, weaponKey?: string, charge?: boolean) => void;
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
  ultProgress: 0,
  ultReady: false,
  lastHitAt: 0,
  isPlaying: false,
  startedAt: 0,
  endedAt: null,

  hit: (strength, weaponKey, charge = true) => {
    const now = performance.now();
    const {
      combo,
      lastHitAt,
      maxCombo,
      score,
      hitCount,
      weaponCounts,
      ultProgress,
      ultReady,
    } = get();
    const continued = now - lastHitAt < COMBO_DECAY_MS;
    const nextCombo = continued ? combo + 1 : 1;
    const gain = Math.round(strength * comboMultiplier(nextCombo));

    const nextCounts = weaponKey
      ? { ...weaponCounts, [weaponKey]: (weaponCounts[weaponKey] ?? 0) + 1 }
      : weaponCounts;

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
      ultProgress: nextProgress,
      ultReady: nextReady,
      lastHitAt: now,
    });
  },

  consumeUlt: () => set({ ultReady: false, ultProgress: 0 }),

  start: () => {
    set({
      score: 0,
      combo: 0,
      maxCombo: 0,
      hitCount: 0,
      weaponCounts: {},
      ultProgress: 0,
      ultReady: false,
      lastHitAt: 0,
      isPlaying: true,
      startedAt: performance.now(),
      endedAt: null,
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
      ultProgress: 0,
      ultReady: false,
      lastHitAt: 0,
      isPlaying: false,
      startedAt: 0,
      endedAt: null,
    });
  },
}));

export const COMBO_DECAY_MS_EXPORT = COMBO_DECAY_MS;
