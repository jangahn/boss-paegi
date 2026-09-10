"use client";

import { useEffect, useRef, useState } from "react";
import { useGameStore } from "@/store/gameStore";
import {
  TAUNT_BAGS_KEY,
  TAUNT_INITIAL_DELAY_MS,
  TAUNT_VISIBLE_MS,
  createTauntSelectorState,
  nextTaunt,
  nextTauntDelayMs,
  parseTauntBags,
  serializeTauntBags,
  type TauntSelectorState,
} from "@/lib/taunts";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { useScoreConfig } from "@/components/ScoreConfigProvider";
import type { RoleId } from "@/lib/roles";
import { DEFAULT_GENDER, type Gender } from "@/lib/gender";

/** 백 커서는 localStorage 에 이어진다(공개 문구만·식별자 없음). storage 불가(시크릿 등)면 세션 메모리로만. */
function loadSelectorState(): TauntSelectorState {
  let raw: string | null = null;
  try {
    raw = window.localStorage.getItem(TAUNT_BAGS_KEY);
  } catch {
    /* storage 불가 — 빈 백으로 시작 */
  }
  return createTauntSelectorState(parseTauntBags(raw));
}

function persistBags(state: TauntSelectorState): void {
  try {
    window.localStorage.setItem(TAUNT_BAGS_KEY, serializeTauntBags(state.bags));
  } catch {
    /* storage 불가 — 무시(다음 판은 새 셔플) */
  }
}

/**
 * 캐릭터 시비 멘트 — 점수대에 맞는 톤의 멘트를 지터 간격(4.5~7s)으로 띄웠다 숨긴다(lib/taunts 셔플백).
 * over(게임 종료) 면 즉시 비우고 멈춘다.
 */
export function useTaunts(
  over: boolean,
  role: RoleId = "boss",
  gender: Gender = DEFAULT_GENDER,
): string | null {
  const [taunt, setTaunt] = useState<string | null>(null);
  const roleCfg = useRoleConfig(); // 마케터 편집 시비멘트(라이브). 프로바이더 값=레이아웃에서 고정 → deps 안전.
  const scoreCfg = useScoreConfig(); // 단계 경계(라이브) — /play 렌더 시점 값으로 한 판 안에서 고정.
  // 셀렉터 상태(백 커서·직전 줄·묶음)는 효과 재실행(롤/설정 로딩)·재시작(over 토글)에도 유지 — 판 사이에 이어진다.
  const stateRef = useRef<TauntSelectorState | null>(null);

  useEffect(() => {
    if (over) {
      // 게임 종료 시 시비 멘트 즉시 제거 — 타이머 UI 동기화(의도적).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTaunt(null);
      return;
    }
    const state = (stateRef.current ??= loadSelectorState());
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    let nextTimer: ReturnType<typeof setTimeout> | undefined;

    const show = () => {
      // 현재 점수대 + 롤에 맞는 톤의 시비 멘트 (초반 무시 → 후반 굴복)
      const t = nextTaunt(state, {
        score: useGameStore.getState().score,
        role,
        gender,
        roleCfg,
        scoreCfg,
      });
      persistBags(state);
      setTaunt(t);
      hideTimer = setTimeout(() => setTaunt(null), TAUNT_VISIBLE_MS);
      nextTimer = setTimeout(show, nextTauntDelayMs());
    };

    nextTimer = setTimeout(show, TAUNT_INITIAL_DELAY_MS);
    return () => {
      if (nextTimer) clearTimeout(nextTimer);
      if (hideTimer) clearTimeout(hideTimer);
      setTaunt(null);
    };
    // role·gender 포함 — 롤/성별 로딩 후 멘트가 boss·male 로 고정되지 않게.
  }, [over, role, gender, roleCfg, scoreCfg]);

  return taunt;
}
