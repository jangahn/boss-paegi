"use client";

import { useEffect, useRef, type MutableRefObject } from "react";
import type { GameHandle } from "@/game/BossPaegiGame";
import { resolveGameKey, shouldIgnoreKeyEvent, type AttackKey } from "@/lib/keyboard-controls";
import { useGameStore } from "@/store/gameStore";

/**
 * PC 키보드 조작(v1.50) — 숫자 1~9 = 무기 칸 · Q W E R T Y = 맵 · 스페이스·방향키 = 공격(`lib/keyboard-controls` 가 키 해석의 단일 소스).
 *
 * - 스페이스는 궁극기가 준비됐으면 발동(`onUltimate` = 버튼과 같은 handleUltimate — 게이지 소비·텔레메트리 동반), 아니면 무기 동작.
 * - 방향키는 8방향 — 두 키를 같이 누르면 대각선(동시 입력 묶기·누르고 있는 동안의 방향 전환은 `game/input/KeyboardInput` 이 맡는다).
 * - OS 키 반복(`event.repeat`, 25~33회/초)은 동작으로 받지 않는다 — 어뷰징 신호(S1·S5)에 그대로 걸린다. 누르고 있기는 keydown/keyup 으로만.
 * - 처리한 키는 keydown·keyup 모두 기본 동작을 막는다 — 마우스로 누른 버튼(예: 「그만 패기」)에 포커스가 남아 있어도 스페이스가 그 버튼을 다시 누르지 않는다.
 * - blur·hidden 에는 keyup 이 오지 않으므로 눌림 상태를 비운다(게임 쪽 제스처는 pause → cancelActivePointers 가 취소).
 */
export function useKeyboardControls(opts: {
  enabled: boolean;
  gameRef: MutableRefObject<GameHandle | null>;
  onWeaponSlot: (slot: number) => void;
  onMap: (index: number) => void;
  onUltimate: () => void;
  /** 스페이스로 궁극기를 발동했을 때 — 텔레메트리 keyActions(그 밖의 공격 동작은 게임이 onKeyAction 으로 센다) */
  onUltimateKey: () => void;
}): void {
  const { enabled, gameRef } = opts;
  // 최신 콜백 미러 — 리스너를 매 렌더 다시 달지 않는다.
  const latest = useRef(opts);
  useEffect(() => {
    latest.current = opts;
  });

  useEffect(() => {
    if (!enabled) return;
    const held = new Set<AttackKey>();

    const onKeyDown = (e: KeyboardEvent) => {
      if (shouldIgnoreKeyEvent(e)) return;
      const key = resolveGameKey(e.code);
      if (!key) return;
      e.preventDefault();
      if (e.repeat) return;
      if (key.kind === "weapon") {
        latest.current.onWeaponSlot(key.slot);
        return;
      }
      if (key.kind === "map") {
        latest.current.onMap(key.index);
        return;
      }
      if (key.key === "space" && useGameStore.getState().ultReady) {
        latest.current.onUltimate();
        latest.current.onUltimateKey();
        return;
      }
      held.add(key.key);
      gameRef.current?.keyAction(key.key, "down");
    };

    const onKeyUp = (e: KeyboardEvent) => {
      const key = resolveGameKey(e.code);
      if (!key) return;
      if (!shouldIgnoreKeyEvent(e)) e.preventDefault();
      if (key.kind !== "attack" || !held.delete(key.key)) return;
      gameRef.current?.keyAction(key.key, "up");
    };

    const releaseAll = () => held.clear();
    const onVisibility = () => {
      if (document.hidden) releaseAll();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", releaseAll);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", releaseAll);
      document.removeEventListener("visibilitychange", onVisibility);
      // 비활성화(게임 종료·언마운트) — 진행 중 제스처는 씬의 end()/destroy() 가 cancelActivePointers 로 이미 닫는다.
      held.clear();
    };
  }, [enabled, gameRef]);
}
