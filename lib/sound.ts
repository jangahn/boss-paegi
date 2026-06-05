/**
 * Web Audio API 기반 합성 효과음. mp3 파일 의존성 0.
 * AudioContext 는 user gesture 이후에만 생성/실행 가능 (autoplay 정책) — 첫 탭에서 lazy init.
 */

type SoundPreset = "thud" | "slap" | "clack" | "rustle";

let ctx: AudioContext | null = null;
let unlocked = false;

function getCtx() {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext;
    if (!Ctor) return null;
    ctx = new Ctor();
  }
  return ctx;
}

/**
 * 첫 user gesture (예: 페이지 진입 후 첫 탭) 후 호출.
 * iOS Safari 의 autoplay block 을 풀기 위해 ctx.resume() + silent buffer 한 번 재생.
 * resume 이 promise 라 첫 호출 시점엔 아직 suspended 일 수 있으므로 unlocked 플래그는
 * 실제 state 가 running 일 때만 set.
 */
export function unlockAudio() {
  if (unlocked) return;
  const c = getCtx();
  if (!c) return;
  // silent buffer 재생 (iOS unlock 트릭 — user gesture 안에서 실제로 음원 한 번 흘려야 함)
  try {
    const buf = c.createBuffer(1, 1, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(c.destination);
    src.start(0);
  } catch {
    /* noop */
  }
  if (c.state === "suspended") {
    c.resume()
      .then(() => {
        if (c.state === "running") unlocked = true;
      })
      .catch(() => {});
  } else {
    unlocked = true;
  }
}

function noiseBuffer(c: AudioContext, durationSec: number, gain = 1) {
  const buffer = c.createBuffer(
    1,
    Math.floor(c.sampleRate * durationSec),
    c.sampleRate
  );
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) {
    data[i] = (Math.random() * 2 - 1) * gain;
  }
  return buffer;
}

export function playHitSound(preset: SoundPreset) {
  const c = getCtx();
  if (!c) return;
  // 아직 unlock 안 됐으면 한 번 더 시도 + 이번 호출은 무음
  if (c.state !== "running") {
    if (c.state === "suspended") {
      c.resume()
        .then(() => {
          if (c.state === "running") unlocked = true;
        })
        .catch(() => {});
    }
    return;
  }
  const t = c.currentTime;

  if (preset === "thud") {
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(110, t);
    osc.frequency.exponentialRampToValueAtTime(45, t + 0.15);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.5, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.2);
    return;
  }

  if (preset === "slap") {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.12);
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2500;
    filter.Q.value = 1.2;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.55, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(filter).connect(gain).connect(c.destination);
    src.start(t);
    return;
  }

  if (preset === "clack") {
    const osc = c.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(450, t + 0.04);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.25, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain).connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.1);
    return;
  }

  if (preset === "rustle") {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.09, 0.5);
    const filter = c.createBiquadFilter();
    filter.type = "highpass";
    filter.frequency.value = 3500;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.18, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(filter).connect(gain).connect(c.destination);
    src.start(t);
    return;
  }
}
