"use client";

import { useEffect, useRef, useState } from "react";
import { selectRemainingMs, useGameStore } from "@/store/gameStore";
import { COUNTDOWN_SECONDS, formatRemaining } from "@/lib/time-limit";
import { playTimerCue } from "@/lib/sound";

/** 시간 바 색 단계 — 여유(기본 시간의 절반 초과) · 절반 이하 · 마지막 카운트다운. */
type Phase = "calm" | "half" | "last";

/** 추가 시간 알림 노출(ms) — 알약이 잠깐 「+10초」로 바뀌었다 돌아온다. */
const BONUS_FLASH_MS = 1100;
/** 새로 찬 구간 잔상 노출(ms). */
const REFILL_GHOST_MS = 700;

const FILL_COLOR: Record<Phase, string> = {
  // lime 은 디자인 리맵이 없는 색(맵 6종 위에서 구분, v1.48 교훈). 골드·빨강은 어두운 트랙 위라 리맵 값도 뚜렷.
  calm: "bg-lime-300",
  half: "bg-amber-400",
  last: "bg-red-500",
};

/**
 * 제한 시간 HUD(v1.53) — 화면 맨 위 가장자리 시간 바 + 왼쪽 위 남은 시간 알약 + 마지막 10초 카운트다운.
 *
 * 시간은 스토어의 활성 시계(첫 타격부터, 게임 멈춤 동안 정지)에서 읽고, 바 폭은 rAF 가 DOM 에 직접 쓴다(매 프레임
 * React 렌더 없음). 숫자는 초가 바뀔 때만 상태를 갱신한다. 탭이 숨으면 rAF 도 멈추지만 시계도 멈춰 있으니
 * 백그라운드에서 시간이 끝나는 일은 없다. 시간이 0 이 되는 순간 `onTimeUp` 을 한 번 부른다(종료 처리는 호출부).
 * iOS WebKit 텍스트 잔상 방지: 바뀌는 숫자·알림은 key 로 새 요소를 만든다(연속 opacity 애니 금지 — ScoreBoard 주석).
 */
export function TimeLimitHud({
  running,
  onTimeUp,
  onCountdownChange,
}: {
  /** 게임 준비 완료 && 종료 화면 전 — 이때만 rAF 가 돈다. */
  running: boolean;
  onTimeUp: () => void;
  /** 마지막 카운트다운 진입·이탈 — 호출부가 그동안 말풍선을 쉰다(카운트다운이 그 자리를 쓴다). */
  onCountdownChange: (active: boolean) => void;
}) {
  const fillRef = useRef<HTMLDivElement>(null);
  const onTimeUpRef = useRef(onTimeUp);
  const onCountdownRef = useRef(onCountdownChange);
  useEffect(() => {
    onTimeUpRef.current = onTimeUp;
    onCountdownRef.current = onCountdownChange;
  }, [onTimeUp, onCountdownChange]);

  const baseMs = useGameStore((s) => s.timeLimit.baseMs);
  const lastTimeBonus = useGameStore((s) => s.lastTimeBonus);
  const [secondsLeft, setSecondsLeft] = useState(() => Math.ceil(baseMs / 1000));
  const [phase, setPhase] = useState<Phase>("calm");
  const [flash, setFlash] = useState<{ key: number; text: string; gain: boolean } | null>(null);
  const [ghost, setGhost] = useState<{ key: number; left: number; width: number } | null>(null);

  // 바·숫자·카운트다운·시간 종료 — rAF 루프(running 동안만).
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let fired = false;
    let lastSec = -1;
    let lastPhase: Phase | null = null;
    let lastCountdown = false;
    const frame = () => {
      const s = useGameStore.getState();
      const now = performance.now();
      const rem = selectRemainingMs(s, now);
      const ratio = s.timeLimit.baseMs > 0 ? Math.min(1, rem / s.timeLimit.baseMs) : 0;
      if (fillRef.current) fillRef.current.style.width = `${(ratio * 100).toFixed(2)}%`;
      const sec = Math.ceil(rem / 1000);
      const countdown = s.clockStarted && rem > 0 && sec <= COUNTDOWN_SECONDS;
      const ph: Phase = countdown ? "last" : ratio <= 0.5 ? "half" : "calm";
      if (sec !== lastSec) {
        if (lastSec !== -1 && countdown) playTimerCue(sec <= 3 ? "tickLast" : "tick");
        lastSec = sec;
        setSecondsLeft(sec);
      }
      if (ph !== lastPhase) {
        lastPhase = ph;
        setPhase(ph);
      }
      if (countdown !== lastCountdown) {
        lastCountdown = countdown;
        onCountdownRef.current(countdown);
      }
      if (!fired && s.clockStarted && s.isPlaying && rem <= 0) {
        fired = true;
        onTimeUpRef.current();
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      if (lastCountdown) onCountdownRef.current(false);
    };
  }, [running]);

  // 추가 시간 알림 — 알약이 잠깐 「+10초」(최대 플레이 시간에 막히면 「최대 시간」)로 바뀌고, 바에 새로 찬 구간 잔상.
  const lastBonusAt = lastTimeBonus?.at;
  useEffect(() => {
    if (lastBonusAt == null) return;
    const s = useGameStore.getState();
    const amount = s.lastTimeBonus?.amount ?? 0;
    const base = s.timeLimit.baseMs;
    const rem = selectRemainingMs(s, performance.now());
    const to = base > 0 ? Math.min(1, rem / base) : 0;
    const from = base > 0 ? Math.min(1, Math.max(0, rem - amount) / base) : 0;
    if (amount > 0) playTimerCue("gain");
    // 추가 시간 순간 동기화 — 알림·잔상은 이 순간의 타이머 UI(의도적).
    /* eslint-disable react-hooks/set-state-in-effect */
    setFlash({ key: lastBonusAt, text: amount > 0 ? `+${Math.round(amount / 1000)}초` : "최대 시간", gain: amount > 0 });
    if (to > from) setGhost({ key: lastBonusAt, left: from * 100, width: (to - from) * 100 });
    /* eslint-enable react-hooks/set-state-in-effect */
    const t1 = setTimeout(() => setFlash((f) => (f?.key === lastBonusAt ? null : f)), BONUS_FLASH_MS);
    const t2 = setTimeout(() => setGhost((g) => (g?.key === lastBonusAt ? null : g)), REFILL_GHOST_MS);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [lastBonusAt]);

  // 알약 배경(블러 레이어)과 글자색 — 추가 시간 알림(라임)·최대 시간(골드)·마지막 10초(빨강)·평상시(오른쪽 위 버튼과 같은 검정 50%).
  const [pillBg, pillText] = flash
    ? flash.gain
      ? ["bg-lime-300", "text-lime-950"]
      : ["bg-amber-400", "text-zinc-950"]
    : phase === "last"
      ? ["bg-red-500/85", "text-white"]
      : ["bg-black/50", "text-white"];

  return (
    <>
      {/* 시간 바 — 맨 위 가장자리(기존 HUD 는 그 아래 12px 부터라 위치 불변) */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-[env(safe-area-inset-top)] z-10 h-2 overflow-hidden bg-black/45"
      >
        <div ref={fillRef} className={`h-full rounded-r-full ${FILL_COLOR[phase]}`} style={{ width: "100%" }} />
        {ghost && (
          <div
            key={ghost.key}
            className="animate-time-refill absolute inset-y-0 rounded-r-full bg-white"
            style={{ left: `${ghost.left}%`, width: `${ghost.width}%` }}
          />
        )}
      </div>

      {/* 남은 시간 알약 — 오른쪽 위 🔊·그만 패기와 같은 자리 규칙·모양. 숫자가 매초 바뀌므로 블러 배경은 형제 레이어로
          분리한다(iOS WebKit backdrop-filter 자손 재도색 잔상 — GameOverModal·ModalShell 과 같은 처방). */}
      <div className="pointer-events-none absolute left-3 top-[max(0.75rem,env(safe-area-inset-top))] z-10 sm:left-4 sm:top-4">
        <div
          key={flash ? `f${flash.key}` : phase}
          role="timer"
          aria-label={`남은 시간 ${secondsLeft}초`}
          className={`${flash ? "animate-time-flash " : ""}relative rounded-full px-2.5 py-1.5 text-sm font-bold tabular-nums sm:px-3 sm:py-2 ${pillText}`}
        >
          <span aria-hidden className={`absolute inset-0 rounded-full backdrop-blur-sm ${pillBg}`} />
          <span className="relative">{flash ? flash.text : `⏱ ${formatRemaining(secondsLeft * 1000)}`}</span>
        </div>
      </div>

      {/* 마지막 10초 — 말풍선 자리(위 18%)에 큰 숫자. 얼굴(타격 지점)은 가리지 않는다. */}
      {phase === "last" && secondsLeft > 0 && (
        <div className="pointer-events-none absolute inset-x-0 top-[18%] z-10 flex justify-center">
          <p
            key={secondsLeft}
            aria-hidden
            className="animate-countdown-pop text-7xl leading-none font-black tabular-nums text-red-500 drop-shadow-lg motion-reduce:animate-none"
            style={{ WebkitTextStroke: "3px white", paintOrder: "stroke fill" }}
          >
            {secondsLeft}
          </p>
        </div>
      )}
    </>
  );
}
