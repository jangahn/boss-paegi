"use client";

import { Suspense, useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ScoreBoard } from "@/components/ScoreBoard";
import { GameOverModal } from "@/components/GameOverModal";
import { SpeechBubble } from "@/components/SpeechBubble";
import { Spinner } from "@/components/Spinner";
import { WeaponPicker, isEraserSlot } from "@/components/WeaponPicker";
import { UltimateButton } from "@/components/UltimateButton";
import { BgSwitcher } from "@/components/play/BgSwitcher";
import { BadgeChallenge } from "@/components/play/BadgeChallenge";
import { TimeLimitHud } from "@/components/play/TimeLimitHud";
import { topWeapon, useGameStore } from "@/store/gameStore";
import { useSessionLimits } from "@/components/SessionLimitsProvider";
import { FORCE_END_GRACE_MS } from "@/lib/score-limits";
import { setSentryGameContext, setSentryPerfContext } from "@/lib/sentry-context";
import { BACKGROUNDS, resolveBackground, findBackground, randomBackground } from "@/lib/backgrounds";
import { WEAPONS, Weapon, weaponHint, weaponsForMap, remapWeaponForMap } from "@/lib/weapons";
import { juggleConfigFromSeconds } from "@/lib/game-tuning";
import { keyboardHint } from "@/lib/keyboard-controls";
import { useScoreConfig } from "@/components/ScoreConfigProvider";
import type { RoleId } from "@/lib/roles";
import { DEFAULT_GENDER, type Gender } from "@/lib/gender";
import { unlockAudio, isMuted, setMuted, playTimerCue } from "@/lib/sound";
import { grantedBonusMs, timeLimitConfigFromSeconds } from "@/lib/time-limit";
import { log, errInfo } from "@/lib/log";
import type { GameHandle } from "@/game/BossPaegiGame";
import { useGameInit } from "./useGameInit";
import { useTaunts } from "./useTaunts";
import { useHighlightRecorder } from "./useHighlightRecorder";
import { useScoreTimeline } from "./useScoreTimeline";
import { useBadgeChallenge } from "./useBadgeChallenge";
import { useTelemetry } from "./useTelemetry";
import { useKeyboardControls } from "./useKeyboardControls";
import { activeGameElapsedMs } from "@/lib/game-clock";
import { loadClientAssetWithDeadline } from "@/lib/client-asset-load";
import { baseDollKeyFromParam, telemetryBaseDollLabel, type BaseDollKey } from "@/lib/base-dolls";
import { resetPendingPlayDoll } from "@/lib/view-transition";
import { PlayDollPreview } from "@/components/play/PlayDollPreview";
import { PAGE_LOADING_PROPS } from "@/lib/page-loading";

/** 시간 종료 배너 노출(ms) — 입력이 닫힌 뒤 「시간 종료!」를 보여 주고 종료 화면을 연다. */
const TIME_UP_BANNER_MS = 1200;

function PlayInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const dollParam = searchParams.get("doll");
  // 기본 캐릭터 키(boss-m·ceo-m·…)면 정적 스프라이트 플레이(비회원 링크 가능), 그 외(uuid)는 커스텀 캐릭터.
  const baseDollKey = baseDollKeyFromParam(dollParam);
  const dollId = baseDollKey ? null : dollParam;
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
  // 캐릭터/배경 fetch + 게임 init 동안 로딩 오버레이
  const [gameReady, setGameReady] = useState(false);
  const [gameInitError, setGameInitError] = useState<string | null>(null);
  const [gameInitAttempt, setGameInitAttempt] = useState(0);
  // 낙서 존재 여부 — picker 의 펜 슬롯이 지우개(🧽)로 토글
  const [hasDrawing, setHasDrawing] = useState(false);
  // 마우스를 올린 무기(PC) — 안내 캡슐이 그 무기의 키보드 조작법으로 바뀐다
  const [hoverWeapon, setHoverWeapon] = useState<Weapon | null>(null);
  // 결과 보고서에 표시할 캐릭터 이미지 (커스텀 or 기본)
  const [dollImageUrl, setDollImageUrl] = useState<string>(
    "/sprites/boss-default.png"
  );
  // 맞는 캐릭터의 롤·성별 — useGameInit 가 doll 로드 시 set. 기본 플레이(doll 없음)=boss·male.
  const [role, setRole] = useState<RoleId>("boss");
  const [gender, setGender] = useState<Gender>(DEFAULT_GENDER);
  // 궁극기 게이지 풀 충전 여부 — 발동 버튼 노출
  const [ultReady, setUltReady] = useState(false);
  const [over, setOver] = useState(false);
  // 누른 캐릭터(로딩 막 이어짐)는 게임 화면이 뜨면 비운다 — 다음 이동에 남지 않게(v1.65, lib/view-transition.ts).
  useEffect(() => resetPendingPlayDoll(), []);
  // 결과 화면 동안 게임 그리기를 멈춘다(v1.65) — 흐림 배경 뒤 WebGL 이 결과 연출을 끊지 않게. 다시 패기(over=false)에서 재개.
  useEffect(() => {
    gameRef.current?.setRendering(!over);
  }, [over]);
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
  // 제한 시간(v1.53) — 시간 종료 1회 가드, 진행 중 궁극기 마무리 대기 타이머, 마지막 10초(말풍선 쉼).
  const timeUpRef = useRef(false);
  const ultWaitRef = useRef<number | null>(null);
  const [countdownActive, setCountdownActive] = useState(false);
  // 시간 종료 뒤(배너·궁극기 마무리 동안)에도 말풍선은 쉰다 — 「시간 종료!」 배너와 겹치지 않게.
  const [timeUp, setTimeUp] = useState(false);
  const [endReason, setEndReason] = useState<"normal" | "time_limit" | "score_limit">(
    "normal"
  );
  const [weapon, setWeapon] = useState<Weapon>(WEAPONS[0]);
  // 맵별 투척 로스터(v1.35) — 공통 7종 + 현재 맵의 투척 2종(피커 9칸, 순서 불변).
  const roster = useMemo(() => weaponsForMap(bgKey), [bgKey]);
  // 게임 생성(비동기) 중 바뀐 무기/배경을 생성 완료 시점에 재적용하기 위한 미러(latest-ref).
  // 렌더 중 동기 갱신은 **의도적** — 아래 세션시작(120·127)·bg확정(110)·game-init effect 보다 먼저,
  // 렌더 시점에 최신값이어야 한다("먼저 채워야" 불변식, :103). effect 로 미루면 순서가 깨져 규칙을 국소 해제.
  const weaponRef = useRef(weapon);
  // eslint-disable-next-line react-hooks/refs
  weaponRef.current = weapon;
  const bgKeyRef = useRef(bgKey);
  // eslint-disable-next-line react-hooks/refs
  bgKeyRef.current = bgKey;
  // 선택 중인 키와 실제 Pixi 적용 완료 키를 분리한다. 비동기 로드가
  // 실패해도 UI·URL·텔레메트리가 거짓 전환 상태로 남지 않는다.
  const appliedBgKeyRef = useRef(bgKey);
  const [bgSwitchError, setBgSwitchError] = useState<string | null>(null);
  const start = useGameStore((s) => s.start);
  const configureJuggle = useGameStore((s) => s.configureJuggle);
  const configureTimeLimit = useGameStore((s) => s.configureTimeLimit);
  const setClockPaused = useGameStore((s) => s.setClockPaused);
  const clockStarted = useGameStore((s) => s.clockStarted);
  const baseSeconds = useGameStore((s) => Math.round(s.timeLimit.baseMs / 1000));
  // 이번 궁극기로 받을 추가 시간(초) — 최대 플레이 시간에 막히면 0(버튼 칩 숨김).
  const ultBonusSeconds = useGameStore((s) =>
    Math.round(grantedBonusMs(s.timeBudgetMs, s.timeLimit.ultimateBonusMs, s.timeLimit.maxPlayMs) / 1000),
  );
  const noteMap = useGameStore((s) => s.noteMap);
  const scoreCfg = useScoreConfig(); // 변경 보너스·콤보 창 초수(라이브) — 게임 시작 시 한 판 값으로 고정
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
    configureJuggle(juggleConfigFromSeconds(scoreCfg.juggle));
    configureTimeLimit(timeLimitConfigFromSeconds(limitsRef.current.timeLimit));
    start();
    noteMap(bgKeyRef.current); // 맵변경 배율의 시작 맵 체류 기록
    if (!telemetryStartedRef.current) {
      telemetryStartedRef.current = true;
      telemetry.startSession(bgKeyRef.current, weaponRef.current.key);
      // 이탈(abandon/visibility) 종료도 perf 캡처되게 게임 perf 소스 등록(closure 라 gameRef 지연 읽기·재시작 무관).
      telemetry.registerPerfSource(() => gameRef.current?.getPerfStats() ?? null);
    }
    log.info("game.start", {
      dollId: dollId ?? telemetryBaseDollLabel(baseDollKey),
      weapon: weaponRef.current.key,
      bg: bgKeyRef.current,
    });
    setSentryGameContext({
      dollId,
      weapon: weaponRef.current.key,
      bg: bgKeyRef.current,
      gamePhase: "playing",
    });
  }, [start, configureJuggle, configureTimeLimit, noteMap, scoreCfg, dollId, baseDollKey, telemetry]);

  // Pixi 게임 인스턴스 생성/해제 (캐릭터·배경 텍스처 로드 후 createGame, 언마운트 시 destroy).
  useGameInit({
    dollId,
    baseDollKey,
    initAttempt: gameInitAttempt,
    stageRef,
    gameRef,
    weaponRef,
    bgKeyRef,
    initialBgUrlRef,
    onHit: ({ strength, weapon: weaponKey, chargeUlt }) =>
      hit(strength, weaponKey, chargeUlt),
    onDrawingChange: setHasDrawing,
    onKeyAction: telemetry.onKeyAction,
    onPausedChange: setClockPaused,
    setGameReady,
    setGameInitError,
    setDollImageUrl,
    setDollRole: (r, g) => {
      setRole(r);
      setGender(g);
    },
    onInitialBackgroundReady: (key) => {
      appliedBgKeyRef.current = key;
    },
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

  const taunt = useTaunts(over, role, gender);

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
  const { slots, toasts, loadError: badgeLoadError, playTotals } = useBadgeChallenge({
    recording: gameReady && !over,
    getBgVisits,
  });

  const handleUltimate = () => {
    const s = useGameStore.getState();
    // 시간 종료 뒤(진행 중 궁극기 마무리 대기 포함)엔 새 궁극기를 받지 않는다 — 추가 시간으로 되살리지 않음.
    if (!s.ultReady || !s.isPlaying || timeUpRef.current) return;
    log.info("game.ultimate_fire", {
      dollId: dollId ?? telemetryBaseDollLabel(baseDollKey),
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
    if (key !== bgKey) {
      userChangedBgRef.current = true; // 이후 핫스왑이 ?bg= 를 URL 에 동기화
      setBgSwitchError(null);
      bgKeyRef.current = key;
      // 실제 전환 확정(로그·텔레메트리·방문맵·URL)은 로드 성공 effect에서만.
    }
    setBgKey(key);
  };

  // PC 키보드(v1.50) — 숫자키 = 그 칸 클릭(지우개 규칙 포함), Q~Y = 맵, 스페이스·방향키 = 공격(스페이스는 궁극기 우선).
  useKeyboardControls({
    enabled: gameReady && !over,
    gameRef,
    onWeaponSlot: (slot) => {
      const w = roster[slot];
      if (!w) return;
      if (isEraserSlot(w, hasDrawing)) gameRef.current?.clearDrawing();
      else handleWeapon(w);
    },
    onMap: (index) => {
      const b = BACKGROUNDS[index];
      if (b) handleBg(b.key);
    },
    onUltimate: handleUltimate,
    onUltimateKey: telemetry.onKeyAction,
  });

  // 배경 전환 — 텍스처만 핫스왑. 게임 상태 (점수/낙서/무기) 그대로.
  // run-once boolean 가드는 StrictMode 더블 effect 에서 깨지므로
  // "마지막으로 적용한 키" 비교로 idempotent 하게.
  useEffect(() => {
    if (!gameReady) return;
    if (appliedBgKeyRef.current === bgKey) return; // 초기 배경은 게임 생성 시 적용됨
    const previousKey = appliedBgKeyRef.current;
    const b = resolveBackground(bgKey);
    let cancelled = false;
    const controller = new AbortController();
    (async () => {
      const { Assets } = await import("pixi.js");
      const tex = await loadClientAssetWithDeadline(
        () => Assets.load(b.url),
        { signal: controller.signal },
      );
      if (cancelled) return;
      const game = gameRef.current;
      if (!game) throw new Error("game_handle_missing");
      game.setBackground(tex);
      appliedBgKeyRef.current = bgKey;
      setBgSwitchError(null);
      // 맵별 투척 로스터(v1.35): 다른 맵의 투척 무기를 들고 있었으면 새 맵의 같은 칸(경↔경·중↔중)으로 자동 교체.
      const held = weaponRef.current;
      const remapped = remapWeaponForMap(held, bgKey);
      if (remapped.key !== held.key) {
        const next = remapped;
        telemetry.onWeaponSelect(held.key, next.key);
        log.info("game.weapon_switch", { from: held.key, to: next.key, category: next.category, reason: "map" });
        setWeapon(next);
      }
      if (userChangedBgRef.current) {
        telemetry.onMapSelect(previousKey, bgKey);
        bgVisitsRef.current.add(bgKey);
        useGameStore.getState().noteMap(bgKey); // 맵변경 배율 창 기록
        log.info("game.bg_switch", { from: previousKey, to: bgKey });
        setSentryGameContext({
          dollId,
          weapon: weaponRef.current.key,
          bg: bgKey,
          gamePhase: "playing",
        });
        const sp = new URLSearchParams();
        if (dollParam) sp.set("doll", dollParam);
        sp.set("bg", bgKey);
        window.history.replaceState(null, "", `/play?${sp.toString()}`);
      }
    })().catch((error) => {
      if (cancelled) return;
      log.error("play.bg_texture_fail", {
        from: previousKey,
        to: bgKey,
        ...errInfo(error),
      });
      bgKeyRef.current = previousKey;
      setBgKey(previousKey);
      setBgSwitchError(
        "배경을 바꾸지 못했어요. 잠시 후 다시 선택해 주세요.",
      );
    });
    return () => {
      cancelled = true;
      controller.abort(new Error("background_switch_inactive"));
    };
  }, [bgKey, dollId, dollParam, gameReady, telemetry]);

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
    async (
      reason: "normal" | "time_limit" | "score_limit" = "normal",
      // 시간 종료는 입력을 닫은 뒤 「시간 종료!」 배너를 잠깐 보여 주고 종료 화면을 연다(v1.53).
      opts: { bannerMs?: number } = {},
    ) => {
      if (endingRef.current) return; // 강제종료 grace 중 수동 종료 등 중복 차단(one-shot)
      endingRef.current = true;
      setEndReason(reason);
      // Pixi 생산자와 store 수신 gate를 같은 JS turn에서 먼저 닫은 뒤 결과를
      // 기록한다. 이후 도착한 pellet/throw callback은 양쪽 fence에서 모두 no-op.
      gameRef.current?.end();
      const s = useGameStore.getState();
      end();
      const clock = useGameStore.getState(); // end() 가 시계를 멈춘 뒤 값 = 확정 플레이 시간
      // 게임 세션 종료 요약 — Logs/Discover 에서 weapon·점수대·플레이타임 분석.
      log.info("game.end", {
        dollId: dollId ?? telemetryBaseDollLabel(baseDollKey),
        bg: bgKeyRef.current,
        score: s.score,
        maxCombo: s.maxCombo,
        hitCount: s.hitCount,
        mainWeapon: topWeapon(s.weaponCounts),
        weaponCounts: s.weaponCounts,
        durationMs: Math.round(
          activeGameElapsedMs(s.isPlaying, s.startedAt, performance.now()),
        ),
        playMs: Math.round(clock.clockAccumMs),
        timeBonusMs: clock.timeBonusMs,
        endReason: reason,
      });
      setSentryGameContext({
        dollId,
        weapon: weaponRef.current.key,
        bg: bgKeyRef.current,
        gamePhase: "over",
      });
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
      if (opts.bannerMs) await new Promise((resolve) => window.setTimeout(resolve, opts.bannerMs));
      // 진행 중 녹화가 있으면 마감해서 마지막 클라이맥스 클립이 버려지지 않게 한 뒤 모달 오픈.
      await finalizeHighlight();
      setOver(true);
    },
    [dollId, baseDollKey, end, finalizeHighlight, router, telemetry]
  );

  // 최신 handleEnd 를 ref 로 — 폴링 인터벌이 handleEnd 재생성에 재구독되지 않게(인터벌 리셋 방지).
  const handleEndRef = useRef(handleEnd);
  useEffect(() => {
    handleEndRef.current = handleEnd;
  }, [handleEnd]);

  // 제한 시간 종료(v1.53) — 0초 순간 새 입력을 막고(궁극기 포함 — handleUltimate 가드), 진행 중인 궁극기만 끝까지
  // 친 뒤(최대 3.9초, 이미 발동한 몫) 버저 + 「시간 종료!」 → 종료 화면. end_reason 은 기존 time_limit 재사용.
  const handleTimeUp = useCallback(() => {
    if (timeUpRef.current || endingRef.current) return;
    timeUpRef.current = true;
    setTimeUp(true);
    const finish = () => {
      ultWaitRef.current = null;
      playTimerCue("buzzer");
      setForcedBanner("시간 종료!");
      void handleEndRef.current("time_limit", { bannerMs: TIME_UP_BANNER_MS });
    };
    if (gameRef.current?.isUltimateActive()) {
      ultWaitRef.current = window.setInterval(() => {
        if (gameRef.current?.isUltimateActive()) return;
        if (ultWaitRef.current !== null) window.clearInterval(ultWaitRef.current);
        finish();
      }, 100);
      return;
    }
    finish();
  }, []);
  // 언마운트 시 궁극기 마무리 대기 정리.
  useEffect(
    () => () => {
      if (ultWaitRef.current !== null) window.clearInterval(ultWaitRef.current);
    },
    [],
  );

  // 강제 종료 폴링 — gameReady·!over 동안 0.5s 마다 한도 체크. 도달 시 배너 → grace 후 1회 종료.
  useEffect(() => {
    if (!gameReady || over) return;
    const limits = limitsRef.current;
    const id = window.setInterval(() => {
      if (forceEndRef.current) return;
      const s = useGameStore.getState();
      if (!s.isPlaying) return;
      const elapsed =
        activeGameElapsedMs(true, s.startedAt, performance.now()) / 1000;
      // 강제 종료(어뷰징 방지) — 최대 점수 · 최대 경과 시간(벽시계, 멈춰 있어도 흐름). 제한 시간 종료는 handleTimeUp.
      const reason =
        s.score >= limits.maxScore
          ? "score_limit"
          : elapsed >= limits.maxElapsedSeconds
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
    timeUpRef.current = false;
    setTimeUp(false);
    if (ultWaitRef.current !== null) {
      window.clearInterval(ultWaitRef.current);
      ultWaitRef.current = null;
    }
    setCountdownActive(false);
    if (graceTimerRef.current) {
      window.clearTimeout(graceTimerRef.current); // orphan grace timeout 차단(D1)
      graceTimerRef.current = null;
    }
    bgVisitsRef.current = new Set([bgKeyRef.current]); // 새 세션 — 현재 배경만
    configureJuggle(juggleConfigFromSeconds(scoreCfg.juggle));
    configureTimeLimit(timeLimitConfigFromSeconds(limitsRef.current.timeLimit));
    start();
    noteMap(bgKeyRef.current);
    gameRef.current?.start();
    telemetry.startSession(bgKeyRef.current, weaponRef.current.key);
  };

  // 게임 종료(over) 시점 방문 배경 스냅샷 — over=true 이후 bgVisitsRef 변이가 없어 렌더 중 읽기 안전(의도적).
  // JSX 속성엔 국소 해제 주석을 못 달아 여기서 스냅샷.
  // eslint-disable-next-line react-hooks/refs
  const bgVisitsSnapshot = getBgVisits();

  return (
    <div
      className={PLAY_SURFACE_CLASS}
      onContextMenu={(e) => e.preventDefault()}
    >
      <h1 className="sr-only">부장님 패기 게임</h1>
      {/* min-h-0/min-w-0: flex item 이 canvas(고정 CSS 크기) content 이하로 축소되게 허용 →
          ResizeObserver 가 창 축소도 포착(없으면 min-content=캔버스 크기에 묶여 미발화). */}
      <div ref={stageRef} className="min-h-0 min-w-0 flex-1 select-none" />
      {!gameReady && !gameInitError && <PlayLoadingOverlay doll={baseDollKey} />}
      {!gameReady && gameInitError && (
        <div
          role="alert"
          className="absolute inset-0 z-30 flex flex-col items-center justify-center gap-4 bg-zinc-900/90 px-6 text-center"
        >
          <p className="text-sm font-medium text-white">{gameInitError}</p>
          <button
            type="button"
            onClick={() => setGameInitAttempt((attempt) => attempt + 1)}
            className="rounded-xl bg-amber-400 px-5 py-2.5 text-sm font-bold text-zinc-950"
          >
            다시 시도
          </button>
        </div>
      )}
      {/* 마지막 10초엔 카운트다운이 말풍선 자리를 쓴다(시비 멘트 쉼). 시간 종료 뒤에도 배너와 겹치지 않게 쉰다. */}
      <SpeechBubble text={countdownActive || timeUp ? null : taunt} />
      <ScoreBoard />
      <TimeLimitHud
        running={gameReady && !over}
        onTimeUp={handleTimeUp}
        onCountdownChange={setCountdownActive}
      />
      {gameReady && !over && (
        <BadgeChallenge slots={slots} error={badgeLoadError} />
      )}
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
      {bgSwitchError && gameReady && !over && (
        <div
          role="status"
          className="pointer-events-none absolute inset-x-0 top-24 z-20 flex justify-center px-4"
        >
          <p className="rounded-full bg-red-950/90 px-4 py-2 text-xs font-medium text-red-100 shadow-lg">
            {bgSwitchError}
          </p>
        </div>
      )}
      <div className="pointer-events-auto absolute right-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 flex items-center gap-2 sm:right-4 sm:top-4">
        <button
          type="button"
          onClick={toggleSound}
          aria-label={soundMuted ? "소리 켜기" : "소리 끄기"}
          aria-pressed={soundMuted}
          className="rounded-full bg-black/50 px-2.5 py-1.5 text-sm text-white backdrop-blur-sm sm:px-3 sm:py-2"
        >
          {soundMuted ? "🔇" : "🔊"}
        </button>
        {/* 게임 준비 전엔 자리만 차지한다(v1.60, invisible = 보이지도 눌리지도 않음) — 준비 뒤에 새로 나타나며 🔊 를 왼쪽으로 밀던 것. */}
        <button
          type="button"
          onClick={() => void handleEnd()}
          disabled={!gameReady}
          className={`rounded-full bg-black/50 px-3 py-1.5 text-xs font-medium text-white backdrop-blur-sm sm:px-4 sm:py-2 sm:text-sm ${
            gameReady ? "" : "invisible"
          }`}
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
      {/* 무기 조작 안내 — picker 바로 위. 반투명 캡슐로 배경 무관 가독.
          하단 HUD 세로 간격 8px: 피커 윗변 = 모바일 88px(bottom-12 + 40) · sm 116px(bottom-14 + 60) → 캡슐 96 · 124px. */}
      <div className="pointer-events-none absolute bottom-24 left-1/2 z-10 -translate-x-1/2 sm:bottom-31">
        <span
          className={`whitespace-nowrap rounded-full bg-black/55 px-3 py-1 text-xs backdrop-blur-sm sm:text-sm ${
            !hoverWeapon && !clockStarted ? "font-bold text-lime-300" : "font-medium text-white/90"
          }`}
        >
          {hoverWeapon
            ? keyboardHint(hoverWeapon.category)
            : !clockStarted
              ? `때리는 순간 ${baseSeconds}초 시작!`
              : weaponHint(weapon.key, role)}
        </span>
      </div>
      <UltimateButton ready={ultReady} onFire={handleUltimate} bonusSeconds={ultBonusSeconds} />
      <WeaponPicker
        weapons={roster}
        active={weapon.key}
        onChange={handleWeapon}
        hasDrawing={hasDrawing}
        onClearDrawing={() => gameRef.current?.clearDrawing()}
        onHover={setHoverWeapon}
      />
      <BgSwitcher active={bgKey} onChange={handleBg} />
      <GameOverModal
        open={over}
        onRestart={handleRestart}
        weapon={weapon.key}
        dollId={dollId}
        baseDoll={baseDollKey}
        role={role}
        gender={gender}
        dollImageUrl={dollImageUrl}
        highlightClip={bestClip}
        getCardHighlight={getTimelineHighlight}
        bgVisits={bgVisitsSnapshot}
        endReason={endReason}
        telemetrySessionId={telemetry.getSessionId()}
        playTotals={playTotals}
      />
    </div>
  );
}

function PlayKeyed() {
  // dollId 가 바뀌면 PlayInner 를 완전 remount — useState/timer/effect 모두 깔끔 리셋.
  const sp = useSearchParams();
  return <PlayInner key={sp.get("doll") ?? "_default"} />;
}

// 게임 화면 틀 · 로딩 막 — 본 화면과 서버 HTML fallback 이 같이 쓴다(v1.60). fallback 이 비어 있으면 JS 가 뜰 때까지
// 크림색 빈 화면이었다가 어두운 게임 화면으로 바뀌었다.
// h-[100dvh]: 뷰포트에 고정된 정의 높이 → 창 리사이즈/모바일 주소창에 즉시 추종(flex-1 은 body min-h-full 체인이라
//   canvas content 가 컨테이너를 붙들어 축소 시 안 줄어들던 문제).
const PLAY_SURFACE_CLASS = "game-surface relative flex h-[100dvh] flex-col overflow-hidden bg-zinc-900";

/**
 * 로딩 막. v1.65: 기본 캐릭터로 들어오면 그 캐릭터 카드 이미지를 보여 주고, 홈 얼굴 · 갤러리 카드에서 눌러 들어오면 누른 이미지가
 * 이 자리로 커지며 이어진다(PlayDollPreview — View Transition 모핑). 커스텀 캐릭터 · 직접 진입은 종전처럼 스피너만.
 */
function PlayLoadingOverlay({ doll }: { doll?: BaseDollKey | null }) {
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex flex-col items-center justify-center gap-3 bg-zinc-900/80">
      <PlayDollPreview doll={doll} />
      <Spinner className="h-8 w-8 text-white/80" />
      <p className="text-sm text-white/70">캐릭터 불러오는 중...</p>
    </div>
  );
}

export default function PlayPage() {
  return (
    <Suspense
      fallback={
        <div {...PAGE_LOADING_PROPS} className={PLAY_SURFACE_CLASS}>
          <h1 className="sr-only">부장님 패기 게임</h1>
          <PlayLoadingOverlay />
        </div>
      }
    >
      <PlayKeyed />
    </Suspense>
  );
}
