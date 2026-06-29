"use client";

import { useEffect, useState } from "react";

// 경과시간(초) 기준 단계 텍스트 — fal 비동기라 실제 진행 신호가 없어 시간 휴리스틱(A+B).
const STAGES = [
  { at: 0, text: "사진을 분석하고 있어요" },
  { at: 8, text: "캐릭터를 그리고 있어요" },
  { at: 30, text: "디테일을 다듬고 있어요" },
  { at: 90, text: "거의 다 됐어요" },
];

/**
 * 생성 대기 진행 표시(#4) — 정적 스피너 대신 **시간기반 진행바 + 단계 텍스트**로 "멈춘 듯"한 이탈 완화.
 * fal 큐가 실제 진행률을 안 주므로 경과시간 기반 **점근 추정**(asymptote 95% — 완료 신호[부모 언마운트]
 * 전엔 100% 안 됨, 끝에서 멈춘 듯 보이지 않게). 숫자(카운트다운)는 안 보이고 범위만(실측 p90 4분이라
 * 카운트다운은 자주 틀림). resume 진입은 경과가 0부터라 약간 낙관적이나 무해.
 */
export function GeneratingProgress() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.now();
    const t = setInterval(() => setElapsed((Date.now() - start) / 1000), 500);
    return () => clearInterval(t);
  }, []);

  const pct = Math.min(95, 95 * (1 - Math.exp(-elapsed / 60))); // 항상 조금씩 차되 95% 점근
  const stage = [...STAGES].reverse().find((s) => elapsed >= s.at) ?? STAGES[0];

  return (
    <div className="m-auto flex w-full max-w-xs flex-col items-center gap-4 text-center">
      <div className="h-14 w-14 animate-spin rounded-full border-4 border-foreground/20 border-t-foreground" />
      <p className="text-lg font-medium">{stage.text}</p>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-foreground/10"
        role="progressbar"
        aria-label="캐릭터 생성 진행"
      >
        <div
          className="h-full rounded-full bg-foreground transition-[width] duration-500 ease-out"
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-zinc-500">보통 1~2분 걸려요. 완료되면 자동으로 떠요.</p>
    </div>
  );
}
