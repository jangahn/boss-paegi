"use client";

import { Suspense, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ScoreBoard } from "@/components/ScoreBoard";
import { GameOverModal } from "@/components/GameOverModal";
import { SpeechBubble } from "@/components/SpeechBubble";
import { Spinner } from "@/components/Spinner";
import { WeaponPicker } from "@/components/WeaponPicker";
import { UltimateButton } from "@/components/UltimateButton";
import { BgSwitcher } from "@/components/play/BgSwitcher";
import { topWeapon, useGameStore } from "@/store/gameStore";
import { setSentryGameContext } from "@/lib/sentry-context";
import { resolveBackground } from "@/lib/backgrounds";
import { WEAPONS, Weapon } from "@/lib/weapons";
import { unlockAudio } from "@/lib/sound";
import { log } from "@/lib/log";
import type { GameHandle } from "@/game/BossPaegiGame";
import { useGameInit } from "./useGameInit";
import { useTaunts } from "./useTaunts";

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

  // 게임 세션 시작 — 스토어 리셋 + 로그(Logs 검색) + Sentry 게임 컨텍스트(이후 event/replay 에 부착).
  useEffect(() => {
    start();
    log.info("game.start", {
      dollId: dollId ?? "default",
      weapon: weaponRef.current.key,
      bg: bgKeyRef.current,
    });
    setSentryGameContext({
      dollId,
      weapon: weaponRef.current.key,
      bg: bgKeyRef.current,
      gamePhase: "playing",
    });
  }, [start, dollId]);

  // Pixi 게임 인스턴스 생성/해제 (인형·배경 텍스처 로드 후 createGame, 언마운트 시 destroy).
  useGameInit({
    dollId,
    stageRef,
    gameRef,
    weaponRef,
    bgKeyRef,
    initialBgUrlRef,
    onHit: ({ strength, weapon: weaponKey, chargeUlt }) =>
      hit(strength, weaponKey, chargeUlt),
    onDrawingChange: setHasDrawing,
    setGameReady,
    setDollImageUrl,
  });

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

  const taunt = useTaunts(over);

  const handleUltimate = () => {
    const s = useGameStore.getState();
    if (!s.ultReady) return;
    log.info("game.ultimate_fire", {
      dollId: dollId ?? "default",
      weapon: weapon.key,
      score: s.score,
      combo: s.combo,
    });
    gameRef.current?.triggerUltimate();
    consumeUlt();
  };

  // 무기 전환 — 로그 + Sentry 게임 컨텍스트 갱신(이후 event/replay 에 현재 무기 부착).
  const handleWeapon = (w: Weapon) => {
    if (w.key !== weapon.key) {
      log.info("game.weapon_switch", {
        from: weapon.key,
        to: w.key,
        category: w.category,
      });
      setSentryGameContext({ dollId, weapon: w.key, bg: bgKey, gamePhase: "playing" });
    }
    setWeapon(w);
  };

  const handleBg = (key: string) => {
    if (key !== bgKey) {
      log.info("game.bg_switch", { from: bgKey, to: key });
      setSentryGameContext({ dollId, weapon: weapon.key, bg: key, gamePhase: "playing" });
    }
    setBgKey(key);
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

  const handleEnd = () => {
    // 궁극기 난타 진행 중이면 즉시 정지 (모달 뒤 점수/사운드/흔들림 잔류 방지)
    gameRef.current?.stopUltimate();
    const s = useGameStore.getState();
    // 게임 세션 종료 요약 — Logs/Discover 에서 weapon·점수대·플레이타임 분석.
    log.info("game.end", {
      dollId: dollId ?? "default",
      bg: bgKey,
      score: s.score,
      maxCombo: s.maxCombo,
      hitCount: s.hitCount,
      mainWeapon: topWeapon(s.weaponCounts),
      weaponCounts: s.weaponCounts,
      durationMs: s.startedAt ? Math.round(performance.now() - s.startedAt) : 0,
    });
    setSentryGameContext({ dollId, weapon: weapon.key, bg: bgKey, gamePhase: "over" });
    end();
    if (s.score <= 0) {
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
        onChange={handleWeapon}
        hasDrawing={hasDrawing}
        onClearDrawing={() => gameRef.current?.clearDrawing()}
      />
      <BgSwitcher active={bgKey} onChange={handleBg} />
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
