"use client";

import Link from "next/link";
import { useGameStore } from "@/store/gameStore";

type Props = {
  open: boolean;
  onRestart: () => void;
};

export function GameOverModal({ open, onRestart }: Props) {
  const score = useGameStore((s) => s.score);
  const maxCombo = useGameStore((s) => s.maxCombo);

  if (!open) return null;

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-black/60 px-6 backdrop-blur-sm">
      <div className="w-full max-w-sm rounded-3xl bg-zinc-900 p-8 text-center text-white shadow-2xl">
        <h2 className="text-3xl font-extrabold">시원하시죠?</h2>
        <p className="mt-2 text-sm text-zinc-400">
          오늘의 부장님 패기 결과
        </p>

        <div className="mt-6 grid grid-cols-2 gap-4">
          <div className="rounded-2xl bg-zinc-800 p-4">
            <div className="text-xs uppercase text-zinc-500">점수</div>
            <div className="mt-1 text-3xl font-extrabold tabular-nums">
              {score.toLocaleString()}
            </div>
          </div>
          <div className="rounded-2xl bg-zinc-800 p-4">
            <div className="text-xs uppercase text-zinc-500">최대 콤보</div>
            <div className="mt-1 text-3xl font-extrabold tabular-nums">
              x{maxCombo}
            </div>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3">
          <button
            onClick={onRestart}
            className="rounded-full bg-white py-3 font-semibold text-black transition hover:opacity-90"
          >
            다시 패기
          </button>
          <Link
            href="/"
            className="rounded-full border border-white/15 py-3 font-medium transition hover:bg-white/5"
          >
            홈으로
          </Link>
        </div>
      </div>
    </div>
  );
}
