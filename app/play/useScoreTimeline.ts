"use client";

import { useCallback, useEffect } from "react";
import { useGameStore } from "@/store/gameStore";
import { pickHighlightWindow } from "@/lib/highlight";

const SAMPLE_INTERVAL_MS = 100;

/**
 * 점수 timeline 100ms 샘플링 — **녹화 지원 여부와 무관하게 gameplay 중 항상** 실행.
 * 녹화 불가 환경에서도 카드-only 하이라이트(`+N점`)를 계산할 수 있게 하기 위함.
 * (MediaRecorder 녹화는 별도 useHighlightRecorder 가 supported 환경에서만.)
 */
export function useScoreTimeline({ recording }: { recording: boolean }): {
  getTimelineHighlight: () => { delta: number; windowMs: number } | null;
} {
  useEffect(() => {
    if (!recording) return;
    const id = window.setInterval(() => {
      useGameStore.getState().pushScoreSample();
    }, SAMPLE_INTERVAL_MS);
    return () => window.clearInterval(id);
  }, [recording]);

  const getTimelineHighlight = useCallback(() => {
    const w = pickHighlightWindow(useGameStore.getState().scoreSamples);
    if (!w) return null;
    return { delta: w.delta, windowMs: Math.round(w.endAt - w.startAt) };
  }, []);

  return { getTimelineHighlight };
}
