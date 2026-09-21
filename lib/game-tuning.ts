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

/**
 * PC 키보드 조작(v1.50) — 키 입력은 기존 포인터 제스처를 합성해 같은 핸들러로 들어간다(`game/input/KeyboardInput`).
 * 원칙: **포인터로 낼 수 있는 '보통 세기'·빈도 이하** — 점수식·쿨다운·어뷰징 봉투(S1 지속 18타/초·S3·S5)를 그대로 상속한다.
 * OS 키 반복(25~33회/초)은 입력으로 받지 않는다(호출부가 `event.repeat` 무시). 사용자 확정(2026-09-21): 일단 이 값으로 시작해 조정.
 */
export const KEYBOARD_TUNING = {
  /** 탭(주먹·뿅망치)·투척 — 포인터 쪽에 쿨다운이 없는 두 종류의 키 입력 최소 간격(ms). 80ms = 12.5회/초(사람 실측 지속 14.6회/초 이하).
   *  간격 안에 들어온 입력은 버리지 않고 한 개를 기억했다가 간격이 끝나는 즉시 낸다(연타가 씹히지 않는다). */
  tapMinMs: 80,
  throwMinMs: 80,
  /** 기억해 둔 입력의 유효 시간(ms) — 이보다 오래된 입력은 버린다(한참 뒤에 혼자 나가지 않게). */
  bufferMs: 250,
  /** 방향키 동시 입력 대기(ms) — 한 번 누르고 끝나는 동작은 첫 방향키 뒤 이만큼 기다려 같이 눌린 키를 한 동작(8방향)으로 묶는다. */
  chordMs: 20,
  /**
   * 싸대기 — 키 한 번 = **왕복 2타**(정타 → 되돌아오는 역타, 사용자 조정). 구간마다 위치는 임팩트 지점(머리 중심) 기준, **캐릭터 표시
   * 크기에 대한 비율**(진행 방향 +) — 손이 얼굴 바깥에서 들어와 얼굴을 지나 바깥으로 빠진다(사용자 조정: 얼굴 안에서만 움직이면
   * 싸대기 같지 않다 → 범위 2배, 546px 캐릭터에서 −340px → +220px). `out` = 감속(준비 동작·방향 전환·여운), `in` = 2차 가속
   * (타격 구간 — 0 을 지나는 순간이 임팩트). 온전한 동작: 준비 → 정타 → 방향 전환 → 역타 → 여운(345ms). 첫 타는 임팩트 속도가
   * 계수 상한 2.0(28점)을 넘는다.
   */
  swipeFull: [
    { from: -0.18, to: -0.62, ms: 70, ease: "out" },
    { from: -0.62, to: 0.22, ms: 90, ease: "in", hit: 1 },
    { from: 0.22, to: 0.4, ms: 35, ease: "out" },
    { from: 0.4, to: -0.22, ms: 90, ease: "in", hit: -1 },
    { from: -0.22, to: -0.4, ms: 60, ease: "out" },
  ],
  /**
   * 싸대기 연타(사용자 조정: 호흡 2배) — 직전 임팩트 뒤 `swipeChainWindowMs` 안에 이어지는 입력은 여운을 끊고 짧은 준비 동작으로 친다.
   * 임팩트 간격 120ms(8.3타/초)로 맞춰져 있다: 30 + 62(정타) → +120(역타) → 다음 동작은 역타 뒤 28ms 부터.
   */
  swipeChain: [
    { from: -0.15, to: -0.4, ms: 30, ease: "out" },
    { from: -0.4, to: 0.18, ms: 75, ease: "in", hit: 1 },
    { from: 0.18, to: 0.33, ms: 47, ease: "out" },
    { from: 0.33, to: -0.18, ms: 75, ease: "in", hit: -1 },
    { from: -0.18, to: -0.33, ms: 50, ease: "out" },
  ],
  /** 임팩트 간 최소 간격(ms) — 연타 시작 시점을 이 값에 맞춰 늦춘다. */
  swipeChainMinMs: 120,
  swipeChainWindowMs: 260,
  /**
   * 첫 타(온전한 준비 동작) 외의 타격이 보고하는 속도(px/s) = 계수 1.6(씬은 speed ÷ 1100, 22점). 처리량 22 × 8.3 = 183점/초 ≤
   * 포인터 최대 28 × 6.7(SwipeInput 쿨다운 150ms) = 187점/초 — 빈도를 올린 만큼 한 타 세기를 낮춰 봉투(S2·S3)를 지킨다.
   */
  swipeChainSpeed: 1760,
  /**
   * 잡아던지기 — 살짝 당겼다(준비 70ms·30px) 가속해서(200ms, 2차 가속) 놓는다. 놓는 순간 ≈2,700px/s, 씬이 재는 마지막 80ms
   * 평균 ≈2,300px/s(사용자 조정: 2배) → 던져지는 속도는 벽 관통 방지 상한(28px/step ≈1,680px/s)에 걸리고 power 1.0(50점) =
   * 포인터로 낼 수 있는 최대 세기. 연달아 던지면(직전 시작 뒤 700ms 안) 준비 40ms·던지기 150ms 의 짧은 동작.
   * 시작 간격 최소 300ms(3.3회/초 — 사용자 조정: 호흡 빠르게). 50점 × 3.3 = 167점/초 + 벽 타격이라 250ms(4회/초)는
   * 점수/초 상한(S3 3,400 ÷ 최대 배율 16 = 212점/초)에 여유가 2% 뿐이어서 300ms 로 둔다.
   */
  grabMinMs: 300,
  grabWindupMs: 70,
  grabWindupPx: 30,
  grabThrowMs: 200,
  grabThrowPx: 242,
  grabChainWindupMs: 40,
  grabChainThrowMs: 150,
  grabChainWindowMs: 700,
  /** 꼬집기 — 당기는 점의 최고 속도(px/s, 사용자 조정: 2배)와 가속 응답(1/s — 클수록 빨리 붙는다). 방향키 = 그 방향으로
   *  가속, 방향을 바꾸면 관성을 안고 돌아간다. 스페이스 = 방향을 계속 바꾸는 자동 움직임(속도 0.55~1.45배 물결). */
  pinchPullSpeed: 1300,
  pinchAccel: 14,
  /** 펜 — 펜촉 이동 속도(px/s, 화면 기준). 40px 마다 1타라 평균 7.5타/초. 스페이스 자동 곡선은 속도가 0.55~1.45배로 출렁인다(등속 기계 동작이 아니다). */
  penSpeed: 300,
  /** 투척·비비탄 발사 지점 — 캐릭터 중심에서 `표시 크기 × ratio`(최대 maxPx) 떨어진 곳, 화면 밖이면 가장자리 안쪽 marginPx 로.
   *  투척물은 950px/s·중력 28% 잔존이라 수평 450px 낙차 +7px / 700px +71px / 1000px +199px — 450px 안쪽이어야 정지한 캐릭터에 항상 맞는다. */
  spawnRatio: 0.82,
  spawnMaxPx: 450,
  spawnMarginPx: 24,
} as const;
