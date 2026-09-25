/**
 * 젤리 스쿼시(v1.65) — 타격 축으로 눌렸다가 감쇠 진동하며 복원하는 인형 몸통 질감. 게임 인형(`game/entities/Doll.ts`)과
 * 게임 밖 화면(홈 얼굴 · 갤러리 카드를 누를 때, `lib/motion.ts` `playJelly`)이 같은 식을 쓴다 — 게임 안팎의 「찌르면 출렁」이
 * 같은 느낌이 되도록 곡선을 한 곳에 둔다. 의존성 없는 순수 모듈.
 *
 * sq(t) = amp · e^(−damp·t) · cos(2π·freq·t). 축 성분(ax = dirX², ay = dirY²)만큼 누르고 수직 축은 부피를 지키듯 0.7배 부푼다.
 */

/** 기본 타격(주먹 등) — 빠르게 몇 번 떨고 멈춘다. */
export const JELLY_HIT = { freq: 9, damp: 6 } as const;
/** 뿅망치 — 낮은 감쇠로 띠용용용 4~5번 튄다. */
export const JELLY_BOUNCE = { freq: 7.5, damp: 2.4 } as const;

/** 스쿼시 값 sq 를 축 성분에 따라 가로 · 세로 배율로. */
export function squashScale(sq: number, ax: number, ay: number): { sx: number; sy: number } {
  return { sx: 1 - sq * ax + sq * 0.7 * ay, sy: 1 - sq * ay + sq * 0.7 * ax };
}

/** 시각 t(초)의 스쿼시 값 — 게임은 프레임마다 위상 · 진폭을 적분하고, 여기는 같은 식의 닫힌 꼴. */
export function squashAt(t: number, amp: number, freq: number, damp: number): number {
  return amp * Math.exp(-damp * t) * Math.cos(2 * Math.PI * freq * t);
}

/**
 * 한 번 찔렀을 때의 배율 곡선을 일정 간격으로 뽑는다(WAAPI keyframes 용). 진폭이 처음의 3% 아래로 줄면 끝.
 * 기본은 위에서 누르는 방향(ax 0, ay 1) — 세로로 눌리고 가로로 부푼다.
 */
export function jellyFrames(opts: {
  amp: number;
  freq?: number;
  damp?: number;
  ax?: number;
  ay?: number;
  stepMs?: number;
}): { sx: number; sy: number; offset: number }[] {
  const { amp, freq = JELLY_HIT.freq, damp = JELLY_HIT.damp, ax = 0, ay = 1, stepMs = 16 } = opts;
  const endT = Math.log(1 / 0.03) / damp; // e^(−damp·t) = 0.03
  const steps = Math.max(2, Math.ceil((endT * 1000) / stepMs));
  const frames: { sx: number; sy: number; offset: number }[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = (i / steps) * endT;
    const sq = i === steps ? 0 : squashAt(t, amp, freq, damp);
    frames.push({ ...squashScale(sq, ax, ay), offset: i / steps });
  }
  return frames;
}

/** 곡선 길이(ms) — 진폭이 3% 로 줄 때까지. */
export function jellyDurationMs(damp: number = JELLY_HIT.damp): number {
  return Math.round((Math.log(1 / 0.03) / damp) * 1000);
}
