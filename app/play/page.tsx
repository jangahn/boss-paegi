"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { ScoreBoard } from "@/components/ScoreBoard";
import { GameOverModal } from "@/components/GameOverModal";
import { SpeechBubble } from "@/components/SpeechBubble";
import { WeaponPicker } from "@/components/WeaponPicker";
import { useGameStore } from "@/store/gameStore";
import { createClient } from "@/lib/supabase/client";
import { randomTaunt } from "@/lib/taunts";
import { BACKGROUNDS, resolveBackground } from "@/lib/backgrounds";
import { WEAPONS, Weapon } from "@/lib/weapons";
import type { GameHandle } from "@/game/BossPaegiGame";

const TAUNT_INITIAL_DELAY_MS = 1500;
const TAUNT_VISIBLE_MS = 3000;
const TAUNT_INTERVAL_MS = 5500;

function PlayInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dollId = searchParams.get("doll");
  const bgParam = searchParams.get("bg");
  // URL 에 bg 있으면 그거 (사용자 선택 반영), 없으면 마운트 시 한 번 random pick 후 고정.
  // useState lazy init 으로 random 안 매번 바뀌게 + URL 변경 시 그건 prop 으로 반영.
  const [randomBg] = useState(() => resolveBackground(null));
  const bg = bgParam ? resolveBackground(bgParam) : randomBg;

  const stageRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameHandle | null>(null);
  const [over, setOver] = useState(false);
  const [taunt, setTaunt] = useState<string | null>(null);
  const [weapon, setWeapon] = useState<Weapon>(WEAPONS[0]);
  const start = useGameStore((s) => s.start);
  const end = useGameStore((s) => s.end);
  const hit = useGameStore((s) => s.hit);

  useEffect(() => {
    start();
    const el = stageRef.current;
    if (!el) return;

    let handle: GameHandle | undefined;
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
        weapon,
        onHit: ({ strength }) => hit(strength),
      });
      gameRef.current = handle;
    })();

    return () => {
      cancelled = true;
      handle?.destroy();
      gameRef.current = null;
    };
    // weapon 변경은 별도 effect 에서 setWeapon() 으로 hot-swap (재마운트 X)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, hit, dollId, bg.url]);

  useEffect(() => {
    gameRef.current?.setWeapon(weapon);
  }, [weapon]);

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
        className="pointer-events-auto absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm sm:right-4 sm:top-4 sm:px-4 sm:py-2 sm:text-sm"
      >
        그만 패기
      </button>
      <WeaponPicker active={weapon.key} onChange={setWeapon} />
      <BgSwitcher active={bg.key} dollId={dollId} />
      <GameOverModal
        open={over}
        onRestart={handleRestart}
        weapon={weapon.key}
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
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-1 rounded-full bg-black/50 p-1 backdrop-blur-sm sm:gap-2">
      {BACKGROUNDS.map((b) => (
        <Link
          key={b.key}
          href={href(b.key)}
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition sm:px-3 sm:py-1.5 sm:text-xs ${
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
