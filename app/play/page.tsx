"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ScoreBoard } from "@/components/ScoreBoard";
import { GameOverModal } from "@/components/GameOverModal";
import { SpeechBubble } from "@/components/SpeechBubble";
import { Spinner } from "@/components/Spinner";
import { WeaponPicker } from "@/components/WeaponPicker";
import { UltimateButton } from "@/components/UltimateButton";
import { useGameStore } from "@/store/gameStore";
import { createClient } from "@/lib/supabase/client";
import { randomTaunt } from "@/lib/taunts";
import { BACKGROUNDS, resolveBackground } from "@/lib/backgrounds";
import { WEAPONS, Weapon } from "@/lib/weapons";
import { unlockAudio } from "@/lib/sound";
import type { GameHandle } from "@/game/BossPaegiGame";

const TAUNT_INITIAL_DELAY_MS = 1500;
const TAUNT_VISIBLE_MS = 3000;
const TAUNT_INTERVAL_MS = 5500;

function PlayInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dollId = searchParams.get("doll");
  const bgParam = searchParams.get("bg");
  // 배경은 게임 도중 자유 전환 — local state 로만 관리, 게임 재생성 X (점수/낙서 유지).
  // 초기값: URL 의 bg, 없으면 random 1회.
  const [bgKey, setBgKey] = useState<string>(
    () => resolveBackground(bgParam).key
  );
  // 게임 생성 시점의 초기 배경 — 이후 전환은 setBackground 핫스왑으로만.
  const initialBgUrlRef = useRef<string | null>(null);
  if (initialBgUrlRef.current === null) {
    initialBgUrlRef.current = resolveBackground(bgKey).url;
  }

  const stageRef = useRef<HTMLDivElement>(null);
  const gameRef = useRef<GameHandle | null>(null);
  // 인형/배경 fetch + 게임 init 동안 로딩 오버레이
  const [gameReady, setGameReady] = useState(false);
  // 낙서 존재 여부 — picker 의 펜 슬롯이 지우개(🧽)로 토글
  const [hasDrawing, setHasDrawing] = useState(false);
  // 결과 보고서에 표시할 인형 이미지 (커스텀 or 기본)
  const [dollImageUrl, setDollImageUrl] = useState<string>(
    "/sprites/boss-default.png"
  );
  // 궁극기 게이지 풀 충전 여부 — 발동 버튼 노출
  const [ultReady, setUltReady] = useState(false);
  const [over, setOver] = useState(false);
  const [taunt, setTaunt] = useState<string | null>(null);
  const [weapon, setWeapon] = useState<Weapon>(WEAPONS[0]);
  // 게임 생성(비동기) 중 바뀐 무기/배경을 생성 완료 시점에 재적용하기 위한 미러
  const weaponRef = useRef(weapon);
  weaponRef.current = weapon;
  const bgKeyRef = useRef(bgKey);
  bgKeyRef.current = bgKey;
  const start = useGameStore((s) => s.start);
  const end = useGameStore((s) => s.end);
  const hit = useGameStore((s) => s.hit);
  const consumeUlt = useGameStore((s) => s.consumeUlt);

  useEffect(() => {
    start();
    const el = stageRef.current;
    if (!el) return;

    let cancelled = false;
    let myHandle: GameHandle | undefined;

    (async () => {
      const { Assets } = await import("pixi.js");

      const [dollTexture, bgTexture] = await Promise.all([
        (async () => {
          // dollId 없으면 기본 부장님 이미지 — 실패 시 undefined (Graphics placeholder fallback)
          if (!dollId) {
            try {
              return await Assets.load("/sprites/boss-default.png");
            } catch (e) {
              console.warn("[play] default boss texture load failed:", e);
              return undefined;
            }
          }
          const sb = createClient();
          const { data } = await sb
            .from("dolls")
            .select("image_url")
            .eq("id", dollId)
            .single();
          if (!data?.image_url) return undefined;
          setDollImageUrl(data.image_url);
          try {
            return await Assets.load(data.image_url);
          } catch (e) {
            console.warn("[play] doll texture load failed:", e);
            return undefined;
          }
        })(),
        Assets.load(initialBgUrlRef.current!).catch((e) => {
          console.warn("[play] bg texture load failed:", e);
          return undefined;
        }),
      ]);
      if (cancelled) return;

      const { createGame } = await import("@/game/BossPaegiGame");
      if (cancelled) return;
      const created = await createGame(
        el,
        {
          dollTexture,
          bgTexture,
          weapon,
          onHit: ({ strength, weapon: weaponKey, chargeUlt }) =>
            hit(strength, weaponKey, chargeUlt),
          onDrawingChange: setHasDrawing,
        },
        () => cancelled
      );
      // 취소된 호출은 createGame 이 DOM 안 건드리고 null 반환 (자가 정리)
      if (!created) return;
      // race 안전망: createGame 반환 직후 cleanup 됐다면 즉시 destroy
      if (cancelled) {
        created.destroy();
        return;
      }
      myHandle = created;
      gameRef.current = created;
      setGameReady(true);

      // 생성하는 동안 사용자가 바꾼 무기/배경 재적용 (로딩 중 변경은
      // gameRef 가 null 이라 hot-swap effect 에서 조용히 유실됨)
      created.setWeapon(weaponRef.current);
      const latestBg = resolveBackground(bgKeyRef.current);
      if (latestBg.url !== initialBgUrlRef.current) {
        Assets.load(latestBg.url)
          .then((tex) => {
            if (!cancelled && tex && gameRef.current === created) {
              created.setBackground(tex);
            }
          })
          .catch(() => {});
      }
    })();

    return () => {
      cancelled = true;
      if (myHandle) {
        myHandle.destroy();
        if (gameRef.current === myHandle) gameRef.current = null;
      }
    };
    // weapon/bg 변경은 별도 effect 에서 hot-swap (재마운트 X)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start, hit, dollId]);

  useEffect(() => {
    gameRef.current?.setWeapon(weapon);
  }, [weapon]);

  // 점수 → 꼬질꼬질 데칼 + 궁극기 게이지 상태 (zustand subscribe)
  useEffect(() => {
    return useGameStore.subscribe((s) => {
      gameRef.current?.setDamageScore(s.score);
      setUltReady(s.ultReady);
    });
  }, []);

  const handleUltimate = () => {
    if (!useGameStore.getState().ultReady) return;
    gameRef.current?.triggerUltimate();
    consumeUlt();
  };

  // 배경 전환 — 텍스처만 핫스왑. 게임 상태 (점수/낙서/무기) 그대로.
  // run-once boolean 가드는 StrictMode 더블 effect 에서 깨지므로
  // "마지막으로 적용한 키" 비교로 idempotent 하게.
  const appliedBgKeyRef = useRef(bgKey);
  useEffect(() => {
    if (appliedBgKeyRef.current === bgKey) return; // 초기 배경은 게임 생성 시 적용됨
    appliedBgKeyRef.current = bgKey;
    const b = resolveBackground(bgKey);
    let cancelled = false;
    (async () => {
      const { Assets } = await import("pixi.js");
      const tex = await Assets.load(b.url).catch(() => undefined);
      if (!cancelled && tex) gameRef.current?.setBackground(tex);
    })();
    // URL 도 동기화 (공유용) — navigation 없이 replaceState 로만
    const sp = new URLSearchParams();
    if (dollId) sp.set("doll", dollId);
    sp.set("bg", bgKey);
    window.history.replaceState(null, "", `/play?${sp.toString()}`);
    return () => {
      cancelled = true;
    };
  }, [bgKey, dollId]);

  // 페이지 진입 후 첫 user gesture 시 AudioContext unlock (iOS Safari autoplay 우회).
  useEffect(() => {
    const onFirst = () => {
      unlockAudio();
    };
    window.addEventListener("pointerdown", onFirst, { once: false });
    window.addEventListener("touchstart", onFirst, {
      once: false,
      passive: true,
    });
    return () => {
      window.removeEventListener("pointerdown", onFirst);
      window.removeEventListener("touchstart", onFirst);
    };
  }, []);

  useEffect(() => {
    if (over) {
      setTaunt(null);
      return;
    }
    let lastTaunt = "";
    let hideTimer: ReturnType<typeof setTimeout> | undefined;

    const show = () => {
      // 현재 점수대에 맞는 톤의 시비 멘트 (초반 무시 → 후반 굴복)
      const t = randomTaunt(lastTaunt, useGameStore.getState().score);
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
    // 궁극기 난타 진행 중이면 즉시 정지 (모달 뒤 점수/사운드/흔들림 잔류 방지)
    gameRef.current?.stopUltimate();
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
    <div
      className="game-surface relative flex flex-1 flex-col bg-zinc-900"
      onContextMenu={(e) => e.preventDefault()}
    >
      <div ref={stageRef} className="flex-1 select-none" />
      {!gameReady && (
        <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-zinc-900/80">
          <Spinner className="h-8 w-8 text-white/80" />
          <p className="text-sm text-white/70">부장님 불러오는 중...</p>
        </div>
      )}
      <SpeechBubble text={taunt} />
      <ScoreBoard />
      <button
        onClick={handleEnd}
        className="pointer-events-auto absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm sm:right-4 sm:top-4 sm:px-4 sm:py-2 sm:text-sm"
      >
        그만 패기
      </button>
      {/* 무기 조작 안내 — picker 바로 위. 반투명 캡슐로 배경 무관 가독 */}
      <div className="pointer-events-none absolute bottom-[5.75rem] left-1/2 z-10 -translate-x-1/2 sm:bottom-28">
        <span className="whitespace-nowrap rounded-full bg-black/55 px-3 py-1 text-xs font-medium text-white/90 backdrop-blur-sm sm:text-sm">
          {weapon.hint}
        </span>
      </div>
      <UltimateButton ready={ultReady} onFire={handleUltimate} />
      <WeaponPicker
        active={weapon.key}
        onChange={setWeapon}
        hasDrawing={hasDrawing}
        onClearDrawing={() => gameRef.current?.clearDrawing()}
      />
      <BgSwitcher active={bgKey} onChange={setBgKey} />
      <GameOverModal
        open={over}
        onRestart={handleRestart}
        weapon={weapon.key}
        dollId={dollId}
        dollImageUrl={dollImageUrl}
      />
    </div>
  );
}

function BgSwitcher({
  active,
  onChange,
}: {
  active: string;
  onChange: (key: string) => void;
}) {
  return (
    <div className="pointer-events-auto absolute bottom-3 left-1/2 z-10 flex -translate-x-1/2 gap-1 rounded-full bg-black/50 p-1 backdrop-blur-sm sm:gap-2">
      {BACKGROUNDS.map((b) => (
        <button
          key={b.key}
          onClick={() => onChange(b.key)}
          className={`whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-medium transition sm:px-3 sm:py-1.5 sm:text-xs ${
            b.key === active
              ? "bg-white text-black"
              : "text-white/80 hover:text-white"
          }`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

function PlayKeyed() {
  // dollId 가 바뀌면 PlayInner 를 완전 remount — useState/timer/effect 모두 깔끔 리셋.
  const sp = useSearchParams();
  return <PlayInner key={sp.get("doll") ?? "_default"} />;
}

export default function PlayPage() {
  return (
    <Suspense fallback={null}>
      <PlayKeyed />
    </Suspense>
  );
}
