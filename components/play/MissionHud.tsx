"use client";

import { useGameStore } from "@/store/gameStore";

/**
 * 인게임 소프트목표 HUD — 세션 연장 + 무기 다양성 유도(→리포트 풍부). "분석 기록 중" 으로
 * 데이터 수집을 암시(이탈 방지). 목표는 뱃지/페르소나 트리거와 정렬(미션=리포트 미리보기).
 */
export function MissionHud() {
  const weapons = useGameStore((s) => Object.keys(s.weaponCounts).length);
  const maxCombo = useGameStore((s) => s.maxCombo);
  const ult = useGameStore((s) => s.ultimateCount);

  const rows = [
    { id: "weapons", label: "무기 3종 써보기", cur: weapons, goal: 3 },
    { id: "combo", label: "콤보 30 달성", cur: maxCombo, goal: 30 },
    { id: "ult", label: "궁극기 발동", cur: ult, goal: 1 },
  ];

  return (
    <div className="pointer-events-none absolute left-3 top-[7.5rem] z-10 sm:left-4 sm:top-[8.5rem]">
      <div className="rounded-xl bg-black/45 px-2.5 py-1.5 backdrop-blur-sm">
        <p className="flex items-center gap-1 text-[10px] font-bold text-red-300">
          <span className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-red-500" />
          분석 기록 중
        </p>
        <ul className="mt-1 space-y-0.5">
          {rows.map((m) => {
            const done = m.cur >= m.goal;
            return (
              <li key={m.id} className="flex items-center gap-1.5 text-[10px]">
                <span>{done ? "✅" : "⬜"}</span>
                <span
                  className={done ? "text-white/40 line-through" : "text-white/85"}
                >
                  {m.label}
                </span>
                {!done && m.goal > 1 && (
                  <span className="tabular-nums text-white/45">
                    {Math.min(m.cur, m.goal)}/{m.goal}
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
