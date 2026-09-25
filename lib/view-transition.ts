/**
 * View Transitions(v1.65) — Next 16 App Router 의 React `<ViewTransition>` 과 함께 쓰는 이름 · 타입 단일 소스.
 * - 상단 메뉴 이동(`NAV_TRANSITION`): 헤더는 그대로, 본문만 짧게 교차(루트 레이아웃), 선택 알약은 이전 칸에서 새 칸으로 미끄러진다.
 * - 캐릭터 → 게임(`PLAY_DOLL_TRANSITION`): 누른 캐릭터 이미지가 게임 로딩 막의 캐릭터 자리로 커지며 이어진다.
 * 지원하지 않는 브라우저는 그냥 즉시 바뀐다(점진적 향상). 모션 감소면 0초(globals.css).
 */

/** 상단 메뉴 링크의 전환 타입 — 루트 레이아웃 경계가 이 타입일 때만 본문을 교차한다. */
export const NAV_TRANSITION = "nav";

/** 상단 메뉴 선택 알약의 view-transition-name(화면에 항상 하나). */
export const NAV_PILL_NAME = "nav-pill";

/** 캐릭터 → 게임 로딩 막 이어짐의 이름. */
export const PLAY_DOLL_TRANSITION = "play-doll";

/**
 * 누른 캐릭터 이미지에 이어질 이름을 붙인다 — 목록에 캐릭터가 여럿이라 처음부터 이름을 붙이면 겹치므로(이름은 화면에 하나여야
 * 한다) 누르는 순간 그 하나에만 붙이고, 전에 붙인 것은 뗀다. 이동하지 않고 끝나면(스크롤 등) 다음 누름에서 떼어진다.
 */
export function markPlayDollSource(el: HTMLElement | null): void {
  if (!el) return;
  clearPlayDollSource();
  el.style.viewTransitionName = PLAY_DOLL_TRANSITION;
  el.setAttribute("data-play-doll-source", "");
}

/** 붙여 둔 이름을 뗀다 — 누른 채 스크롤로 바뀌면(pointercancel) 바로. */
export function clearPlayDollSource(): void {
  if (typeof document === "undefined") return;
  for (const prev of document.querySelectorAll<HTMLElement>("[data-play-doll-source]")) {
    prev.style.viewTransitionName = "";
    prev.removeAttribute("data-play-doll-source");
  }
}
