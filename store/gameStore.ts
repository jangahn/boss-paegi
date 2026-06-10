import { create } from "zustand";
import { MAX_COMBO_MULTIPLIER } from "@/lib/score-limits";

const COMBO_DECAY_MS = 1500;

/** 콤보 → 점수 배율. 상한 있음 (무한 증가 시 서버 점수 한도 초과). */
export function comboMultiplier(combo: number): number {
  return Math.min(MAX_COMBO_MULTIPLIER, 1 + Math.floor(combo / 5) * 0.5);
}

type GameState = {
  score: number;
  combo: number;
  maxCombo: number;
  lastHitAt: number;
  isPlaying: boolean;
  startedAt: number;
  endedAt: number | null;

  hit: (strength: number) => void;
  start: () => void;
  end: () => void;
  reset: () => void;
};

export const useGameStore = create<GameState>((set, get) => ({
  score: 0,
  combo: 0,
  maxCombo: 0,
  lastHitAt: 0,
  isPlaying: false,
  startedAt: 0,
  endedAt: null,

  hit: (strength) => {
    const now = performance.now();
    const { combo, lastHitAt, maxCombo, score } = get();
    const continued = now - lastHitAt < COMBO_DECAY_MS;
    const nextCombo = continued ? combo + 1 : 1;
    const gain = Math.round(strength * comboMultiplier(nextCombo));

    set({
      score: score + gain,
      combo: nextCombo,
      maxCombo: Math.max(maxCombo, nextCombo),
      lastHitAt: now,
    });
  },

  start: () => {
    set({
      score: 0,
      combo: 0,
      maxCombo: 0,
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
      lastHitAt: 0,
      isPlaying: false,
      startedAt: 0,
      endedAt: null,
    });
  },
}));

export const COMBO_DECAY_MS_EXPORT = COMBO_DECAY_MS;
