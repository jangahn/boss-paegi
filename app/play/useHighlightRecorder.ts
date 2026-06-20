"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { useGameStore } from "@/store/gameStore";
import {
  recentVelocity,
  RECORD_WINDOW_MS,
  MAX_RECORD_ATTEMPTS,
  VELOCITY_TRIGGER,
  type HighlightClip,
} from "@/lib/highlight";
import { getRecordingStream } from "@/lib/sound";
import { log } from "@/lib/log";
import type { GameHandle } from "@/game/BossPaegiGame";

export type { HighlightClip };

const MONITOR_INTERVAL_MS = 100;
/** ~4s 클립 ≤~2MB 목표 */
const VIDEO_BITRATE = 3_500_000;
const AUDIO_BITRATE = 96_000;
const COMBO_MILESTONE = 10;

/** 인앱 webview — 녹화/공유 불안정 → skip (카드 공유로 폴백). */
function knownBadWebView(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /KAKAOTALK|Instagram|FBAN|FBAV|Line\/|NAVER|wv\)/i.test(ua);
}

type MimeSel = { mime: string; ext: "mp4" | "webm"; audio: boolean };

// audio 포함 우선 → 안 되면 video-only. (audio track 들어가면 codec 조합 실패 가능성 ↑)
const AUDIO_MIMES: MimeSel[] = [
  { mime: "video/mp4;codecs=avc1.42E01E,mp4a.40.2", ext: "mp4", audio: true },
  { mime: "video/mp4", ext: "mp4", audio: true },
  { mime: "video/webm;codecs=vp9,opus", ext: "webm", audio: true },
  { mime: "video/webm;codecs=vp8,opus", ext: "webm", audio: true },
  { mime: "video/webm", ext: "webm", audio: true },
];
const VIDEO_MIMES: MimeSel[] = [
  { mime: "video/mp4;codecs=avc1", ext: "mp4", audio: false },
  { mime: "video/mp4", ext: "mp4", audio: false },
  { mime: "video/webm;codecs=vp9", ext: "webm", audio: false },
  { mime: "video/webm;codecs=vp8", ext: "webm", audio: false },
  { mime: "video/webm", ext: "webm", audio: false },
];

function anySupportedMime(): boolean {
  return [...AUDIO_MIMES, ...VIDEO_MIMES].some((m) => {
    try {
      return MediaRecorder.isTypeSupported(m.mime);
    } catch {
      return false;
    }
  });
}

function recordingSupported(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof MediaRecorder !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    typeof HTMLCanvasElement.prototype.captureStream === "function" &&
    anySupportedMime() &&
    !knownBadWebView()
  );
}

/** isTypeSupported 뿐 아니라 combined stream 으로 실제 생성까지 성공하는 첫 후보. audio 실패 시 video-only. */
function buildRecorder(
  stream: MediaStream,
  hasAudioTrack: boolean
): { mr: MediaRecorder; sel: MimeSel } | null {
  const candidates = hasAudioTrack ? [...AUDIO_MIMES, ...VIDEO_MIMES] : VIDEO_MIMES;
  for (const sel of candidates) {
    try {
      if (!MediaRecorder.isTypeSupported(sel.mime)) continue;
      const mr = new MediaRecorder(stream, {
        mimeType: sel.mime,
        videoBitsPerSecond: VIDEO_BITRATE,
        ...(sel.audio ? { audioBitsPerSecond: AUDIO_BITRATE } : {}),
      });
      return { mr, sel };
    } catch {
      /* 다음 후보 */
    }
  }
  return null;
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
      /* */
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
 * 점수 급상승 구간을 짧게(≈4초) 녹화해 best clip 1개만 보관(영상+게임 효과음).
 * 샘플링은 useScoreTimeline 이 담당 — 여긴 supported 환경에서 트리거/녹화만.
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

  const bestRef = useRef<HighlightClip | null>(null);
  const activeMrRef = useRef<MediaRecorder | null>(null);
  const activeFinishRef = useRef<Promise<void> | null>(null);
  const earlyStopRef = useRef<(() => void) | null>(null);
  const attemptsRef = useRef(0);
  const lastComboRef = useRef(0);
  const lastUltReadyRef = useRef(false);
  const cancelledRef = useRef(false);

  const consider = useCallback(
    (blob: Blob, sel: MimeSel, startScore: number, startedAt: number) => {
      const delta = Math.max(0, useGameStore.getState().score - startScore);
      const windowMs = Math.round(performance.now() - startedAt);
      if (blob.size === 0) {
        log.warn("highlight.empty_blob", {});
        return;
      }
      if (!bestRef.current || delta > bestRef.current.delta) {
        bestRef.current = { blob, mime: sel.mime, ext: sel.ext, delta, windowMs };
        setBestClip(bestRef.current);
        log.info("highlight.record_success", {
          delta,
          windowMs,
          sizeBytes: blob.size,
          audio: sel.audio,
        });
      }
    },
    []
  );

  const startAttempt = useCallback(() => {
    if (
      cancelledRef.current ||
      activeMrRef.current ||
      attemptsRef.current >= MAX_RECORD_ATTEMPTS
    )
      return;
    const videoStream = gameRef.current?.captureStream(30);
    if (!videoStream) return;
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
    const combined = new MediaStream(tracks);
    const built = buildRecorder(combined, hasAudio);
    if (!built) {
      videoStream.getVideoTracks().forEach((t) => t.stop());
      return;
    }
    const { mr, sel } = built;
    log.info(
      sel.audio ? "highlight.record_audio_attached" : "highlight.record_audio_missing",
      {}
    );
    attemptsRef.current += 1;
    activeMrRef.current = mr;
    const startScore = useGameStore.getState().score;
    const startedAt = performance.now();
    const chunks: Blob[] = [];
    mr.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mr.start(250);
    log.info("highlight.record_started", { attempt: attemptsRef.current });

    const finish = (async () => {
      // window 만큼 대기하되 finalize/cleanup 이 부르면 즉시 진행
      await new Promise<void>((res) => {
        const timer = window.setTimeout(res, RECORD_WINDOW_MS);
        earlyStopRef.current = () => {
          window.clearTimeout(timer);
          res();
        };
      });
      earlyStopRef.current = null;
      const blob = await finishRecording(mr, chunks);
      if (activeMrRef.current === mr) activeMrRef.current = null;
      // canvas video track 만 stop — audio track(recordDest)은 재사용하므로 stop 금지(다음 녹화 무음 방지)
      videoStream.getVideoTracks().forEach((t) => t.stop());
      consider(blob, sel, startScore, startedAt);
    })();
    activeFinishRef.current = finish;
  }, [gameRef, consider]);

  useEffect(() => {
    if (!recording || !supported) return;
    cancelledRef.current = false;
    log.info("highlight.record_supported", { supported: true });
    // 새 게임 리셋
    attemptsRef.current = 0;
    bestRef.current = null;
    lastComboRef.current = 0;
    lastUltReadyRef.current = false;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setBestClip(null);

    const id = window.setInterval(() => {
      const st = useGameStore.getState();
      const velocity = recentVelocity(st.scoreSamples, performance.now());
      const comboCrossed =
        Math.floor(st.combo / COMBO_MILESTONE) >
        Math.floor(lastComboRef.current / COMBO_MILESTONE);
      const ultRose = st.ultReady && !lastUltReadyRef.current;
      lastComboRef.current = st.combo;
      lastUltReadyRef.current = st.ultReady;
      if (velocity >= VELOCITY_TRIGGER || comboCrossed || ultRose) startAttempt();
    }, MONITOR_INTERVAL_MS);

    return () => {
      cancelledRef.current = true;
      window.clearInterval(id);
      earlyStopRef.current?.(); // 진행 중 녹화 즉시 마감(in-flight 처리 → consider 반영)
    };
  }, [recording, supported, startAttempt]);

  /** 게임 종료 시 호출 — 진행 중 녹화를 즉시 마감하고 best 비교 완료까지 대기. */
  const finalize = useCallback(async () => {
    earlyStopRef.current?.();
    if (activeFinishRef.current) {
      try {
        await activeFinishRef.current;
      } catch {
        /* */
      }
    }
    return bestRef.current;
  }, []);

  return { supported, bestClip, finalize };
}
