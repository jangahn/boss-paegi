/**
 * 하이라이트 클립 메커닉 — MediaRecorder 지원판정 / 빌드 / 롤링버퍼 청크 선택·조립 / 재생검증.
 * (React 무관 순수·DOM 헬퍼. 오케스트레이션은 useHighlightRecorder.)
 */
import {
  PRE_ROLL_MS,
  POST_ROLL_MS,
  TIMESLICE_MS,
  VIDEO_BITRATE,
  type HighlightWindow,
} from "@/lib/highlight";

const AUDIO_BITRATE = 96_000;

/** 롤링버퍼 1청크 — 같은 perf 시계의 [startPerf, endPerf] 구간 보유. */
export type RecChunk = { seq: number; startPerf: number; endPerf: number; blob: Blob };

export type MimeSel = { mime: string; ext: "mp4" | "webm"; audio: boolean };

/** 인앱 webview — 녹화/공유 불안정 → skip (카드 공유로 폴백). */
function knownBadWebView(): boolean {
  const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
  return /KAKAOTALK|Instagram|FBAN|FBAV|Line\/|NAVER|wv\)/i.test(ua);
}

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

export function recordingSupported(): boolean {
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
export function buildRecorder(
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

/**
 * window([startAt,endAt]) 를 포함하는 청크 seq 들을 고른다(±PRE/POST_ROLL 여유).
 * **coverage + contiguity** 검증 통과 시에만 seq 배열, 아니면 null:
 *  - 비어있지 않고, window 시작/끝이 선택 청크로 덮임
 *  - 선택 청크 seq 연속(중간 빠짐 없음) + startPerf/endPerf 역전 없음
 * final=true(finalize) 면 양끝 padding 요구를 완화(녹화가 끝나 trailing 청크가 없을 수 있음).
 */
export function selectWindowChunks(
  chunks: RecChunk[],
  initSeq: number,
  win: HighlightWindow,
  recordingReadyPerf: number,
  final: boolean
): number[] | null {
  const lo = win.startAt - PRE_ROLL_MS;
  const hi = win.endAt + POST_ROLL_MS;
  const selected = chunks
    .filter((c) => c.endPerf > lo && c.startPerf < hi && c.blob.size > 0)
    .sort((a, b) => a.seq - b.seq);
  if (selected.length === 0) return null;

  const earliest = selected[0];
  const latest = selected[selected.length - 1];
  // coverage — final 이면 실제 window 만 덮으면 OK(padding best-effort), 평시엔 padding 까지.
  const startOk = final
    ? earliest.startPerf <= win.startAt || earliest.startPerf <= recordingReadyPerf + TIMESLICE_MS
    : earliest.startPerf <= lo || earliest.startPerf <= recordingReadyPerf + TIMESLICE_MS;
  const endOk = final ? latest.endPerf >= win.endAt : latest.endPerf >= hi;
  if (!startOk || !endOk) return null;

  // contiguity — 선택 청크가 연속 seq, 시간 역전 없음(중간 청크 빠지면 blob 깨짐/점프).
  for (let i = 1; i < selected.length; i++) {
    if (selected[i].seq !== selected[i - 1].seq + 1) return null;
    if (selected[i].startPerf < selected[i - 1].startPerf) return null;
  }
  for (const c of selected) if (c.endPerf < c.startPerf) return null;

  // init 은 조립 시 항상 앞에 붙으므로, 선택에 포함돼도 무관(조립에서 1회 dedup).
  void initSeq;
  return selected.map((c) => c.seq);
}

/**
 * `init 청크 + (init 제외) 선택 청크` 를 한 Blob 으로 조립.
 * 선택에 initSeq 가 들어 있어도 init 은 1회만(중복 삽입 시 재생오류/초반중복 방지).
 * 참조 청크가 trim 됐으면 null(조립 불가) — 호출부는 다음 후보로.
 */
export function assembleClipBlob(
  bySeq: Map<number, RecChunk>,
  chunkSeqs: number[],
  initChunk: RecChunk,
  initSeq: number,
  mime: string
): Blob | null {
  const parts: Blob[] = [initChunk.blob];
  for (const seq of chunkSeqs) {
    if (seq === initSeq) continue;
    const c = bySeq.get(seq);
    if (!c) return null;
    parts.push(c.blob);
  }
  return new Blob(parts, { type: mime });
}

/** 32×32 휘도로 "확실히 검정" 판정(분석 실패는 fail-open=검정아님). */
function isFrameBlack(video: HTMLVideoElement): boolean {
  try {
    const w = 32;
    const h = 32;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const c = canvas.getContext("2d", { willReadFrequently: true });
    if (!c) return false;
    c.drawImage(video, 0, 0, w, h);
    const data = c.getImageData(0, 0, w, h).data;
    const n = w * h;
    let sum = 0;
    let sumSq = 0;
    for (let i = 0; i < data.length; i += 4) {
      const lum = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      sum += lum;
      sumSq += lum * lum;
    }
    const mean = sum / n;
    const variance = sumSq / n - mean * mean;
    return mean < 8 && variance < 10; // 매우 어둡고 거의 균일할 때만
  } catch {
    return false;
  }
}

/**
 * 부분(init+후속) blob 이 실제 **재생 가능 + 비검정**인지 검증.
 * 통과 = `loadeddata`/`canplay` + videoWidth/Height>0 + (muted 재생 후 대표 프레임이 비검정).
 * **duration(Infinity/NaN/0)으론 reject 안 함**(partial blob 흔함). autoplay 차단 → loadeddata 기준 통과.
 * init 초반 검정 가능성 때문에 첫 프레임만으로 reject 하지 않고 재생 후 프레임을 본다.
 * 후보별 timeout(무한대기 방지) → false(다음 후보). 성공/실패/타임아웃 모두 objectURL revoke.
 */
export function validateClip(blob: Blob, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    if (typeof document === "undefined") return resolve(false);
    let settled = false;
    let started = false;
    const url = URL.createObjectURL(blob);
    const video = document.createElement("video");
    const finish = (v: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        video.pause();
      } catch {
        /* */
      }
      video.removeAttribute("src");
      try {
        video.load();
      } catch {
        /* */
      }
      try {
        URL.revokeObjectURL(url);
      } catch {
        /* */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    const begin = () => {
      if (started) return;
      started = true;
      if (!(video.videoWidth > 0 && video.videoHeight > 0)) return finish(false);
      const grab = () => finish(!isFrameBlack(video));
      const p = video.play();
      if (p && typeof p.then === "function") {
        p.then(() => setTimeout(grab, 400)).catch(() => finish(true)); // autoplay 차단 → 통과
      } else {
        setTimeout(grab, 400);
      }
    };
    video.oncanplay = begin;
    video.onloadeddata = begin;
    video.onerror = () => finish(false);
    video.src = url;
  });
}
