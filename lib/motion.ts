import { JELLY_HIT, jellyDurationMs, jellyFrames } from "./jelly";

/**
 * 모션 토큰(v1.65) — 게임 밖 화면 연출의 시간 · 이징 · 스프링 단일 소스. CSS 쪽 같은 값은 `app/globals.css` 「모션」 절.
 *
 * 규칙(9/25 설계, `_local/SPEC-interaction-motion-2026-09-25.md`):
 * - 모티프 = 인사기록부(서류가 올라오고 도장이 찍힌다) + 게임 인형과 같은 젤리 반동(`lib/jelly.ts`).
 * - transform 과 단색 덮개 opacity 만 움직인다. 크기 · 위치 속성은 움직이지 않는다(밀림 규약).
 * - 글자 · 그라데이션에는 opacity 애니메이션을 쓰지 않는다(iOS WebKit 글자 잔상, globals.css 「iOS 잔상」 주석).
 * - 내용 표시를 늦추지 않는다 — 연출은 제자리에 있는 내용 위에 덧씌우고, 버튼은 연출 중에도 누를 수 있다.
 * - 모션 감소 설정이면 연출 없이 최종 상태. iOS · Android 한쪽에서만 되는 기능(진동 등)은 쓰지 않는다(9/25 사용자 결정).
 */

/** 시간(ms) — 퇴장은 등장보다 빠르게. */
export const MOTION_MS = { fast: 120, base: 200, slow: 320 } as const;

/** 이징(Motion 의 cubic-bezier 배열) — CSS `--ease-paper` 와 같다. */
export const EASE_PAPER = [0.2, 0.8, 0.2, 1] as const;

/** 스프링 — snap: 눌렀다 복귀, paper: 서류가 자리 잡기(과장 없음). */
export const SPRING_SNAP = { type: "spring", stiffness: 520, damping: 34, mass: 0.8 } as const;
export const SPRING_PAPER = { type: "spring", stiffness: 380, damping: 36 } as const;

/**
 * 결과 보고서 연출 시점(ms, 보고서가 열린 순간 기준) — CSS 지연(`--cer-*`)과 같은 값. 전체 약 1.5초, 탭하면 끝 상태.
 * sheet 올라옴 → score 카운트업(scoreMs 동안) → stamp 쾅(impact 에 소리) → rise 등급 · 유형 → pop 뱃지 · 신기록 → nudge 다시 패기.
 */
export const CEREMONY_MS = {
  score: 120,
  scoreMs: 800,
  stamp: 900,
  impact: 1080,
  rise: 1000,
  pop: 1200,
  nudge: 1500,
  end: 1900,
} as const;

/** 모션 감소 설정(OS) — 켜져 있으면 연출 없이 최종 상태. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

type Animatable = Element & { animate?: Element["animate"] };

/**
 * 찌르기 — 요소를 게임 인형과 같은 젤리 곡선으로 한 번 출렁(WAAPI, CSS `scale` 속성만). 진행 중이면 끊고 새로.
 * 호버 확대(`group-hover:scale-*`)가 걸린 요소가 아니라 그 바깥 틀에 건다 — 같은 `scale` 속성을 덮어써 끝에 튀지 않게.
 */
export function playJelly(
  el: Animatable | null,
  opts: { amp?: number; freq?: number; damp?: number; origin?: string } = {},
): void {
  if (!el || typeof el.animate !== "function" || prefersReducedMotion()) return;
  if (opts.origin && el instanceof HTMLElement) el.style.transformOrigin = opts.origin;
  const damp = opts.damp ?? JELLY_HIT.damp;
  const frames = jellyFrames({ amp: opts.amp ?? 0.14, freq: opts.freq, damp });
  for (const running of el.getAnimations()) {
    if (running.id === "jelly") running.cancel();
  }
  const anim = el.animate(
    frames.map((f) => ({ scale: `${f.sx.toFixed(4)} ${f.sy.toFixed(4)}`, offset: f.offset })),
    { duration: jellyDurationMs(damp), easing: "linear" },
  );
  anim.id = "jelly";
}

/**
 * 축하 조각 — 기준 요소 가운데에서 이모지가 튀어 흩어진다(신기록 · 캐릭터 완성). 크기 0 으로 줄며 사라지고(글자 opacity 없음),
 * 끝나면 DOM 에서 지운다. 화면 밖으로 넘치지 않게 fixed 층에 그리고 포인터를 막지 않는다.
 */
export function burst(anchor: Element | null, opts: { emojis: readonly string[]; count?: number; distance?: number }): void {
  if (!anchor || typeof document === "undefined" || prefersReducedMotion()) return;
  const rect = anchor.getBoundingClientRect();
  const layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.style.cssText = `position:fixed;left:${rect.left + rect.width / 2}px;top:${
    rect.top + rect.height / 2
  }px;width:0;height:0;pointer-events:none;z-index:200;`;
  document.body.appendChild(layer);
  const count = opts.count ?? 14;
  const distance = opts.distance ?? 90;
  let pending = count;
  // 탭이 숨겨져 애니메이션이 멈춰도 층이 남지 않게 한 번 더 치운다.
  window.setTimeout(() => layer.remove(), 2500);
  for (let i = 0; i < count; i++) {
    const piece = document.createElement("span");
    piece.textContent = opts.emojis[i % opts.emojis.length];
    piece.style.cssText = "position:absolute;left:0;top:0;font-size:18px;line-height:1;translate:-50% -50%;";
    layer.appendChild(piece);
    const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.6;
    const d = distance * (0.6 + Math.random() * 0.5);
    const x = Math.cos(angle) * d;
    const y = Math.sin(angle) * d - 24;
    const spin = (Math.random() - 0.5) * 540;
    const anim = piece.animate(
      [
        { transform: "translate(0, 0) rotate(0deg) scale(0.4)" },
        { transform: `translate(${x * 0.8}px, ${y * 0.8}px) rotate(${spin * 0.6}deg) scale(1.1)`, offset: 0.45 },
        { transform: `translate(${x}px, ${y + 40}px) rotate(${spin}deg) scale(0)` },
      ],
      { duration: 900 + Math.random() * 300, easing: "cubic-bezier(.2,.8,.3,1)", fill: "forwards" },
    );
    anim.onfinish = () => {
      pending -= 1;
      if (pending === 0) layer.remove();
    };
  }
}
