"use client";

import { useEffect, useRef, useState } from "react";
import { useGameStore } from "@/store/gameStore";

export type Milestone = { id: number; text: string };

/**
 * 플레이 중 마일스톤 토스트 — "지금 내 플레이가 보고서에 기록되고 있다"를 암시해 이탈 방지.
 * store.subscribe 기반(별도 interval 없음 — 하이라이트 recorder 와 신호원만 공유, 충돌 X).
 * recording=false(모달/언마운트) 면 비활성. recording 토글마다 트래커 리셋(재시작 대응).
 */
export function useGameMilestones({ recording }: { recording: boolean }): {
  milestones: Milestone[];
} {
  const [milestones, setMilestones] = useState<Milestone[]>([]);
  const idRef = useRef(0);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!recording) return;
    let lastComboTier = 0;
    let lastUlt = 0;
    const seenWeapons = new Set<string>();

    const push = (text: string) => {
      const id = ++idRef.current;
      setMilestones((m) => [...m.slice(-2), { id, text }]); // 최대 3개
      const timer = setTimeout(
        () => setMilestones((m) => m.filter((x) => x.id !== id)),
        2200
      );
      timersRef.current.push(timer);
    };

    const unsub = useGameStore.subscribe((s) => {
      // 콤보 10단위 돌파
      const tier = Math.floor(s.maxCombo / 10) * 10;
      if (tier >= 10 && tier > lastComboTier) {
        lastComboTier = tier;
        push(`콤보 ${tier}! 📊 보고서에 기록 중`);
      }
      // 새 무기(2번째부터 = 다양성) → 융단폭격형 등 페르소나 유도
      for (const k of Object.keys(s.weaponCounts)) {
        if (!seenWeapons.has(k)) {
          seenWeapons.add(k);
          if (seenWeapons.size > 1) push("새 무기 분석 추가 🗡️");
        }
      }
      // 궁극기 발동
      if (s.ultimateCount > lastUlt) {
        lastUlt = s.ultimateCount;
        push("궁극기 발동 💥 기록됨");
      }
    });

    return () => {
      unsub();
      timersRef.current.forEach(clearTimeout);
      timersRef.current = [];
      setMilestones([]);
    };
  }, [recording]);

  return { milestones };
}
