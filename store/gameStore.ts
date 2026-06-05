import { create } from "zustand";

const COMBO_DECAY_MS = 1500;

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
    const multiplier = 1 + Math.floor(nextCombo / 5) * 0.5;
    const gain = Math.round(strength * multiplier);

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
