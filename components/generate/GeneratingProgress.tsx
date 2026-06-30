"use client";

import { useEffect, useState } from "react";

type Stage = { at: number; text: string };

/**
 * 경과시간(초) 기반 진행 표시 — fal/저장이 실제 진행률 신호를 안 주므로 시간 휴리스틱(점근 추정).
 * `tauSec` 가 작을수록 빨리 차오른다(짧은 단계용). asymptote 95% — 완료(부모 언마운트) 전엔 100% 안 됨,
 * 끝에서 "멈춘 듯" 보이지 않게. 숫자(카운트다운)는 미표시(실제 소요 분산이 커 자주 틀림).
 */
function TimedProgress({
  stages,
  tauSec,
  footer,
  ariaLabel,
}: {
  stages: Stage[];
  tauSec: number;
  footer: string;
  ariaLabel: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - start) / 1000), 500);
    return () => clearInterval(t);
  }, []);

  const pct = Math.min(95, 95 * (1 - Math.exp(-elapsed / tauSec))); // 항상 조금씩 차되 95% 점근
  const stage = [...stages].reverse().find((s) => elapsed >= s.at) ?? stages[0];

  return (
    <div className="m-auto flex w-full max-w-xs flex-col items-center gap-4 text-center">
      <div className="h-14 w-14 animate-spin rounded-full border-4 border-foreground/20 border-t-foreground" />
      <p className="text-lg font-medium">{stage.text}</p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label={ariaLabel}
      >
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-zinc-500">{footer}</p>
    </div>
  );
}

// 생성 대기 단계 — fal 큐(실측 p90 ~4분). tau=60.
const GEN_STAGES: Stage[] = [
  { at: 0, text: "사진을 분석하고 있어요" },
  { at: 8, text: "캐릭터를 그리고 있어요" },
  { at: 30, text: "디테일을 다듬고 있어요" },
  { at: 90, text: "거의 다 됐어요" },
];

/**
 * 생성 대기 진행 표시(#4) — 정적 스피너 대신 시간기반 진행바+단계 텍스트로 "멈춘 듯"한 이탈 완화.
 */
export function GeneratingProgress() {
  return (
    <TimedProgress
      stages={GEN_STAGES}
      tauSec={60}
      footer="보통 1~2분 걸려요. 완료되면 자동으로 떠요."
      ariaLabel="캐릭터 생성 진행"
    />
  );
}

// 저장(누끼+정규화+업로드) 단계 — Sentry 실측 p50 ~8s·p95 ~12s(birefnet 누끼가 ~4.4s 최대 병목).
// 정적 "저장 중…" 스피너는 진행 신호가 없어 답답해 보여 → 단계 텍스트 + 시간기반 바로 교체. tau=7.
const SAVE_STAGES: Stage[] = [
  { at: 0, text: "배경을 정리하고 있어요" }, // birefnet 누끼 ~4.4s
  { at: 4, text: "캐릭터를 저장하고 있어요" }, // fetch + normalize + upload ~4s
  { at: 9, text: "게임을 준비하고 있어요" }, // /api/doll 응답 후 /play 이동 커버
];

/** 선택한 후보 저장 진행 표시 — GeneratingProgress 와 동일 패턴, 짧은 단계용 튜닝. */
export function SavingProgress() {
  return (
    <TimedProgress
      stages={SAVE_STAGES}
      tauSec={7}
      footer="곧 게임이 시작돼요."
      ariaLabel="캐릭터 저장 진행"
    />
  );
}
