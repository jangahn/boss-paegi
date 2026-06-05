"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ScoreBoard } from "@/components/ScoreBoard";
import { GameOverModal } from "@/components/GameOverModal";
import { SpeechBubble } from "@/components/SpeechBubble";
import { useGameStore } from "@/store/gameStore";
import { createClient } from "@/lib/supabase/client";
import { randomTaunt } from "@/lib/taunts";

const DEFAULT_WEAPON = "fist";
const TAUNT_INITIAL_DELAY_MS = 1500;
const TAUNT_VISIBLE_MS = 3000;
const TAUNT_INTERVAL_MS = 5500;

function PlayInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dollId = searchParams.get("doll");
  const stageRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [taunt, setTaunt] = useState<string | null>(null);
  const start = useGameStore((s) => s.start);
  const end = useGameStore((s) => s.end);
  const hit = useGameStore((s) => s.hit);

  useEffect(() => {
    if (over) {
      setTaunt(null);
      return;
    }
    let lastTaunt = "";
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const show = () => {
      const t = randomTaunt(lastTaunt);
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

  useEffect(() => {
    start();
    const el = stageRef.current;
    if (!el) return;

    let handle: { destroy: () => void } | undefined;
    let cancelled = false;

    (async () => {
      let dollTexture;
      if (dollId) {
        const sb = createClient();
        const { data } = await sb
          .from("dolls")
          .select("image_url")
          .eq("id", dollId)
          .single();
        if (data?.image_url) {
          const { Assets } = await import("pixi.js");
          try {
            dollTexture = await Assets.load(data.image_url);
          } catch (e) {
            console.warn("[play] failed to load doll texture, falling back:", e);
          }
        }
      }
      if (cancelled) return;

      const { createGame } = await import("@/game/BossPaegiGame");
      handle = await createGame(el, {
        dollTexture,
        onHit: ({ strength }) => hit(strength),
      });
    })();

    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [start, hit, dollId]);

  const handleEnd = () => {
    const currentScore = useGameStore.getState().score;
    end();
    // 한 번도 안 패고 그냥 나간 경우 → 결과 모달 의미 없으니 홈으로
    if (currentScore <= 0) {
      router.push("/");
      return;
    }
    setOver(true);
  };

  const handleRestart = () => {
    setOver(false);
    start();
  };

  return (
    <div className="relative flex flex-1 flex-col bg-zinc-900">
      <div ref={stageRef} className="flex-1 select-none" />
      <SpeechBubble text={taunt} />
      <ScoreBoard />
      <button
        onClick={handleEnd}
        className="pointer-events-auto absolute right-4 top-4 z-10 rounded-full bg-black/40 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm"
      >
        그만 패기
      </button>
      <GameOverModal
        open={over}
        onRestart={handleRestart}
        weapon={DEFAULT_WEAPON}
        dollId={dollId}
      />
    </div>
  );
}

export default function PlayPage() {
  return (
    <Suspense fallback={null}>
      <PlayInner />
    </Suspense>
  );
}
