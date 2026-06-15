"use client";

import { comboMultiplier, useGameStore } from "@/store/gameStore";

export function ScoreBoard() {
  const score = useGameStore((s) => s.score);
  const combo = useGameStore((s) => s.combo);
  const ultProgress = useGameStore((s) => s.ultProgress);
  const ultReady = useGameStore((s) => s.ultReady);
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

      {/* 궁극기 게이지 — iOS WebKit 그라데이션/레이어 손상 방지:
          ① 그라데이션 fill 에 opacity 애니(animate-pulse) 금지(텍스처 재합성→색 깨짐 트리거).
             준비완료 반짝임은 라벨 텍스트에만(그라데이션 미포함 → 안전).
          ② 트랙은 isolate+transform-gpu 로 깨끗한 합성 컨텍스트(둥근 클립+그라데이션 안정화),
             준비완료 강조는 정적 amber ring(애니 아님).
          ③ fill 은 ready/charging 전환마다 re-key → 새 레이어로 누적 손상 차단. */}
      <div className="mt-1 flex w-40 flex-col items-center gap-0.5 sm:w-48">
        <div
          className={`isolate h-2 w-full transform-gpu overflow-hidden rounded-full bg-black/40 ring-1 ${
            ultReady ? "ring-amber-400/70" : "ring-white/15"
          }`}
        >
          <div
            key={ultReady ? "ready" : "charging"}
            className={`h-full rounded-full transition-[width] duration-200 ${
              ultReady
                ? "bg-gradient-to-r from-amber-400 to-red-500"
                : "bg-gradient-to-r from-sky-400 to-indigo-500"
            }`}
            style={{ width: `${Math.round(ultProgress * 100)}%` }}
          />
        </div>
        <span
          className={`text-[9px] font-bold uppercase tracking-widest sm:text-[10px] ${
            ultReady ? "animate-pulse text-amber-300" : "text-white/45"
          }`}
        >
          {ultReady ? "★ 궁극기 준비 완료 ★" : "궁극기 게이지"}
        </span>
      </div>
    </div>
  );
}
