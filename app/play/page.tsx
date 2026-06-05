"use client";

import { useEffect, useRef, useState } from "react";
import { ScoreBoard } from "@/components/ScoreBoard";
import { GameOverModal } from "@/components/GameOverModal";
import { useGameStore } from "@/store/gameStore";

export default function PlayPage() {
  const stageRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const start = useGameStore((s) => s.start);
  const end = useGameStore((s) => s.end);
  const hit = useGameStore((s) => s.hit);

  useEffect(() => {
    start();
    const el = stageRef.current;
    if (!el) return;

    let handle: { destroy: () => void } | undefined;
    let cancelled = false;

    (async () => {
      const { createGame } = await import("@/game/BossPaegiGame");
      if (cancelled) return;
      handle = await createGame(el, {
        onHit: ({ strength }) => hit(strength),
      });
    })();

    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [start, hit]);

  const handleEnd = () => {
    end();
    setOver(true);
  };

  const handleRestart = () => {
    setOver(false);
    start();
  };

  return (
    <div className="relative flex flex-1 flex-col bg-zinc-900">
      <div ref={stageRef} className="flex-1 select-none" />
      <ScoreBoard />
      <button
        onClick={handleEnd}
        className="pointer-events-auto absolute right-4 top-4 z-10 rounded-full bg-black/40 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm"
      >
        그만 패기
      </button>
      <GameOverModal open={over} onRestart={handleRestart} />
    </div>
  );
}
