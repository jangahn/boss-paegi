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

      {/* 궁극기 게이지 — iOS WebKit 합성 레이어/텍스처 손상 방지:
          opacity 애니(animate-pulse)를 그라데이션 fill 이나 텍스트에 걸면 iOS 가 텍스처/텍스트
          레이어를 잘못 갱신 → 색 깨짐(그라데이션) / 옛 텍스트 잔상 겹침(라벨)이 누적된다.
          → ① fill·라벨엔 opacity 애니 금지(정적). ② 준비완료 dim/bright 펄스는 fill 위에 얹은
          "솔리드 검정 오버레이"의 opacity 만 애니(.animate-ult-dim) — 솔리드 색은 손상 안 됨.
          ③ 트랙 isolate+transform-gpu(깨끗한 합성 컨텍스트), fill·라벨 ready/charging 토글마다 re-key. */}
      <div className="mt-1 flex w-40 flex-col items-center gap-0.5 sm:w-48">
        <div
          className={`relative isolate h-2 w-full transform-gpu overflow-hidden rounded-full bg-black/40 ring-1 ${
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
          {ultReady && (
            <div
              aria-hidden
              className="animate-ult-dim pointer-events-none absolute inset-0 rounded-full bg-black"
            />
          )}
        </div>
        <span
          key={ultReady ? "ready" : "charging"}
          className={`text-[9px] font-bold uppercase tracking-widest sm:text-[10px] ${
            ultReady ? "text-amber-300" : "text-white/45"
          }`}
        >
          {ultReady ? "★ 궁극기 준비 완료 ★" : "궁극기 게이지"}
        </span>
      </div>
    </div>
  );
}
