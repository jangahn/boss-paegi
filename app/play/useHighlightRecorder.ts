"use client";

import { useEffect, useRef, useState, type MutableRefObject } from "react";
import { useGameStore } from "@/store/gameStore";
import {
  recentVelocity,
  RECORD_WINDOW_MS,
  MAX_RECORD_ATTEMPTS,
  VELOCITY_TRIGGER,
  type HighlightClip,
} from "@/lib/highlight";
import { log } from "@/lib/log";
import type { GameHandle } from "@/game/BossPaegiGame";

export type { HighlightClip };

const SAMPLE_INTERVAL_MS = 100;
/** ~4s 클립 ≤~2MB 목표 (4s × 3.5Mbps ÷ 8 ≈ 1.75MB) */
const VIDEO_BITRATE = 3_500_000;
const COMBO_MILESTONE = 10; // 콤보가 이 배수를 넘을 때 녹화 트리거

/** 인앱 webview — 녹화/공유 불안정 → skip (카드 공유로 폴백). */
function knownBadWebView(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /KAKAOTALK|Instagram|FBAN|FBAV|Line\/|NAVER|wv\)/i.test(ua);
}

function pickMime(): { mime: string; ext: "mp4" | "webm" } | null {
  const cands: Array<{ mime: string; ext: "mp4" | "webm" }> = [
    { mime: "video/mp4;codecs=avc1", ext: "mp4" },
    { mime: "video/mp4", ext: "mp4" },
    { mime: "video/webm;codecs=vp9", ext: "webm" },
    { mime: "video/webm;codecs=vp8", ext: "webm" },
    { mime: "video/webm", ext: "webm" },
  ];
  for (const c of cands) {
    try {
      if (MediaRecorder.isTypeSupported(c.mime)) return c;
    } catch {
      /* skip */
    }
  }
  return null;
}

function recordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    !!pickMime() &&
    !knownBadWebView()
  );
}

/** onstop 미발화(iOS) 대비 — requestData 후 stop, 600ms 안에 안 끝나면 수집 청크로 조립. */
function finishRecording(mr: MediaRecorder, chunks: Blob[]): Promise<Blob> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve(new Blob(chunks, { type: mr.mimeType }));
    };
    mr.onstop = finish;
    try {
      mr.requestData();
    } catch {
      /* ignore */
    }
    try {
      mr.stop();
    } catch {
      finish();
    }
    setTimeout(finish, 600);
  });
}

/**
 * 점수 급상승 구간을 짧게(≈4초) 녹화해 best clip 1개만 보관.
 * recording=true 동안 100ms 샘플링 + velocity/ultimate/combo spike 에서 최대 3회 녹화.
 */
export function useHighlightRecorder(opts: {
  gameRef: MutableRefObject<GameHandle | null>;
  recording: boolean;
}): { supported: boolean; bestClip: HighlightClip | null } {
  const { gameRef, recording } = opts;
  const [supported] = useState(() => recordingSupported());
  // best clip 은 값으로 노출(ref-during-render 회피) — 갱신은 녹화 완료 콜백에서.
  const [bestClip, setBestClip] = useState<HighlightClip | null>(null);

  const bestRef = useRef<HighlightClip | null>(null);
  const activeRef = useRef<MediaRecorder | null>(null);
  const attemptsRef = useRef(0);
  const lastComboRef = useRef(0);
  const lastUltReadyRef = useRef(false);

  useEffect(() => {
    if (!recording || !supported) return;
    log.info("highlight.record_supported", { supported: true });
    // 새 게임 — 상태 리셋(재시작 시 이전 클립/카운트 잔류 방지)
    attemptsRef.current = 0;
    bestRef.current = null;
    lastComboRef.current = 0;
    lastUltReadyRef.current = false;
    // 게임 시작 시 1회 리셋 — 동기 setState 지만 cascading 아님(룰 오탐).
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBestClip(null);

    const mimeSel = pickMime();
    let cancelled = false;

    const startAttempt = () => {
      if (cancelled || activeRef.current || attemptsRef.current >= MAX_RECORD_ATTEMPTS)
        return;
      if (!mimeSel) return;
      const stream = gameRef.current?.captureStream(30) ?? null;
      if (!stream) return;
      let mr: MediaRecorder;
      try {
        mr = new MediaRecorder(stream, {
          mimeType: mimeSel.mime,
          videoBitsPerSecond: VIDEO_BITRATE,
        });
      } catch {
        return;
      }
      attemptsRef.current += 1;
      activeRef.current = mr;
      const startScore = useGameStore.getState().score;
      const startedAt = performance.now();
      const chunks: Blob[] = [];
      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mr.start(250);
      log.info("highlight.record_started", { attempt: attemptsRef.current });

      window.setTimeout(async () => {
        if (activeRef.current !== mr) return;
        const blob = await finishRecording(mr, chunks);
        if (activeRef.current === mr) activeRef.current = null;
        const delta = Math.max(0, useGameStore.getState().score - startScore);
        const windowMs = Math.round(performance.now() - startedAt);
        if (blob.size === 0) {
          log.warn("highlight.empty_blob", { attempt: attemptsRef.current });
          return;
        }
        if (!bestRef.current || delta > bestRef.current.delta) {
          bestRef.current = { blob, mime: mimeSel.mime, ext: mimeSel.ext, delta, windowMs };
          setBestClip(bestRef.current);
          log.info("highlight.record_success", {
            delta,
            windowMs,
            sizeBytes: blob.size,
          });
        }
      }, RECORD_WINDOW_MS);
    };

    const tick = () => {
      const st = useGameStore.getState();
      st.pushScoreSample();
      // 트리거: 점수 급상승 OR 궁극기 준비(rising) OR 콤보 마일스톤 돌파
      const velocity = recentVelocity(st.scoreSamples, performance.now());
      const comboMilestoneCrossed =
        Math.floor(st.combo / COMBO_MILESTONE) >
        Math.floor(lastComboRef.current / COMBO_MILESTONE);
      const ultRose = st.ultReady && !lastUltReadyRef.current;
      lastComboRef.current = st.combo;
      lastUltReadyRef.current = st.ultReady;
      if (velocity >= VELOCITY_TRIGGER || comboMilestoneCrossed || ultRose) {
        startAttempt();
      }
    };

    const interval = window.setInterval(tick, SAMPLE_INTERVAL_MS);

    return () => {
      cancelled = true;
      window.clearInterval(interval);
      // 진행 중 녹화는 즉시 마감(게임 종료) — best 비교에 반영
      const mr = activeRef.current;
      if (mr && mr.state !== "inactive") {
        try {
          mr.stop();
        } catch {
          /* ignore */
        }
      }
      activeRef.current = null;
    };
  }, [recording, supported, gameRef]);

  return { supported, bestClip };
}
