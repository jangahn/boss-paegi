"use client";

import { useEffect, useState } from "react";
import { useGameStore } from "@/store/gameStore";
import { randomTaunt } from "@/lib/taunts";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { useScoreConfig } from "@/components/ScoreConfigProvider";
import type { RoleId } from "@/lib/roles";
import { DEFAULT_GENDER, type Gender } from "@/lib/gender";

const TAUNT_INITIAL_DELAY_MS = 1500;
const TAUNT_VISIBLE_MS = 3000;
const TAUNT_INTERVAL_MS = 5500;

/**
 * 캐릭터 시비 멘트 — 일정 간격으로 점수대에 맞는 톤의 멘트를 띄웠다 숨긴다.
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

  useEffect(() => {
    if (over) {
      // 게임 종료 시 시비 멘트 즉시 제거 — 타이머 UI 동기화(의도적).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setTaunt(null);
      return;
    }
    let lastTaunt = "";
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const show = () => {
      // 현재 점수대 + 롤에 맞는 톤의 시비 멘트 (초반 무시 → 후반 굴복)
      const t = randomTaunt({
        exclude: lastTaunt,
        score: useGameStore.getState().score,
        role,
        gender,
        roleCfg,
        scoreCfg,
      });
      lastTaunt = t;
      setTaunt(t);
      hideTimer = setTimeout(() => setTaunt(null), TAUNT_VISIBLE_MS);
    };

    const initial = setTimeout(show, TAUNT_INITIAL_DELAY_MS);
    const interval = setInterval(show, TAUNT_INTERVAL_MS);
    return () => {
      clearTimeout(initial);
      clearInterval(interval);
      if (hideTimer) clearTimeout(hideTimer);
      setTaunt(null);
    };
    // role·gender 포함 — 롤/성별 로딩 후 멘트가 boss·male 로 고정되지 않게.
  }, [over, role, gender, roleCfg, scoreCfg]);

  return taunt;
}
