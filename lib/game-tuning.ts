/**
 * 무기 다양성(저글링)·맵 순회 게임성 상수 + 저글링 신규 상태 초기값.
 *
 * 의도: fist 단일화(타격 49%·distinct=1 66%)를 "무기 저글링"으로 — 다양성이 곧 고득점·재미(v0.70).
 * v1.36(2026-09-11, 사용자 확정): ①산정 창을 타격 수(최근 100타)에서 **시간(최근 10초)**으로 — 느린 무기에
 * 불리하지 않고 지금 얼마나 돌리는지를 그대로 반영, 멈추면 식는다. ②**맵변경 배율**을 곱으로 추가(2곳 ×1.5·3곳 ×2.0).
 * ③콤보 유지 창 1.5→2.0초. 창 초수 셋은 어드민 「점수 설정」(score_config.juggle)이 라이브 값이고 여기 값은 코드 기본값.
 * 합산 최대 ×4(무기 ×2 × 맵 ×2) — 점수천장(MAX_AVG_SCORE_PER_SEC 4000)·S3(v10 2800 → v11 3400 실측 재조정)·S7 도 함께 상향(score-limits·anti-abuse).
 * `store/gameStore.ts` `hit()` 가 소비.
 */

/** 무기변경 배율 최대 도달에 필요한 창 안 고유 무기 수. 5종 = 최대(×2). 2·3·4·5종 → ×1.25·1.5·1.75·2.0 */
export const VARIETY_FULL_AT = 5;
/** 무기변경 배율 상한. 최대 = ×(1+1.0)=×2. */
export const VARIETY_CAP = 1.0;
/** 맵변경 배율 최대 도달에 필요한 창 안 고유 맵 수. 3곳 = 최대(×2). 2곳 → ×1.5 */
export const MAP_VARIETY_FULL_AT = 3;
/** 맵변경 배율 상한. 최대 = ×(1+1.0)=×2. */
export const MAP_VARIETY_CAP = 1.0;

/** 창 초수(어드민 편집 단위) — score_config.juggle 의 코드 기본값. */
export type JuggleSeconds = {
  /** 무기변경 배율 산정 창(초) */
  weaponWindowSec: number;
  /** 맵변경 배율 산정 창(초) */
  mapWindowSec: number;
  /** 콤보 유지 창(초) — 이 시간 안에 다음 타격이 오면 콤보가 이어진다(무기 전환 타격은 +SWITCH_COMBO_GRACE_MS) */
  comboWindowSec: number;
};
export const JUGGLE_SECONDS_DEFAULT: JuggleSeconds = {
  weaponWindowSec: 10,
  mapWindowSec: 10,
  comboWindowSec: 2,
};
/** 어드민 입력 범위 — 창은 3~60초, 콤보는 1.0~3.0초(0.1 단위). */
export const JUGGLE_WINDOW_SEC_MIN = 3;
export const JUGGLE_WINDOW_SEC_MAX = 60;
export const COMBO_WINDOW_SEC_MIN = 1;
export const COMBO_WINDOW_SEC_MAX = 3;

/** 스토어가 쓰는 ms 단위 설정. */
export type JuggleConfig = {
  weaponWindowMs: number;
  mapWindowMs: number;
  comboWindowMs: number;
};
export function juggleConfigFromSeconds(s: JuggleSeconds): JuggleConfig {
  return {
    weaponWindowMs: Math.round(s.weaponWindowSec * 1000),
    mapWindowMs: Math.round(s.mapWindowSec * 1000),
    comboWindowMs: Math.round(s.comboWindowSec * 1000),
  };
}
export const JUGGLE_CONFIG_DEFAULT: JuggleConfig = juggleConfigFromSeconds(JUGGLE_SECONDS_DEFAULT);

/** 세션 첫 사용 무기의 일회 플랫 보너스(콤보·다양성 배율 미적용). */
export const FRESH_WEAPON_BONUS = 300;
/** 궁극 게이지 완충에 필요한 명중 수(1/ULT_HITS 씩 누적). 어뷰징 판정(S10)도 참조. */
export const ULT_HITS = 100;
/** 전환 시 궁극 게이지(0~1 스케일) 가속분. */
export const SWITCH_ULT_BONUS_RATIO = 0.1;
/** 전환 궁극보너스 쿨다운 — 2무기 왕복 과충전 방지. */
export const SWITCH_ULT_COOLDOWN_MS = 300;
/** 전환 타격의 콤보 판정창 완화(+300ms) — 느린 무기(throw/grab) 전환 마찰 보정. */
export const SWITCH_COMBO_GRACE_MS = 300;

export type FreshWeaponBonus = { weaponKey: string; amount: number; at: number };
/** 창 산정용 타격 기록(charge 타격만) */
export type HitLogEntry = { t: number; weaponKey: string };
/** 창 산정용 맵 체류 기록 — 게임 시작 맵과 이후 전환마다 1건 */
export type MapLogEntry = { t: number; map: string };

/** 창 안 고유 수 → 배율(선형, 상한). distinct 1 = 0(×1). */
export function varietyMultiplier(distinct: number, fullAt: number, cap: number): number {
  if (!(distinct > 1) || fullAt <= 1) return 0;
  return Math.min(cap, ((distinct - 1) / (fullAt - 1)) * cap);
}

/**
 * [now-windowMs, now] 창 안에 머문 고유 맵 수 — 창 안에 전환된 맵 + 창 시작 시점에 머물던 맵(마지막 전환이 창 이전).
 * 기록이 없으면 0.
 */
export function mapsInWindow(log: readonly MapLogEntry[], now: number, windowMs: number): number {
  const cutoff = now - windowMs;
  const present = new Set<string>();
  let lastBefore: MapLogEntry | null = null;
  for (const e of log) {
    if (e.t >= cutoff) present.add(e.map);
    else if (!lastBefore || e.t >= lastBefore.t) lastBefore = e;
  }
  if (lastBefore) present.add(lastBefore.map);
  return present.size;
}

export function mapVarietyMultiplier(log: readonly MapLogEntry[], now: number, windowMs: number): number {
  return varietyMultiplier(mapsInWindow(log, now, windowMs), MAP_VARIETY_FULL_AT, MAP_VARIETY_CAP);
}

/**
 * 저글링 신규 상태 초기값 — gameStore 의 create 기본값·start()·reset() 셋 다 spread.
 * (hitLog/mapLog 는 항상 새 배열로 교체하므로 공유 [] 참조가 mutate 되지 않음.) juggle 설정은 여기 없음(판 사이 유지).
 */
export const JUGGLE_INITIAL_STATE = {
  hitLog: [] as HitLogEntry[],
  varietyMult: 0,
  mapLog: [] as MapLogEntry[],
  currentMap: null as string | null,
  mapMult: 0,
  lastChargeWeaponKey: null as string | null,
  lastSwitchBonusAt: null as number | null,
  lastFreshWeaponBonus: null as FreshWeaponBonus | null,
};
