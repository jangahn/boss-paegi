"use client";

import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { useGameStore } from "@/store/gameStore";
import { TIMESLICE_MS, EVAL_INTERVAL_MS, type HighlightClip } from "@/lib/highlight";
import {
  recordingSupported,
  buildRecorder,
  assembleClipBlob,
  validateClip,
  type RecChunk,
  type MimeSel,
} from "./highlight-clip";
import { HighlightTracker } from "./highlight-tracker";
import { getRecordingStream } from "@/lib/sound";
import { log } from "@/lib/log";
import type { GameHandle } from "@/game/BossPaegiGame";

export type { HighlightClip };

/**
 * 게임 전체를 **연속 녹화**(롤링버퍼)하며 Δscore 최대 [3~5s] 윈도우를 **포함**하는 구간을
 * 사후 스냅샷해 best clip 1개로 보관. forward-only MediaRecorder 가 "이미 시작된 급상승을 못 잡는"
 * 한계를 롤링버퍼 + 증분 추적(HighlightTracker) + pending 스냅샷으로 해결. 미지원/실패 시 카드 폴백.
 */
export function useHighlightRecorder(opts: {
  gameRef: MutableRefObject<GameHandle | null>;
  recording: boolean;
}): {
  supported: boolean;
  bestClip: HighlightClip | null;
  finalize: () => Promise<HighlightClip | null>;
} {
  const { gameRef, recording } = opts;
  const [supported] = useState(() => recordingSupported());
  const [bestClip, setBestClip] = useState<HighlightClip | null>(null);

  const mrRef = useRef<MediaRecorder | null>(null);
  const videoStreamRef = useRef<MediaStream | null>(null);
  const selRef = useRef<MimeSel | null>(null);
  const trackerRef = useRef<HighlightTracker | null>(null);

  const seqRef = useRef(0);
  const recordingStartPerfRef = useRef(0);
  const prevChunkEndPerfRef = useRef<number | null>(null);

  const startedRef = useRef(false);
  const isFinalizingRef = useRef(false);
  const isFinalizedRef = useRef(false);
  const isRecordingDisabledRef = useRef(false);
  const bestRef = useRef<HighlightClip | null>(null);
  const evalTimerRef = useRef<number | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  /** ondataavailable — 청크 메타(timecode 우선) 만들어 tracker 에 push. */
  const onData = useCallback((e: BlobEvent) => {
    const tracker = trackerRef.current;
    if (!tracker || !e.data || e.data.size === 0) return;
    const seq = seqRef.current++;
    const startPerf = prevChunkEndPerfRef.current ?? recordingStartPerfRef.current;
    const tc = e.timecode;
    let endPerf =
      typeof tc === "number" && Number.isFinite(tc)
        ? recordingStartPerfRef.current + tc // 인코딩/메인스레드 지연 보정
        : performance.now();
    if (!(endPerf > startPerf)) {
      // 0/음수 폭(첫 청크 tc=0 등) → emit 시각으로 보정(monotonic 보장).
      endPerf = Math.max(performance.now(), startPerf + TIMESLICE_MS);
    }
    prevChunkEndPerfRef.current = endPerf;
    const chunk: RecChunk = { seq, startPerf, endPerf, blob: e.data };
    tracker.pushChunk(chunk);
  }, []);

  const maybeEvaluate = useCallback(() => {
    if (isRecordingDisabledRef.current) return;
    trackerRef.current?.evaluate(useGameStore.getState().scoreSamples);
  }, []);

  /** MR/스트림/타이머 정리(audio recordDest 는 재사용이라 stop 금지). idempotent. */
  const cleanup = useCallback(() => {
    if (evalTimerRef.current != null) {
      window.clearInterval(evalTimerRef.current);
      evalTimerRef.current = null;
    }
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
    const mr = mrRef.current;
    if (mr && mr.state !== "inactive") {
      try {
        mr.stop();
      } catch {
        /* */
      }
    }
    mrRef.current = null;
    videoStreamRef.current?.getVideoTracks().forEach((t) => {
      try {
        t.stop();
      } catch {
        /* */
      }
    });
    videoStreamRef.current = null;
    startedRef.current = false; // 재플레이 시 재시작 가능
  }, []);

  useEffect(() => {
    if (!recording || !supported || startedRef.current) return;
    // 새 게임 — 상태 초기화
    trackerRef.current = new HighlightTracker();
    seqRef.current = 0;
    recordingStartPerfRef.current = 0;
    prevChunkEndPerfRef.current = null;
    isFinalizingRef.current = false;
    isFinalizedRef.current = false;
    isRecordingDisabledRef.current = false;
    bestRef.current = null;
    setBestClip(null);

    const videoStream = gameRef.current?.captureStream(30);
    if (!videoStream || videoStream.getVideoTracks().length === 0) {
      isRecordingDisabledRef.current = true;
      log.info("highlight.record_unavailable", {});
      return;
    }
    const audioStream = getRecordingStream();
    const tracks: MediaStreamTrack[] = [...videoStream.getVideoTracks()];
    let hasAudio = false;
    if (audioStream) {
      const at = audioStream.getAudioTracks();
      if (at.length) {
        tracks.push(...at);
        hasAudio = true;
      }
    }
    const built = buildRecorder(new MediaStream(tracks), hasAudio);
    if (!built) {
      videoStream.getVideoTracks().forEach((t) => t.stop());
      isRecordingDisabledRef.current = true;
      return;
    }
    const { mr, sel } = built;
    startedRef.current = true;
    selRef.current = sel;
    mrRef.current = mr;
    videoStreamRef.current = videoStream;
    recordingStartPerfRef.current = performance.now();
    mr.ondataavailable = onData;
    mr.onerror = () => {
      // 추가 녹화만 중단 — 이미 확보한 candidates 는 finalize 에서 검증(background/일시stop 보존).
      isRecordingDisabledRef.current = true;
      log.warn("highlight.recorder_error", {});
    };
    try {
      mr.start(TIMESLICE_MS);
    } catch {
      isRecordingDisabledRef.current = true;
      cleanup();
      return;
    }
    log.info("highlight.record_started_continuous", { audio: hasAudio, mime: sel.mime });

    // 평가: scoreSamples 변경(=score 갱신) 직후 + 폴백 interval.
    evalTimerRef.current = window.setInterval(maybeEvaluate, EVAL_INTERVAL_MS);
    unsubRef.current = useGameStore.subscribe((s, prev) => {
      if (s.scoreSamples !== prev.scoreSamples) maybeEvaluate();
    });

    return () => {
      cleanup();
    };
  }, [recording, supported, gameRef, onData, maybeEvaluate, cleanup]);

  /**
   * 게임 종료 시 호출(over 플립 전 await) — 마지막 청크 flush → tracker.finalize →
   * 후보 delta 순 검증 → 첫 통과를 bestClip 으로. idempotent.
   */
  const finalize = useCallback(async (): Promise<HighlightClip | null> => {
    if (isFinalizedRef.current || isFinalizingRef.current) return bestRef.current;
    isFinalizingRef.current = true;
    try {
      const mr = mrRef.current;
      if (mr && mr.state !== "inactive") {
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (done) return;
            done = true;
            resolve();
          };
          mr.onstop = finish;
          try {
            mr.requestData();
          } catch {
            /* */
          }
          try {
            mr.stop();
          } catch {
            finish();
          }
          setTimeout(finish, 600); // iOS onstop 미발화 대비
        });
      }

      const tracker = trackerRef.current;
      const sel = selRef.current;
      if (tracker && sel) {
        tracker.finalize(useGameStore.getState().scoreSamples); // 마지막 구간 강제 스냅샷
        const initChunk = tracker.initChunk;
        const initSeq = tracker.initSeq;
        const ordered = tracker.orderedCandidates();
        if (initChunk && initSeq != null && ordered.length) {
          const bySeq = tracker.chunkMap();
          for (const cand of ordered) {
            const blob = assembleClipBlob(bySeq, cand.chunkSeqs, initChunk, initSeq, sel.mime);
            if (!blob || blob.size === 0) continue;
            if (!(await validateClip(blob))) continue;
            const windowMs = Math.round(cand.winEndAt - cand.winStartAt);
            bestRef.current = { blob, mime: sel.mime, ext: sel.ext, delta: cand.delta, windowMs };
            log.info("highlight.snapshot_success", {
              delta: cand.delta,
              windowMs,
              sizeBytes: blob.size,
            });
            break;
          }
        }
        if (!bestRef.current) log.info("highlight.no_clip", { candidates: ordered.length });
      }
    } finally {
      isFinalizedRef.current = true;
      isFinalizingRef.current = false;
      cleanup();
    }
    setBestClip(bestRef.current);
    return bestRef.current;
  }, [cleanup]);

  return { supported, bestClip, finalize };
}
