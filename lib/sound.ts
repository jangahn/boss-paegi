/**
 * Web Audio API 기반 합성 효과음. mp3 파일 의존성 0.
 * AudioContext 는 user gesture 이후에만 생성 가능 (autoplay 정책) — 첫 탭에서 lazy init.
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

/** 첫 user gesture (ex: 첫 탭) 후 호출. iOS Safari 의 autoplay block 해제. */
export function unlockAudio() {
  if (unlocked) return;
  const c = getCtx();
  if (!c) return;
  if (c.state === "suspended") c.resume().catch(() => {});
  unlocked = true;
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
  if (!c || c.state !== "running") return;
  const t = c.currentTime;

  if (preset === "thud") {
    // 낮은 sine + 빠른 감쇠 — 주먹 펀치
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
    // 중대역 화이트노이즈 + 빠른 envelope — 짝
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
    // 짧은 고음 square — 키보드 클릭
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
    // 고음 노이즈 short burst — 종이
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
