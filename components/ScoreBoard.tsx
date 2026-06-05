"use client";

import { useGameStore } from "@/store/gameStore";

export function ScoreBoard() {
  const score = useGameStore((s) => s.score);
  const combo = useGameStore((s) => s.combo);
  const multiplier = 1 + Math.floor(combo / 5) * 0.5;

  return (
    <div className="pointer-events-none absolute inset-x-0 top-0 z-10 flex flex-col items-center gap-1 px-6 pt-6 text-white">
      <div className="text-5xl font-extrabold tabular-nums drop-shadow-lg">
        {score.toLocaleString()}
      </div>
      {combo > 1 && (
        <div className="flex items-baseline gap-2 text-sm font-bold uppercase tracking-wider text-amber-300">
          <span className="text-2xl tabular-nums">x{combo}</span>
          <span className="opacity-80">콤보</span>
          {multiplier > 1 && (
            <span className="text-xs text-amber-200">
              ({multiplier.toFixed(1)}× 점수)
            </span>
          )}
        </div>
      )}
    </div>
  );
}
