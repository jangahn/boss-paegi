"use client";

import { comboMultiplier, useGameStore } from "@/store/gameStore";

export function ScoreBoard() {
  const score = useGameStore((s) => s.score);
  const combo = useGameStore((s) => s.combo);
  const multiplier = comboMultiplier(combo);

  return (
    <div className="pointer-events-none absolute inset-x-0 top-[max(0.75rem,env(safe-area-inset-top))] z-10 flex flex-col items-center gap-0.5 px-4 text-white sm:gap-1 sm:px-6 sm:pt-2">
      <div className="text-4xl font-extrabold tabular-nums drop-shadow-lg sm:text-5xl">
        {score.toLocaleString()}
      </div>
      {combo > 1 && (
        <div className="flex items-baseline gap-1.5 text-xs font-bold uppercase tracking-wider text-amber-300 sm:gap-2 sm:text-sm">
          <span className="text-xl tabular-nums sm:text-2xl">x{combo}</span>
          <span className="opacity-80">콤보</span>
          {multiplier > 1 && (
            <span className="text-[10px] text-amber-200 sm:text-xs">
              ({multiplier.toFixed(1)}×)
            </span>
          )}
        </div>
      )}
    </div>
  );
}
