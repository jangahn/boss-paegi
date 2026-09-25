"use client";

import { useEffect, useState } from "react";
import { prefersReducedMotion } from "@/lib/motion";

/**
 * 숫자 카운트업(v1.65) — 결과 보고서 점수. 0 에서 값까지 감속하며 오른다.
 * 자리는 최종 값 폭으로 먼저 잡고(보이지 않는 최종 값) 그 위에 오르는 숫자를 겹쳐, 폭이 바뀌어도 옆 요소가 밀리지 않는다.
 * 화면낭독기는 최종 값만 읽는다. play 가 false(건너뛰기 · 모션 감소)면 바로 최종 값.
 */
export function CountUp({
  value,
  play,
  delayMs,
  durationMs,
}: {
  value: number;
  play: boolean;
  delayMs: number;
  durationMs: number;
}) {
  const [shown, setShown] = useState(0);
  const animate = play && !prefersReducedMotion();

  useEffect(() => {
    if (!animate) return;
    let raf = 0;
    const start = performance.now() + delayMs;
    const tick = (now: number) => {
      const t = Math.min(1, Math.max(0, (now - start) / durationMs));
      setShown(Math.round(value * (1 - Math.pow(1 - t, 3))));
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, value, delayMs, durationMs]);

  const final = value.toLocaleString();
  return (
    <span className="relative inline-block">
      <span aria-hidden className="invisible">
        {final}
      </span>
      <span aria-hidden className="absolute inset-0 text-right">
        {(animate ? shown : value).toLocaleString()}
      </span>
      <span className="sr-only">{final}</span>
    </span>
  );
}
