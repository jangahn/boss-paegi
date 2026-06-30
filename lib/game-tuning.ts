/**
 * 무기 다양성(저글링) 게임성 상수 + 저글링 신규 상태 초기값.
 *
 * 의도: fist 단일화(타격 49%·distinct=1 66%)를 "무기 저글링"으로 — 다양성이 곧 고득점·재미.
 * 콤보가 점수 지배변수(corr +0.82)이고 fist는 강해서가 아니라 tap=최저마찰이라 쏠림.
 * 전부 점수천장(MAX_AVG_SCORE_PER_SEC=2000) 안에서 동작 → 서버 cap·리더보드 무변경.
 * 라이브 config화는 후속(이번엔 하드코딩). `store/gameStore.ts` `hit()` 가 소비.
 */

/**
 * 보너스 *지속* 윈도우 — 최근 N charge 타격 안의 고유 무기 수로 배율 산정.
 * 100 = 한 번 여러 무기를 쓰면 ~100타 동안 보너스 유지(자주 안 바꿔도 됨). 윈도우 밖이면 점진 감쇠.
 */
export const VARIETY_WINDOW_SIZE = 100;
/** 배율 최대 도달에 필요한 고유 무기 수(지속 윈도우와 분리). 5종 = 최대(×2). */
export const VARIETY_FULL_AT = 5;
/** 다양성 배율 상한. 최대 = ×(1+1.0)=×2. 750/sec×2=1500<2000 cap → 안전. */
export const VARIETY_CAP = 1.0;
/** 세션 첫 사용 무기의 일회 플랫 보너스(콤보·다양성 배율 미적용). */
export const FRESH_WEAPON_BONUS = 300;
/** 전환 시 궁극 게이지(0~1 스케일) 가속분. */
export const SWITCH_ULT_BONUS_RATIO = 0.1;
/** 전환 궁극보너스 쿨다운 — 2무기 왕복 과충전 방지. */
export const SWITCH_ULT_COOLDOWN_MS = 300;
/** 전환 타격의 콤보 판정창 완화(1500→1800ms) — 느린 무기(throw/grab) 전환 마찰 보정. */
export const SWITCH_COMBO_GRACE_MS = 300;

export type FreshWeaponBonus = { weaponKey: string; amount: number; at: number };

/**
 * 저글링 신규 상태 초기값 — gameStore 의 create 기본값·start()·reset() 셋 다 spread.
 * (weaponWindow 는 hit() 가 항상 새 배열로 교체하므로 공유 [] 참조가 mutate 되지 않음.)
 */
export const JUGGLE_INITIAL_STATE = {
  weaponWindow: [] as string[],
  varietyMult: 0,
  lastChargeWeaponKey: null as string | null,
  lastSwitchBonusAt: null as number | null,
  lastFreshWeaponBonus: null as FreshWeaponBonus | null,
};
