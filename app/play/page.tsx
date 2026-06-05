"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ScoreBoard } from "@/components/ScoreBoard";
import { GameOverModal } from "@/components/GameOverModal";
import { SpeechBubble } from "@/components/SpeechBubble";
import { useGameStore } from "@/store/gameStore";
import { createClient } from "@/lib/supabase/client";
import { randomTaunt } from "@/lib/taunts";
import { BACKGROUNDS, resolveBackground } from "@/lib/backgrounds";

const DEFAULT_WEAPON = "fist";
const TAUNT_INITIAL_DELAY_MS = 1500;
const TAUNT_VISIBLE_MS = 3000;
const TAUNT_INTERVAL_MS = 5500;

function PlayInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dollId = searchParams.get("doll");
  const bg = resolveBackground(searchParams.get("bg"));

  const stageRef = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  const [taunt, setTaunt] = useState<string | null>(null);
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
      const { Assets } = await import("pixi.js");

      const [dollTexture, bgTexture] = await Promise.all([
        (async () => {
          if (!dollId) return undefined;
          const sb = createClient();
          const { data } = await sb
            .from("dolls")
            .select("image_url")
            .eq("id", dollId)
            .single();
          if (!data?.image_url) return undefined;
          try {
            return await Assets.load(data.image_url);
          } catch (e) {
            console.warn("[play] doll texture load failed:", e);
            return undefined;
          }
        })(),
        Assets.load(bg.url).catch((e) => {
          console.warn("[play] bg texture load failed:", e);
          return undefined;
        }),
      ]);
      if (cancelled) return;

      const { createGame } = await import("@/game/BossPaegiGame");
      handle = await createGame(el, {
        dollTexture,
        bgTexture,
        onHit: ({ strength }) => hit(strength),
      });
    })();

    return () => {
      cancelled = true;
      handle?.destroy();
    };
  }, [start, hit, dollId, bg.url]);

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

  const handleEnd = () => {
    const currentScore = useGameStore.getState().score;
    end();
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
        className="pointer-events-auto absolute right-4 top-4 z-10 rounded-full bg-black/50 px-4 py-2 text-sm font-medium text-white backdrop-blur-sm"
      >
        그만 패기
      </button>
      <BgSwitcher active={bg.key} dollId={dollId} />
      <GameOverModal
        open={over}
        onRestart={handleRestart}
        weapon={DEFAULT_WEAPON}
        dollId={dollId}
      />
    </div>
  );
}

function BgSwitcher({
  active,
  dollId,
}: {
  active: string;
  dollId: string | null;
}) {
  const href = (key: string) => {
    const sp = new URLSearchParams();
    if (dollId) sp.set("doll", dollId);
    sp.set("bg", key);
    return `/play?${sp.toString()}`;
  };

  return (
    <div className="pointer-events-auto absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 gap-2 rounded-full bg-black/50 p-1 backdrop-blur-sm">
      {BACKGROUNDS.map((b) => (
        <Link
          key={b.key}
          href={href(b.key)}
          className={`rounded-full px-3 py-1.5 text-xs font-medium transition ${
            b.key === active
              ? "bg-white text-black"
              : "text-white/80 hover:text-white"
          }`}
        >
          {b.label}
        </Link>
      ))}
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
