/**
 * 제한 시간(v1.53) — 한 판을 카운트다운으로 끝내는 규칙의 순수 계산. 스토어·HUD·어뷰징 규칙·어드민 편집기가 공유한다.
 *
 * 사용자 확정(2026-09-25): 첫 타격부터 시간이 흐르고, 게임이 이미 멈추는 조건(탭 숨김·창 포커스 이탈)에서 같이 멈춘다.
 * 추가 시간은 궁극기 발동만(+10초), 기본 시간과 추가 시간의 합은 최대 플레이 시간을 넘지 못한다(넘는 몫은 잘림).
 * 기본 60초 · 최대 120초 · 궁극기 +10초 — 수치는 어드민 「제한 시간」(`session_limits.timeLimit`)이 라이브 값이고
 * 여기 값은 코드 기본값이다. 근거 실측(30일): 첫 타격부터 60초 넘게 친 판 42%, 그 판의 80%가 60초 안에 첫 궁극기.
 */

/** 어드민 편집 단위(초). */
export type TimeLimitSeconds = {
  /** 기본 시간 — 첫 타격 때 주어지는 시간(시간 바가 가득 찬 값) */
  baseSeconds: number;
  /** 최대 플레이 시간 — 기본 시간과 추가 시간을 합친 한 판 길이의 상한 */
  maxPlaySeconds: number;
  /** 궁극기 1회 발동당 추가 시간(0 = 늘지 않음) */
  ultimateBonusSeconds: number;
};

export const TIME_LIMIT_SECONDS_DEFAULT: TimeLimitSeconds = {
  baseSeconds: 60,
  maxPlaySeconds: 120,
  ultimateBonusSeconds: 10,
};

/** 어드민 입력 범위(초, 정수). 최대 플레이 시간 하한은 기본 시간, 상한은 최대 경과 시간(`session_limits.maxElapsedSeconds`)이다. */
export const BASE_SECONDS_MIN = 15;
export const BASE_SECONDS_MAX = 300;
export const MAX_PLAY_SECONDS_MAX = 600;
export const ULTIMATE_BONUS_SECONDS_MAX = 30;

/** 마지막 카운트다운 초 — 이 초 이하로 남으면 큰 숫자·빨강·째깍(사용자 요청 10초). */
export const COUNTDOWN_SECONDS = 10;

/**
 * 어뷰징 S11 여유(초) — 시간 종료 뒤 진행 중 궁극기를 끝까지 치는 몫(난타 3.9초)과 프레임 여유.
 * 이 여유를 더한 최대 플레이 시간 동안 S3 비율로 낼 수 있는 점수가 한 판 점수의 상한이다.
 */
export const TIME_CAP_GRACE_SECONDS = 5;

/** 스토어가 쓰는 ms 단위 설정. */
export type TimeLimitConfig = {
  baseMs: number;
  maxPlayMs: number;
  ultimateBonusMs: number;
};

export function timeLimitConfigFromSeconds(s: TimeLimitSeconds): TimeLimitConfig {
  return {
    baseMs: Math.round(s.baseSeconds * 1000),
    maxPlayMs: Math.round(s.maxPlaySeconds * 1000),
    ultimateBonusMs: Math.round(s.ultimateBonusSeconds * 1000),
  };
}

export const TIME_LIMIT_CONFIG_DEFAULT: TimeLimitConfig = timeLimitConfigFromSeconds(TIME_LIMIT_SECONDS_DEFAULT);

/** 추가 시간 실제 적용분 — 지금 예산(기본 시간 + 받은 추가 시간)에 더해 최대 플레이 시간을 넘는 몫은 잘린다. */
export function grantedBonusMs(budgetMs: number, bonusMs: number, maxPlayMs: number): number {
  return Math.max(0, Math.min(bonusMs, maxPlayMs - budgetMs));
}

/** 활성 시계 — 멈춘 구간을 뺀 누적(`accumMs`) + 지금 달리는 구간(`runningSince` 부터, 멈춤·종료면 null). */
export type ActiveClock = { accumMs: number; runningSince: number | null };

export function activePlayMs(clock: ActiveClock, now: number): number {
  const running = clock.runningSince == null ? 0 : Math.max(0, now - clock.runningSince);
  return Math.max(0, clock.accumMs + running);
}

/** 남은 시간(ms, 0 미만 없음). */
export function remainingMs(budgetMs: number, playMs: number): number {
  return Math.max(0, budgetMs - playMs);
}

/** 남은 시간 표시 — 초 올림, 항상 초 숫자(`120` · `60` · `7`). 판이 최대 몇 분이라 분:초 전환 없이 한 형식으로 읽힌다. */
export function formatRemaining(ms: number): string {
  return String(Math.max(0, Math.ceil(ms / 1000)));
}

/** 초를 사람 말로 — 「2분」 「1분 30초」 「45초」(어드민 미리보기·근거 문구). */
export function formatSecondsKo(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const m = Math.floor(total / 60);
  const s = total % 60;
  if (m === 0) return `${s}초`;
  return s === 0 ? `${m}분` : `${m}분 ${s}초`;
}

/** 이 판의 시간을 최대 플레이 시간까지 늘렸는가 — 기본 시간 + 받은 추가 시간이 최대 플레이 시간에 닿음(늘릴 여지가 있던 설정에서만). */
export function reachedMaxPlay(t: { timeBaseMs?: number; timeCapMs?: number; timeBonusMs?: number }): boolean {
  const base = t.timeBaseMs ?? 0;
  const cap = t.timeCapMs ?? 0;
  const bonus = t.timeBonusMs ?? 0;
  return cap > base && base > 0 && base + bonus >= cap;
}

/** 궁극기 N회로 몇 초가 되는지 — 어드민 미리보기용(잘림 반영). */
export function playSecondsAfterUltimates(s: TimeLimitSeconds, ultimates: number): number {
  return Math.min(s.maxPlaySeconds, s.baseSeconds + s.ultimateBonusSeconds * Math.max(0, ultimates));
}

/** 최대 플레이 시간에 닿는 궁극기 횟수 — 추가 시간이 0이거나 늘릴 여지가 없으면 null. */
export function ultimatesToMaxPlay(s: TimeLimitSeconds): number | null {
  const room = s.maxPlaySeconds - s.baseSeconds;
  if (room <= 0 || s.ultimateBonusSeconds <= 0) return null;
  return Math.ceil(room / s.ultimateBonusSeconds);
}
