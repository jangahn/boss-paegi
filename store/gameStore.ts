import { create } from "zustand";
import { MAX_COMBO_MULTIPLIER } from "@/lib/score-limits";
import type { ScoreSample } from "@/lib/highlight";
import {
  VARIETY_WINDOW_SIZE,
  VARIETY_CAP,
  FRESH_WEAPON_BONUS,
  SWITCH_ULT_BONUS_RATIO,
  SWITCH_ULT_COOLDOWN_MS,
  SWITCH_COMBO_GRACE_MS,
  JUGGLE_INITIAL_STATE,
  type FreshWeaponBonus,
} from "@/lib/game-tuning";

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
  /** 무기별 누적 점수(콤보배율 적용 final gain, 궁극기 제외) — 점수기여 기준 주력무기 (해석 리포트용) */
  weaponScores: Record<string, number>;
  /** 궁극기 난타로 얻은 점수 — 스탯/뱃지엔 미반영, 서버 검증(score-ultScore)용 */
  ultScore: number;
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

  // ── 저글링(무기 다양성) — lib/game-tuning 상수 소비 ──
  /** 최근 N charge 타격 무기(다양성 배율 산정용, 불변 교체) */
  weaponWindow: string[];
  /** 다양성 배율(0~VARIETY_CAP). gain 에 (1+varietyMult) 곱해짐. */
  varietyMult: number;
  /** 직전 charge 타격 무기 — 전환 감지 기준(이전 상태) */
  lastChargeWeaponKey: string | null;
  /** 전환 궁극보너스 쿨다운 기준 시각(performance.now) */
  lastSwitchBonusAt: number | null;
  /** 새 무기 첫 타격 보너스 — ScoreBoard 토스트용(시간기반 자동 숨김) */
  lastFreshWeaponBonus: FreshWeaponBonus | null;

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
  ultScore: 0,
  ultimateCount: 0,
  firstHitMs: null,
  ultProgress: 0,
  ultReady: false,
  lastHitAt: 0,
  isPlaying: false,
  startedAt: 0,
  endedAt: null,
  scoreSamples: [],
  ...JUGGLE_INITIAL_STATE,

  hit: (strength, weaponKey, charge = true) => {
    const now = performance.now();
    // 궁극기 난타(charge=false): 점수만(동결 콤보배율) + ultScore 누적 + 콤보 유지(lastHitAt).
    // combo/maxCombo/hitCount/weaponCounts/weaponScores/firstHitMs 등 뱃지·페르소나 통계엔 미반영.
    // → combo/hit/weapon 증가 전에 early return.
    if (!charge) {
      const s = get();
      const gain = Math.round(strength * comboMultiplier(s.combo));
      set({ score: s.score + gain, ultScore: s.ultScore + gain, lastHitAt: now });
      return;
    }
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
      weaponWindow,
      varietyMult: prevVarietyMult,
      lastChargeWeaponKey,
      lastSwitchBonusAt,
      lastFreshWeaponBonus,
    } = get();

    // 1~4: fresh/switch 판정은 전부 *이전 상태* 기준 (weaponCounts 증가·lastChargeWeaponKey 변경 전).
    const prevCount = weaponKey ? weaponCounts[weaponKey] ?? 0 : 0;
    const isFresh = !!weaponKey && prevCount === 0;
    const isSwitch =
      !!weaponKey &&
      lastChargeWeaponKey !== null &&
      lastChargeWeaponKey !== weaponKey;

    // 5~6: 콤보 — 전환 타격에만 grace 윈도우(느린무기 마찰 보정). lastHitAt 조작 X, 판정식만.
    const comboWindowMs = isSwitch
      ? COMBO_DECAY_MS + SWITCH_COMBO_GRACE_MS
      : COMBO_DECAY_MS;
    const continued = now - lastHitAt < comboWindowMs;
    const nextCombo = continued ? combo + 1 : 1;

    // 7: 다양성 배율 — 최근 N charge 타격 distinct (불변 교체). 동일무기 반복 시 윈도우 따라 점진 감쇠.
    const nextWindow = weaponKey
      ? [...weaponWindow, weaponKey].slice(-VARIETY_WINDOW_SIZE)
      : weaponWindow;
    const distinct = new Set(nextWindow).size;
    const nextVarietyMult = weaponKey
      ? ((distinct - 1) / (VARIETY_WINDOW_SIZE - 1)) * VARIETY_CAP
      : prevVarietyMult;

    // 8~10: 점수 — base(콤보×다양성) + fresh 플랫(배율 미적용).
    const baseGain = Math.round(
      strength * comboMultiplier(nextCombo) * (1 + nextVarietyMult)
    );
    const freshBonus = isFresh ? FRESH_WEAPON_BONUS : 0;
    const totalGain = baseGain + freshBonus;

    // 11: 궁극 게이지 — 기존 명중 증가분(+1/ULT_HITS)에 switch bonus 합산, ready 1회 판정.
    const cooldownOk =
      lastSwitchBonusAt === null ||
      now - lastSwitchBonusAt >= SWITCH_ULT_COOLDOWN_MS;
    const switchBonus =
      isSwitch && cooldownOk && !ultReady ? SWITCH_ULT_BONUS_RATIO : 0;
    let nextProgress = ultProgress;
    let nextReady = ultReady;
    if (!ultReady) {
      nextProgress = Math.min(1, ultProgress + 1 / ULT_HITS + switchBonus);
      nextReady = nextProgress >= 1;
    }

    // 12: 불변 업데이트 — totalGain 을 현재 무기에 귀속(switch ult 는 점수 아님).
    const nextCounts = weaponKey
      ? { ...weaponCounts, [weaponKey]: prevCount + 1 }
      : weaponCounts;
    const nextScores = weaponKey
      ? { ...weaponScores, [weaponKey]: (weaponScores[weaponKey] ?? 0) + totalGain }
      : weaponScores;

    set({
      score: score + totalGain,
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
      weaponWindow: nextWindow,
      varietyMult: nextVarietyMult,
      lastChargeWeaponKey: weaponKey ?? lastChargeWeaponKey,
      // switchBonus 가 실제 적용된 경우에만 쿨다운 타임스탬프 갱신(미적용 전환은 쿨다운 유지).
      lastSwitchBonusAt: switchBonus > 0 ? now : lastSwitchBonusAt,
      lastFreshWeaponBonus:
        isFresh && weaponKey
          ? { weaponKey, amount: FRESH_WEAPON_BONUS, at: now }
          : lastFreshWeaponBonus,
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
      ultScore: 0,
      ultimateCount: 0,
      firstHitMs: null,
      ultProgress: 0,
      ultReady: false,
      lastHitAt: 0,
      isPlaying: true,
      startedAt: performance.now(),
      endedAt: null,
      scoreSamples: [],
      ...JUGGLE_INITIAL_STATE,
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
      ultScore: 0,
      ultimateCount: 0,
      firstHitMs: null,
      ultProgress: 0,
      ultReady: false,
      lastHitAt: 0,
      isPlaying: false,
      startedAt: 0,
      endedAt: null,
      scoreSamples: [],
      ...JUGGLE_INITIAL_STATE,
    });
  },
}));

export const COMBO_DECAY_MS_EXPORT = COMBO_DECAY_MS;
