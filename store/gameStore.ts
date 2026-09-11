import { create } from "zustand";
import { MAX_COMBO_MULTIPLIER } from "@/lib/score-limits";
import type { ScoreSample } from "@/lib/highlight";
import {
  VARIETY_FULL_AT,
  VARIETY_CAP,
  FRESH_WEAPON_BONUS,
  SWITCH_ULT_BONUS_RATIO,
  SWITCH_ULT_COOLDOWN_MS,
  SWITCH_COMBO_GRACE_MS,
  JUGGLE_INITIAL_STATE,
  JUGGLE_CONFIG_DEFAULT,
  ULT_HITS,
  varietyMultiplier,
  mapVarietyMultiplier,
  type FreshWeaponBonus,
  type HitLogEntry,
  type JuggleConfig,
  type MapLogEntry,
} from "@/lib/game-tuning";
import { firstHitElapsedMs } from "@/lib/game-clock";

/** 맵 체류 기록 상한 — 창 산정엔 최근 것만 필요(창 시작 시점 맵 포함). 한 판 전환 수는 이보다 훨씬 적다. */
const MAP_LOG_MAX = 200;
/** 궁극기 게이지 풀 충전에 필요한 명중 횟수 — 단일 출처는 game-tuning. */
export { ULT_HITS };
/** score timeline ring buffer 상한 (100ms 샘플 → 60s≈600) */
const SCORE_SAMPLE_CAP = 600;

/** 콤보 → 점수 배율. 상한 있음 (무한 증가 시 서버 점수 한도 초과). */
export function comboMultiplier(combo: number): number {
  return Math.min(MAX_COMBO_MULTIPLIER, 1 + Math.floor(combo / 5) * 0.5);
}

/**
 * 타격 간격 변동계수(CV=σ/μ). 어뷰징 jitter 신호(S5/C3) — 봇/매크로는 거의 등간격이라 CV≈0.
 * 표본 부족(<20)이면 null(신뢰 불가). 러닝 통계에서 지연 계산(핫패스엔 누적만).
 */
export function selectIntervalCV(s: {
  ivN: number;
  ivSum: number;
  ivSumSq: number;
}): number | null {
  if (s.ivN < 20) return null;
  const mean = s.ivSum / s.ivN;
  if (mean <= 0) return null;
  const variance = Math.max(0, s.ivSumSq / s.ivN - mean * mean);
  return Math.sqrt(variance) / mean;
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
  /** 타격 간격 러닝 통계(어뷰징 jitter/CV 산출용, charge 연속타격만). CV=σ/μ 는 selectIntervalCV 로 지연계산. */
  ivN: number;
  ivSum: number;
  ivSumSq: number;
  isPlaying: boolean;
  startedAt: number;
  endedAt: number | null;
  /** 하이라이트 검출용 score timeline (100ms 샘플, 절대 performance.now()) */
  scoreSamples: ScoreSample[];

  // ── 저글링(무기·맵 다양성, v1.36 시간 창) — lib/game-tuning 상수 소비 ──
  /** 창 초수 설정(ms) — 어드민 score_config.juggle. 판 사이 유지(start 가 리셋하지 않음). configureJuggle 로 주입. */
  juggle: JuggleConfig;
  /** 최근 창 안 charge 타격 기록(무기변경 배율 산정용, 불변 교체) */
  hitLog: HitLogEntry[];
  /** 무기변경 배율(0~VARIETY_CAP). gain 에 (1+varietyMult) 곱해짐. */
  varietyMult: number;
  /** 맵 체류 기록(시작 맵 + 전환마다) — 맵변경 배율 산정용 */
  mapLog: MapLogEntry[];
  /** 현재 맵 키 */
  currentMap: string | null;
  /** 맵변경 배율(0~MAP_VARIETY_CAP). gain 에 (1+mapMult) 곱해짐. */
  mapMult: number;
  /** 직전 charge 타격 무기 — 전환 감지 기준(이전 상태) */
  lastChargeWeaponKey: string | null;
  /** 전환 궁극보너스 쿨다운 기준 시각(performance.now) */
  lastSwitchBonusAt: number | null;
  /** 새 무기 첫 타격 보너스 — ScoreBoard 토스트용(시간기반 자동 숨김) */
  lastFreshWeaponBonus: FreshWeaponBonus | null;

  /**
   * charge=false 면 점수만 올리고 게이지는 충전 안 함 (궁극기 난타 중 타격).
   * **반환값 = 화면 데미지 팝업에 찍을 값**(콤보×무기변경 배율 적용된 baseGain, fresh 보너스 제외 — 별도 토스트).
   */
  hit: (strength: number, weaponKey?: string, charge?: boolean) => number;
  /** 창 초수 설정 주입 — 게임 시작 전(라이브 score_config). */
  configureJuggle: (cfg: JuggleConfig) => void;
  /** 맵 체류 기록 — 게임 시작 맵과 전환마다 호출(맵변경 배율은 즉시 재계산). */
  noteMap: (map: string) => void;
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
  ivN: 0,
  ivSum: 0,
  ivSumSq: 0,
  isPlaying: false,
  startedAt: 0,
  endedAt: null,
  scoreSamples: [],
  juggle: JUGGLE_CONFIG_DEFAULT,
  ...JUGGLE_INITIAL_STATE,
  configureJuggle: (cfg) => set({ juggle: cfg }),
  noteMap: (map) => {
    const now = performance.now();
    const s = get();
    const mapLog = [...s.mapLog, { t: now, map }].slice(-MAP_LOG_MAX);
    set({ mapLog, currentMap: map, mapMult: mapVarietyMultiplier(mapLog, now, s.juggle.mapWindowMs) });
  },

  hit: (strength, weaponKey, charge = true) => {
    const state = get();
    // 종료와 같은 JS turn에서 이미 큐에 있던 pellet/collision callback이
    // 뒤늦게 도착해도 점수·통계·게이지를 다시 열 수 없다. charge=false인
    // 궁극기 타격도 같은 gate를 반드시 통과한다.
    if (!state.isPlaying) return 0;
    const now = performance.now();
    // 궁극기 난타(charge=false): 점수만(동결 콤보배율) + ultScore 누적 + 콤보 유지(lastHitAt).
    // combo/maxCombo/hitCount/weaponCounts/weaponScores/firstHitMs 등 뱃지·페르소나 통계엔 미반영.
    // → combo/hit/weapon 증가 전에 early return.
    if (!charge) {
      const s = state;
      const gain = Math.round(strength * comboMultiplier(s.combo));
      set({ score: s.score + gain, ultScore: s.ultScore + gain, lastHitAt: now });
      return gain; // 난타 팝업도 콤보배율 반영
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
      isPlaying,
      firstHitMs,
      ultProgress,
      ultReady,
      juggle,
      hitLog,
      varietyMult: prevVarietyMult,
      mapLog,
      lastChargeWeaponKey,
      lastSwitchBonusAt,
      lastFreshWeaponBonus,
      ivN,
      ivSum,
      ivSumSq,
    } = state;

    // 타격 간격 CV(어뷰징 jitter) — 연속 간격(idle/decay 제외)만 러닝 누적. 봇=거의 등간격(CV≈0).
    const iv = lastHitAt > 0 ? now - lastHitAt : -1;
    const ivHit = iv > 0 && iv < juggle.comboWindowMs;

    // 1~4: fresh/switch 판정은 전부 *이전 상태* 기준 (weaponCounts 증가·lastChargeWeaponKey 변경 전).
    const prevCount = weaponKey ? weaponCounts[weaponKey] ?? 0 : 0;
    const isFresh = !!weaponKey && prevCount === 0;
    const isSwitch =
      !!weaponKey &&
      lastChargeWeaponKey !== null &&
      lastChargeWeaponKey !== weaponKey;

    // 5~6: 콤보 — 유지 창은 어드민 설정(기본 2.0초, v1.36), 전환 타격에만 grace 윈도우(느린무기 마찰 보정). lastHitAt 조작 X.
    const comboWindowMs = isSwitch
      ? juggle.comboWindowMs + SWITCH_COMBO_GRACE_MS
      : juggle.comboWindowMs;
    const continued = now - lastHitAt < comboWindowMs;
    const nextCombo = continued ? combo + 1 : 1;

    // 7: 무기변경 배율 — 최근 juggle.weaponWindowMs 안 charge 타격의 고유 무기 수(시간 창, v1.36). 창 밖 기록은 버린다.
    const weaponCutoff = now - juggle.weaponWindowMs;
    const keptHits = hitLog.filter((e) => e.t >= weaponCutoff);
    const nextLog = weaponKey ? [...keptHits, { t: now, weaponKey }] : keptHits;
    const nextVarietyMult = weaponKey
      ? varietyMultiplier(new Set(nextLog.map((e) => e.weaponKey)).size, VARIETY_FULL_AT, VARIETY_CAP)
      : prevVarietyMult;
    // 8: 맵변경 배율 — 최근 juggle.mapWindowMs 안에 머문 고유 맵 수(창 시작 시점에 머물던 맵 포함).
    const nextMapMult = mapVarietyMultiplier(mapLog, now, juggle.mapWindowMs);

    // 9~10: 점수 — base(콤보 × 무기변경 × 맵변경) + fresh 플랫(배율 미적용).
    const baseGain = Math.round(
      strength * comboMultiplier(nextCombo) * (1 + nextVarietyMult) * (1 + nextMapMult)
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
      firstHitMs: firstHitElapsedMs({
        hitCount,
        active: isPlaying,
        startedAt,
        now,
        previous: firstHitMs,
      }),
      ultProgress: nextProgress,
      ultReady: nextReady,
      lastHitAt: now,
      ivN: ivHit ? ivN + 1 : ivN,
      ivSum: ivHit ? ivSum + iv : ivSum,
      ivSumSq: ivHit ? ivSumSq + iv * iv : ivSumSq,
      hitLog: nextLog,
      varietyMult: nextVarietyMult,
      mapMult: nextMapMult,
      lastChargeWeaponKey: weaponKey ?? lastChargeWeaponKey,
      // switchBonus 가 실제 적용된 경우에만 쿨다운 타임스탬프 갱신(미적용 전환은 쿨다운 유지).
      lastSwitchBonusAt: switchBonus > 0 ? now : lastSwitchBonusAt,
      lastFreshWeaponBonus:
        isFresh && weaponKey
          ? { weaponKey, amount: FRESH_WEAPON_BONUS, at: now }
          : lastFreshWeaponBonus,
    });
    return baseGain; // 화면 데미지 팝업용(콤보×무기변경×맵변경 적용, fresh 제외)
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
      ivN: 0,
      ivSum: 0,
      ivSumSq: 0,
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
      ivN: 0,
      ivSum: 0,
      ivSumSq: 0,
      isPlaying: false,
      startedAt: 0,
      endedAt: null,
      scoreSamples: [],
      ...JUGGLE_INITIAL_STATE,
    });
  },
}));

/** 콤보 유지 창 코드 기본값(ms) — 라이브 값은 스토어 `juggle.comboWindowMs`(어드민 설정). */
export const COMBO_DECAY_MS_EXPORT = JUGGLE_CONFIG_DEFAULT.comboWindowMs;
