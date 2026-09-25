"use client";

import { useEffect, useState } from "react";

/**
 * 생성 대기 진행 표시 — 단계 텍스트는 **서버 실상태**(2026-08-01 제품 결정:
 * 타이머 휴리스틱 금지). phase=analyzing/drawing 은 폴 응답이 단일 소스이고,
 * drawing 중 후보 적재 수(n/3)도 실제 웹훅 적재를 그대로 보여준다.
 * 진행 바만 심리적 경과 표시로 남기되, 리마운트에 리셋되지 않도록 서버
 * created_at(startedAtMs)에 앵커한다.
 */
export function GeneratingProgress({
  phase,
  candidatesReady,
  startedAtMs,
}: {
  phase: "analyzing" | "drawing";
  candidatesReady: number;
  startedAtMs: number;
}) {
  // 앵커가 로컬 클릭 시각 → 서버 created_at 으로 갈아탈 때(업로드 시간만큼
  // 경과가 줄어) 바가 뒤로 역행한다 — 진행 표시는 단조 증가로 래칫.
  const [pct, setPct] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const tick = () => {
      const seconds = Math.max(0, (Date.now() - startedAtMs) / 1000);
      const raw = Math.min(95, 95 * (1 - Math.exp(-seconds / 60)));
      setElapsed(seconds);
      setPct((prev) => Math.max(prev, raw));
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [startedAtMs]);
  const text =
    phase === "analyzing"
      ? "사진을 분석하고 있어요"
      : candidatesReady > 0
        ? `캐릭터를 그리고 있어요 (${candidatesReady}/3)`
        : "캐릭터를 그리고 있어요";
  const isLong = elapsed >= 120;

  return (
    <div className="m-auto flex w-full max-w-xs flex-col items-center gap-4 text-center">
      <StampingPaper />
      <p className="text-lg font-medium">{text}</p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label="캐릭터 생성 진행"
      >
        <div
          className="h-full w-full origin-left rounded-full bg-foreground transition-[scale] duration-500 ease-out"
          style={{ scale: `${(pct / 100).toFixed(3)} 1` }}
        />
      </div>
      <p className="text-xs text-zinc-500">
        보통 1~2분 걸려요. 완료되면 자동으로 떠요.
      </p>
      {isLong && (
        <p className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
          예상보다 조금 더 걸리고 있어요. 완료되면 이 화면에 자동으로 떠요. 이
          화면을 벗어나도 갤러리에서 확인·이어서 고를 수 있어요.
        </p>
      )}
    </div>
  );
}

/**
 * 선택한 후보 저장 진행 표시 — 단계 텍스트는 서버 202 응답의 실단계(phase)를
 * 그대로 따른다(2026-08-01 제품 결정: 타이머 휴리스틱 금지).
 * background=배경제거(birefnet) 진행 · saving=결과 저장 · done=응답 수신 후 /play 전환.
 */
export function SavingProgress({
  phase,
}: {
  phase: "background" | "saving" | "done";
}) {
  // 생성 바와 동일 — 어떤 상태 전이에서도 뒤로 가지 않는다(단조 래칫).
  const [startMs] = useState(() => Date.now());
  const [pct, setPct] = useState(0);
  useEffect(() => {
    const tick = () => {
      const seconds = Math.max(0, (Date.now() - startMs) / 1000);
      const raw = Math.min(95, 95 * (1 - Math.exp(-seconds / 7)));
      setPct((prev) => Math.max(prev, raw));
    };
    tick();
    const t = setInterval(tick, 500);
    return () => clearInterval(t);
  }, [startMs]);
  const text =
    phase === "background"
      ? "배경을 정리하고 있어요"
      : phase === "saving"
        ? "캐릭터를 저장하고 있어요"
        : "게임을 준비하고 있어요";

  return (
    <div className="m-auto flex w-full max-w-xs flex-col items-center gap-4 text-center">
      <StampingPaper />
      <p className="text-lg font-medium">{text}</p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label="캐릭터 저장 진행"
      >
        <div
          className="h-full w-full origin-left rounded-full bg-foreground transition-[scale] duration-500 ease-out"
          style={{ scale: `${(pct / 100).toFixed(3)} 1` }}
        />
      </div>
      <p className="text-xs text-zinc-500">곧 게임이 시작돼요.</p>
    </div>
  );
}

/**
 * 대기 표시(v1.65) — 서류에 결재 도장이 쾅쾅 찍힌다(종전 회전 스피너와 같은 56px 자리). 진행 문구는 그대로 서버 실상태.
 * 도장은 크기만 움직인다(scale — 글자 opacity 없음), 모션 감소면 정지(globals.css motion-stamp-loop).
 */
function StampingPaper() {
  return (
    <div aria-hidden className="relative h-14 w-14">
      <div className="absolute inset-x-1.5 inset-y-1 rounded-md border border-foreground/15 bg-paper-2 shadow-sm">
        <div className="mx-2 mt-2 h-1 rounded bg-foreground/15" />
        <div className="mx-2 mt-1.5 h-1 w-5 rounded bg-foreground/15" />
        <div className="mx-2 mt-1.5 h-1 w-7 rounded bg-foreground/15" />
      </div>
      <span className="motion-stamp-loop absolute bottom-1 right-0.5 block h-6 w-6 -rotate-12 rounded-full border-2 border-red-500 bg-red-500/10" />
    </div>
  );
}
