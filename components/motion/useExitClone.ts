"use client";

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { prefersReducedMotion } from "@/lib/motion";

/**
 * 퇴장 연출(v1.65) — React 가 요소를 지우는 순간 그 복제본을 제자리에 잠깐 남겨 퇴장 애니메이션을 돌린 뒤 지운다.
 * 부르는 쪽의 조건부 렌더(`{open && <X/>}`)를 고치지 않고 모달 · 메뉴 · 말풍선이 사라질 때도 움직인다.
 * 복제본은 포인터를 막지 않고(inert) 화면낭독기에서 빠지며 id 를 떼어 중복을 만들지 않는다. 모션 감소면 바로 사라진다.
 *
 * 레이아웃 이펙트 정리는 React 가 DOM 을 떼기 전에 돌아(삭제 순회), 요소의 부모에 복제본을 끼울 수 있다.
 */
export function useExitClone<T extends HTMLElement>(
  ref: RefObject<T | null>,
  play: (clone: HTMLElement) => Animation | Animation[] | null,
  enabled = true,
): void {
  const playRef = useRef(play);
  const enabledRef = useRef(enabled);
  // 요소는 첫 렌더 뒤에 생길 수 있어(포털 마운트 게이트) 렌더마다 마지막 요소를 기억해 둔다.
  const elRef = useRef<T | null>(null);
  useEffect(() => {
    playRef.current = play;
    enabledRef.current = enabled;
  });
  useLayoutEffect(() => {
    elRef.current = ref.current;
  });
  useLayoutEffect(() => {
    return () => {
      const el = elRef.current;
      const parent = el?.parentNode;
      if (!el || !parent || !enabledRef.current || prefersReducedMotion()) return;
      const clone = el.cloneNode(true) as HTMLElement;
      clone.removeAttribute("id");
      for (const node of clone.querySelectorAll("[id]")) node.removeAttribute("id");
      // 등장 연출 클래스(motion-*)는 떼어 복제본이 등장 애니메이션을 다시 돌리지 않게 한다.
      for (const node of [clone, ...clone.querySelectorAll<HTMLElement>("[class*='motion-']")]) {
        for (const cls of [...node.classList]) if (cls.startsWith("motion-")) node.classList.remove(cls);
      }
      clone.setAttribute("aria-hidden", "true");
      clone.inert = true;
      clone.style.pointerEvents = "none";
      parent.insertBefore(clone, el.nextSibling);
      const animations = [playRef.current(clone)].flat().filter((a): a is Animation => !!a);
      const remove = () => clone.remove();
      Promise.all(animations.map((a) => a.finished)).then(remove, remove);
      window.setTimeout(remove, 800); // 탭이 숨겨져 애니메이션이 멈춰도 남지 않게
    };
  }, []);
}
