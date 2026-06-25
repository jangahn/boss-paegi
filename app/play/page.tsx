"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ScoreBoard } from "@/components/ScoreBoard";
import { GameOverModal } from "@/components/GameOverModal";
import { SpeechBubble } from "@/components/SpeechBubble";
import { Spinner } from "@/components/Spinner";
import { WeaponPicker } from "@/components/WeaponPicker";
import { UltimateButton } from "@/components/UltimateButton";
import { BgSwitcher } from "@/components/play/BgSwitcher";
import { BadgeChallenge } from "@/components/play/BadgeChallenge";
import { topWeapon, useGameStore } from "@/store/gameStore";
import { useSessionLimits } from "@/components/SessionLimitsProvider";
import { FORCE_END_GRACE_MS } from "@/lib/score-limits";
import { setSentryGameContext, setSentryPerfContext } from "@/lib/sentry-context";
import { resolveBackground, findBackground, randomBackground } from "@/lib/backgrounds";
import { WEAPONS, Weapon, weaponHint } from "@/lib/weapons";
import type { RoleId } from "@/lib/roles";
import { unlockAudio, isMuted, setMuted } from "@/lib/sound";
import { log } from "@/lib/log";
import type { GameHandle } from "@/game/BossPaegiGame";
import { useGameInit } from "./useGameInit";
import { useTaunts } from "./useTaunts";
import { useHighlightRecorder } from "./useHighlightRecorder";
import { useScoreTimeline } from "./useScoreTimeline";
import { useBadgeChallenge } from "./useBadgeChallenge";
import { useTelemetry } from "./useTelemetry";

function PlayInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dollId = searchParams.get("doll");
  const bgParam = searchParams.get("bg");
  // 배경은 게임 도중 자유 전환 — local state 로만 관리, 게임 재생성 X (점수/낙서 유지).
  // SSR/첫 렌더 초기값은 결정적: bg 파라미터 있으면 그 키, 없으면 BACKGROUNDS[0]("office").
  // 파라미터 없을 때의 "랜덤 1회"는 마운트 후 client effect 에서 확정한다 — render 에서 random 을
  // 쓰면 SSR/client 결과가 달라 hydration mismatch(BgSwitcher active className 등)가 난다.
  const [bgKey, setBgKey] = useState<string>(
    () => resolveBackground(bgParam).key
  );
  // 게임 생성 시점의 초기 배경 URL — 아래 "초기 배경 확정" effect 가 useGameInit 가 읽기 전에 채운다.
  // 이후 전환은 setBackground 핫스왑으로만.
  const initialBgUrlRef = useRef<string | null>(null);
  // 사용자가 BgSwitcher 로 직접 바꿨는지 — 초기 random 은 URL 에 안 쓰고(/play 깔끔 유지),
  // 사용자 전환만 ?bg= 로 동기화한다.
  const userChangedBgRef = useRef(false);
  // 플레이 중 들른 배경 key 집합 — 해석 리포트용(store 밖 상태). 종료 시 모달로 전달.
  const bgVisitsRef = useRef<Set<string>>(new Set());

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
  // 맞는 캐릭터의 롤 — useGameInit 가 doll 로드 시 setRole. 기본 플레이(doll 없음)=boss.
  const [role, setRole] = useState<RoleId>("boss");
  // 궁극기 게이지 풀 충전 여부 — 발동 버튼 노출
  const [ultReady, setUltReady] = useState(false);
  const [over, setOver] = useState(false);
  // 사운드 음소거 토글 — 저장값(localStorage)으로 초기화, master gain 0/1
  const [soundMuted, setSoundMuted] = useState(false);
  // SSR/hydration 안전: 서버·첫 렌더는 false(🔊), 마운트 후 저장값 반영(불일치 방지 — effect 의도적)
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setSoundMuted(isMuted()), []);
  const toggleSound = useCallback(() => {
    setSoundMuted((m) => {
      setMuted(!m);
      return !m;
    });
  }, []);
  // 강제 종료 — 마케터 한도(시간/점수) 도달 시. 한도는 게임 시작 시점 값으로 동결(ref).
  const sessionLimits = useSessionLimits();
  const limitsRef = useRef(sessionLimits);
  const forceEndRef = useRef(false); // one-shot: 한도 트리거 1회만
  const endingRef = useRef(false); // handleEnd 1회만(중복 제출/모달 방지)
  const graceTimerRef = useRef<number | null>(null); // grace setTimeout id — 재시작/언마운트 시 정리
  const [forcedBanner, setForcedBanner] = useState<string | null>(null);
  const [endReason, setEndReason] = useState<"normal" | "time_limit" | "score_limit">(
    "normal"
  );
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
  const telemetry = useTelemetry();
  const telemetryStartedRef = useRef(false); // StrictMode 더블 effect 가드(세션 1회만)

  // 초기 배경 확정 — 마운트 후 1회. SSR/첫 렌더는 결정적("office" or 유효 ?bg=)이라 hydration 일치하고,
  // 실제 초기 배경은 여기서 정한다: 유효한 bg 파라미터면 그 배경, 없거나 무효면 client random.
  // 반드시 게임 생성(useGameInit)·세션 start 로그보다 먼저 선언돼 initialBgUrlRef/bgKeyRef 를
  // 먼저 채워야 첫 배경 텍스처와 game.start 로그의 bg 가 실제 배경과 일치한다.
  const bgDecidedRef = useRef(false);
  useEffect(() => {
    if (bgDecidedRef.current) return; // StrictMode 더블 effect 가드 — random 은 1회만 고정
    bgDecidedRef.current = true;
    const picked = findBackground(bgParam) ?? randomBackground();
    initialBgUrlRef.current = picked.url;
    bgKeyRef.current = picked.key;
    bgVisitsRef.current.add(picked.key);
    setBgKey(picked.key); // 파라미터와 동일하면 React 가 bail-out (no-op)
  }, [bgParam]);

  // 게임 세션 시작 — 스토어 리셋 + 로그(Logs 검색) + Sentry 게임 컨텍스트(이후 event/replay 에 부착).
  useEffect(() => {
    start();
    if (!telemetryStartedRef.current) {
      telemetryStartedRef.current = true;
      telemetry.startSession(bgKeyRef.current, weaponRef.current.key);
      // 이탈(abandon/visibility) 종료도 perf 캡처되게 게임 perf 소스 등록(closure 라 gameRef 지연 읽기·재시작 무관).
      telemetry.registerPerfSource(() => gameRef.current?.getPerfStats() ?? null);
    }
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
  }, [start, dollId, telemetry]);

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
    setDollRole: setRole,
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

  const taunt = useTaunts(over, role);

  // 점수 timeline 샘플링 — 녹화 지원 무관 항상(카드-only 하이라이트 계산용).
  const { getTimelineHighlight } = useScoreTimeline({
    recording: gameReady && !over,
  });
  // 점수 급상승 구간 하이라이트 녹화 (되는 기기만 — 미지원이면 카드 공유로 자동 강등).
  const { bestClip, finalize: finalizeHighlight } = useHighlightRecorder({
    gameRef,
    recording: gameReady && !over,
  });
  // 플레이 중 "기록 중" 마일스톤 토스트 (이탈 방지 — store.subscribe 기반)
  // 뱃지 도전 라이브 체크리스트 + 획득 토스트(단일 소스 lib/badges 구동).
  // bgVisits 는 store 밖 ref → 안정 getter 로 전달(맵 패밀리 진행도 반영).
  const getBgVisits = useCallback(() => Array.from(bgVisitsRef.current), []);
  const { slots, toasts } = useBadgeChallenge({
    recording: gameReady && !over,
    getBgVisits,
  });

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
    telemetry.onUltFire(s.score);
    consumeUlt();
  };

  // 무기 전환 — 로그 + Sentry 게임 컨텍스트 갱신(이후 event/replay 에 현재 무기 부착).
  const handleWeapon = (w: Weapon) => {
    telemetry.onWeaponSelect(weapon.key, w.key);
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
    telemetry.onMapSelect(bgKey, key);
    if (key !== bgKey) {
      userChangedBgRef.current = true; // 이후 핫스왑이 ?bg= 를 URL 에 동기화
      bgVisitsRef.current.add(key);
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
    // URL 동기화 (공유용) 는 사용자가 직접 바꾼 경우만 — navigation 없이 replaceState 로만.
    // 초기 random 전환(office→random)은 URL 에 안 써서 /play 를 깔끔히 유지(현행 UX 보존).
    if (userChangedBgRef.current) {
      const sp = new URLSearchParams();
      if (dollId) sp.set("doll", dollId);
      sp.set("bg", bgKey);
      window.history.replaceState(null, "", `/play?${sp.toString()}`);
    }
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

  const handleEnd = useCallback(
    async (reason: "normal" | "time_limit" | "score_limit" = "normal") => {
      if (endingRef.current) return; // 강제종료 grace 중 수동 종료 등 중복 차단(one-shot)
      endingRef.current = true;
      setEndReason(reason);
      // 궁극기 난타 진행 중이면 즉시 정지 (모달 뒤 점수/사운드/흔들림 잔류 방지)
      gameRef.current?.stopUltimate();
      const s = useGameStore.getState();
      // 게임 세션 종료 요약 — Logs/Discover 에서 weapon·점수대·플레이타임 분석.
      log.info("game.end", {
        dollId: dollId ?? "default",
        bg: bgKeyRef.current,
        score: s.score,
        maxCombo: s.maxCombo,
        hitCount: s.hitCount,
        mainWeapon: topWeapon(s.weaponCounts),
        weaponCounts: s.weaponCounts,
        durationMs: s.startedAt ? Math.round(performance.now() - s.startedAt) : 0,
        endReason: reason,
      });
      setSentryGameContext({
        dollId,
        weapon: weaponRef.current.key,
        bg: bgKeyRef.current,
        gamePhase: "over",
      });
      end();
      // 렉 진단 perf(프레임타임/DPR) — 텔레메트리 저장 + Sentry context(보조)
      const perf = gameRef.current?.getPerfStats();
      if (perf) {
        telemetry.setPerf(perf);
        setSentryPerfContext(perf);
      }
      telemetry.endSession(reason);
      if (s.score <= 0) {
        router.push("/");
        return;
      }
      // 진행 중 녹화가 있으면 마감해서 마지막 클라이맥스 클립이 버려지지 않게 한 뒤 모달 오픈.
      await finalizeHighlight();
      setOver(true);
    },
    [dollId, end, finalizeHighlight, router, telemetry]
  );

  // 최신 handleEnd 를 ref 로 — 폴링 인터벌이 handleEnd 재생성에 재구독되지 않게(인터벌 리셋 방지).
  const handleEndRef = useRef(handleEnd);
  useEffect(() => {
    handleEndRef.current = handleEnd;
  }, [handleEnd]);

  // 강제 종료 폴링 — gameReady·!over 동안 0.5s 마다 한도 체크. 도달 시 배너 → grace 후 1회 종료.
  useEffect(() => {
    if (!gameReady || over) return;
    const limits = limitsRef.current;
    const id = window.setInterval(() => {
      if (forceEndRef.current) return;
      const s = useGameStore.getState();
      if (!s.isPlaying || !s.startedAt) return;
      const elapsed = (performance.now() - s.startedAt) / 1000;
      const reason =
        s.score >= limits.maxScore
          ? "score_limit"
          : elapsed >= limits.maxPlaySeconds
            ? "time_limit"
            : null;
      if (reason) {
        forceEndRef.current = true;
        setForcedBanner(reason === "time_limit" ? "시간 종료!" : "최고 점수 달성!");
        // grace — 진행 중 궁극기 마무리 여유. 이후 1회 종료(final 소폭 초과는 hard cap 내라 제출 OK).
        // 타이머 id 보관 → grace 중 수동종료+재시작 시 새 판을 강제종료하는 orphan timeout 방지.
        graceTimerRef.current = window.setTimeout(
          () => void handleEndRef.current(reason),
          FORCE_END_GRACE_MS
        );
      }
    }, 500);
    return () => {
      window.clearInterval(id);
      if (graceTimerRef.current) window.clearTimeout(graceTimerRef.current);
    };
  }, [gameReady, over]);

  const handleRestart = () => {
    setOver(false);
    setForcedBanner(null);
    setEndReason("normal");
    forceEndRef.current = false;
    endingRef.current = false;
    if (graceTimerRef.current) {
      window.clearTimeout(graceTimerRef.current); // orphan grace timeout 차단(D1)
      graceTimerRef.current = null;
    }
    bgVisitsRef.current = new Set([bgKeyRef.current]); // 새 세션 — 현재 배경만
    start();
    telemetry.startSession(bgKeyRef.current, weaponRef.current.key);
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
          <p className="text-sm text-white/70">캐릭터 불러오는 중...</p>
        </div>
      )}
      <SpeechBubble text={taunt} />
      <ScoreBoard />
      {gameReady && !over && <BadgeChallenge slots={slots} />}
      {gameReady && !over && toasts.length > 0 && (
        <div className="pointer-events-none absolute left-1/2 top-1/4 z-20 flex -translate-x-1/2 flex-col items-center gap-1.5">
          {toasts.map((t) => (
            <div
              key={t.id}
              className="animate-milestone whitespace-nowrap rounded-full bg-amber-400/95 px-3 py-1 text-xs font-bold text-zinc-900 shadow-lg"
            >
              🏅 {t.text}
            </div>
          ))}
        </div>
      )}
      <div className="pointer-events-auto absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 flex items-center gap-2 sm:right-4 sm:top-4">
        <button
          type="button"
          onClick={toggleSound}
          aria-label={soundMuted ? "소리 켜기" : "소리 끄기"}
          className="rounded-full bg-black/50 px-2.5 py-1.5 text-sm text-white backdrop-blur-sm sm:px-3 sm:py-2"
        >
          {soundMuted ? "🔇" : "🔊"}
        </button>
        <button
          onClick={() => void handleEnd()}
          className="rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm sm:px-4 sm:py-2 sm:text-sm"
        >
          그만 패기
        </button>
      </div>
      {/* 강제 종료 배너 — 한도 도달 시 grace 동안 노출 후 결과 모달로 전환 */}
      {forcedBanner && !over && (
        <div className="pointer-events-none absolute inset-x-0 top-1/3 z-30 flex justify-center">
          <div className="animate-milestone rounded-2xl bg-black/80 px-6 py-4 text-center shadow-2xl backdrop-blur">
            <p className="text-2xl font-extrabold text-amber-400">{forcedBanner}</p>
            <p className="mt-1 text-xs text-white/80">결과를 정리하고 있어요…</p>
          </div>
        </div>
      )}
      {/* 무기 조작 안내 — picker 바로 위. 반투명 캡슐로 배경 무관 가독 */}
      <div className="pointer-events-none absolute bottom-[5.75rem] left-1/2 z-10 -translate-x-1/2 sm:bottom-28">
        <span className="whitespace-nowrap rounded-full bg-black/55 px-3 py-1 text-xs font-medium text-white/90 backdrop-blur-sm sm:text-sm">
          {weaponHint(weapon.key, role)}
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
        role={role}
        dollImageUrl={dollImageUrl}
        highlightClip={bestClip}
        getCardHighlight={getTimelineHighlight}
        bgVisits={Array.from(bgVisitsRef.current)}
        endReason={endReason}
        telemetrySessionId={telemetry.getSessionId()}
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
