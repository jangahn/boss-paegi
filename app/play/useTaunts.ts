"use client";

import { useEffect, useState } from "react";
import { useGameStore } from "@/store/gameStore";
import { randomTaunt } from "@/lib/taunts";

const TAUNT_INITIAL_DELAY_MS = 1500;
const TAUNT_VISIBLE_MS = 3000;
const TAUNT_INTERVAL_MS = 5500;

/**
 * 부장님 시비 멘트 — 일정 간격으로 점수대에 맞는 톤의 멘트를 띄웠다 숨긴다.
 * over(게임 종료) 면 즉시 비우고 멈춘다.
 */
export function useTaunts(over: boolean): string | null {
  const [taunt, setTaunt] = useState<string | null>(null);

  useEffect(() => {
    if (over) {
      setTaunt(null);
      return;
    }
    let lastTaunt = "";
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const show = () => {
      // 현재 점수대에 맞는 톤의 시비 멘트 (초반 무시 → 후반 굴복)
      const t = randomTaunt(lastTaunt, useGameStore.getState().score);
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
  }, [over]);

  return taunt;
}
