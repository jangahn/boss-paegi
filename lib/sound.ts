/**
 * Web Audio API 기반 합성 효과음. mp3 파일 의존성 0.
 * AudioContext 는 user gesture 이후에만 생성/실행 가능 (autoplay 정책) — 첫 탭에서 lazy init.
 */

type SoundPreset =
  | "punch"
  | "boing"
  | "slap"
  | "thud"
  | "clack"
  | "rustle"
  | "pew"
  | "pop"
  | "whoosh"
  | "scribble";

let ctx: AudioContext | null = null;
let unlocked = false;
let master: GainNode | null = null;
let recordDest: MediaStreamAudioDestinationNode | null = null;

// ── 음소거 토글 (master gain 0/1) — master 가 recordDest 까지 합류하므로 녹화 음성도 함께 무음 ──
const MUTED_KEY = "boss-paegi:sound:muted";
let muted = false;
let mutedLoaded = false;
/** 첫 사운드/master 생성 전에 localStorage 저장값을 상태에 반영(SSR-safe lazy). */
function ensureMutedLoaded(): void {
  if (mutedLoaded || typeof window === "undefined") return;
  mutedLoaded = true;
  try {
    muted = localStorage.getItem(MUTED_KEY) === "true";
  } catch {
    /* localStorage 불가 — 기본 ON(muted=false) */
  }
}

export function isMuted(): boolean {
  ensureMutedLoaded();
  return muted;
}

/** 음소거 on/off. master 가 아직 없어도 상태 보관 → out() 생성 시 즉시 반영. */
export function setMuted(m: boolean): void {
  ensureMutedLoaded();
  muted = m;
  try {
    localStorage.setItem(MUTED_KEY, m ? "true" : "false");
  } catch {
    /* 저장 실패 무시 */
  }
  const c = getCtx();
  if (c && master) master.gain.setValueAtTime(m ? 0 : 1, c.currentTime);
}

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
 * 모든 효과음이 거치는 마스터 버스 (→ 스피커 + 하이라이트 녹화 탭).
 * 기존엔 각 사운드가 c.destination 에 직접 연결돼 캡처 지점이 없었음.
 */
function out(c: AudioContext): AudioNode {
  if (!master) {
    ensureMutedLoaded();
    master = c.createGain();
    master.gain.value = muted ? 0 : 1; // 저장된 음소거 상태를 첫 사운드부터 반영
    master.connect(c.destination);
  }
  return master;
}

/**
 * 하이라이트 녹화용 오디오 MediaStream — 마스터 버스를 탭해서 게임 효과음을 캡처.
 * recordDest 는 **lazy singleton**, master→recordDest 연결은 **1회만**.
 * 반환된 audio track 은 다음 녹화에서 재사용하므로 **stop 하면 안 됨**(stop 시 이후 무음).
 * AudioContext/지원 없으면 null → 호출부는 video-only 로 폴백.
 */
export function getRecordingStream(): MediaStream | null {
  const c = getCtx();
  if (!c) return null;
  try {
    out(c); // master 보장
    if (!recordDest) {
      recordDest = c.createMediaStreamDestination();
      master!.connect(recordDest);
    }
    return recordDest.stream;
  } catch {
    return null;
  }
}

/**
 * 첫 user gesture (예: 페이지 진입 후 첫 탭) 후 호출.
 * iOS Safari 의 autoplay block 을 풀기 위해 ctx.resume() + silent buffer 한 번 재생.
 */
export function unlockAudio() {
  if (unlocked) return;
  const c = getCtx();
  if (!c) return;
  try {
    const buf = c.createBuffer(1, 1, c.sampleRate);
    const src = c.createBufferSource();
    src.buffer = buf;
    src.connect(out(c));
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

/**
 * @param volume 0~2. 타격 속도/세기에 비례해 호출자가 조절. 기본 1.
 */
export function playHitSound(preset: SoundPreset, volume = 1) {
  const c = getCtx();
  if (!c) return;
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
  const v = Math.max(0.05, Math.min(2, volume));

  if (preset === "punch") {
    // 퍽퍽 — 깊은 sine drop + 저역 noise 펀치 + 시작 클릭. 매 타 ±8% 디튠으로 찰지게.
    const detune = 0.92 + Math.random() * 0.16;
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(105 * detune, t);
    osc.frequency.exponentialRampToValueAtTime(38, t + 0.13);
    const og = c.createGain();
    og.gain.setValueAtTime(0.65 * v, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.16);
    osc.connect(og).connect(out(c));
    osc.start(t);
    osc.stop(t + 0.18);

    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.09, 0.9);
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 320 * detune;
    filter.Q.value = 1.1;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.55 * v, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(filter).connect(ng).connect(out(c));
    src.start(t);

    // 시작 클릭 (타격 순간 어택감)
    const click = c.createBufferSource();
    click.buffer = noiseBuffer(c, 0.012, 0.7);
    const cf = c.createBiquadFilter();
    cf.type = "bandpass";
    cf.frequency.value = 1500;
    const cg = c.createGain();
    cg.gain.setValueAtTime(0.3 * v, t);
    cg.gain.exponentialRampToValueAtTime(0.001, t + 0.015);
    click.connect(cf).connect(cg).connect(out(c));
    click.start(t);
    return;
  }

  if (preset === "boing") {
    // 뿅망치 — 만화 스프링. 위로 휙 올라갔다 내려오는 pitch 곡선.
    const detune = 0.92 + Math.random() * 0.16;
    const osc = c.createOscillator();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(260 * detune, t);
    osc.frequency.exponentialRampToValueAtTime(820 * detune, t + 0.04);
    osc.frequency.exponentialRampToValueAtTime(170, t + 0.22);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.4 * v, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    osc.connect(gain).connect(out(c));
    osc.start(t);
    osc.stop(t + 0.27);
    return;
  }

  if (preset === "pew") {
    // 비비탄 발사 — 짧은 하강 블립
    const osc = c.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(1400, t);
    osc.frequency.exponentialRampToValueAtTime(420, t + 0.07);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.12 * v, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain).connect(out(c));
    osc.start(t);
    osc.stop(t + 0.09);
    return;
  }

  if (preset === "pop") {
    // 비비탄 명중 — 짧은 노이즈 팝 + 저역 톡
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.04, 0.8);
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 1100;
    filter.Q.value = 1.8;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.3 * v, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.04);
    src.connect(filter).connect(ng).connect(out(c));
    src.start(t);

    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(300, t);
    osc.frequency.exponentialRampToValueAtTime(120, t + 0.05);
    const og = c.createGain();
    og.gain.setValueAtTime(0.2 * v, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    osc.connect(og).connect(out(c));
    osc.start(t);
    osc.stop(t + 0.07);
    return;
  }

  if (preset === "slap") {
    const detune = 0.9 + Math.random() * 0.2;
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.12);
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 2500 * detune;
    filter.Q.value = 1.2;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.55 * v, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(filter).connect(gain).connect(out(c));
    src.start(t);
    return;
  }

  if (preset === "thud") {
    // 둔탁 — 책/키보드 임팩트. punch 보다 더 깊고 길게.
    const osc = c.createOscillator();
    osc.type = "sine";
    osc.frequency.setValueAtTime(82, t);
    osc.frequency.exponentialRampToValueAtTime(32, t + 0.2);
    const og = c.createGain();
    og.gain.setValueAtTime(0.75 * v, t);
    og.gain.exponentialRampToValueAtTime(0.001, t + 0.24);
    osc.connect(og).connect(out(c));
    osc.start(t);
    osc.stop(t + 0.26);

    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.12, 0.8);
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 220;
    const ng = c.createGain();
    ng.gain.setValueAtTime(0.5 * v, t);
    ng.gain.exponentialRampToValueAtTime(0.001, t + 0.12);
    src.connect(filter).connect(ng).connect(out(c));
    src.start(t);
    return;
  }

  if (preset === "clack") {
    const osc = c.createOscillator();
    osc.type = "square";
    osc.frequency.setValueAtTime(900, t);
    osc.frequency.exponentialRampToValueAtTime(450, t + 0.04);
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.25 * v, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
    osc.connect(gain).connect(out(c));
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
    gain.gain.setValueAtTime(0.18 * v, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.09);
    src.connect(filter).connect(gain).connect(out(c));
    src.start(t);
    return;
  }

  if (preset === "whoosh") {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.25, 0.8);
    const filter = c.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + 0.22);
    filter.Q.value = 0.7;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.35 * v, t + 0.04);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
    src.connect(filter).connect(gain).connect(out(c));
    src.start(t);
    return;
  }

  if (preset === "scribble") {
    const src = c.createBufferSource();
    src.buffer = noiseBuffer(c, 0.06, 0.6);
    const filter = c.createBiquadFilter();
    filter.type = "bandpass";
    filter.frequency.value = 5500;
    filter.Q.value = 2.0;
    const gain = c.createGain();
    gain.gain.setValueAtTime(0.12 * v, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
    src.connect(filter).connect(gain).connect(out(c));
    src.start(t);
    return;
  }
}
