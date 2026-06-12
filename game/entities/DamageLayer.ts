import { Container, FillGradient, Graphics } from "pixi.js";

/**
 * 점수가 쌓일수록 인형이 꼬질꼬질해지는 데미지 데칼 레이어.
 * Doll.bodyWrap 의 child — 낙서처럼 인형과 함께 흔들리고 던져짐.
 *
 * 누적 규칙 (상한 없음):
 *  - 1,000점마다: 약한 꼬질 1세트 (때 + 작은 멍/스크래치)
 *  - 10,000점마다: 눈에 확 띄는 큰/진한 멍 + 넓은 얼룩
 *  - 위치는 랜덤이 아니라 "피격 부위" — PlayScene 이 noteHit() 으로 알려준
 *    최근 타격 좌표 부근 (지터 ±). 실루엣 밖이면 근처 재시도 → 랜덤 fallback
 *  - 라운드 리셋 (score 0) 시 전부 제거
 *
 * 성능 안전망: 데칼 수가 MAX_DECALS 를 넘으면 가장 오래된 것부터 제거
 * (그 수준이면 이미 포화 상태라 시각 차이 없음).
 */

export const MINOR_STEP = 1000;
export const MAJOR_STEP = 10000;
const MAX_DECALS = 400;
const RECENT_HITS_MAX = 10;

type IsInside = (x: number, y: number) => boolean;

/** 정규분포 난수 (Box-Muller) — 먼지 스프레이 분포용 */
function gaussian(): number {
  const u = Math.max(Math.random(), 1e-9);
  const v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** 반경을 랜덤으로 흔든 불규칙 blob 꼭짓점 (12~16각) */
function blobPoints(r: number): number[] {
  const n = 12 + Math.floor(Math.random() * 5);
  const pts: number[] = [];
  const phase = Math.random() * Math.PI * 2;
  const wob = 0.18 + Math.random() * 0.12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const noise =
      1 + wob * Math.sin(a * 2 + phase) + (Math.random() - 0.5) * 0.22;
    pts.push(Math.cos(a) * r * noise, Math.sin(a) * r * noise);
  }
  return pts;
}

export class DamageLayer extends Container {
  private isInside: IsInside;
  /** 데칼 크기 기준 — doll naturalSize */
  private base: number;
  private minorCount = 0;
  private majorCount = 0;
  /** 최근 피격 좌표 (bodyWrap local) — 데칼 배치 기준 */
  private recentHits: { x: number; y: number }[] = [];

  constructor(isInside: IsInside, naturalSize: number) {
    super();
    this.isInside = isInside;
    this.base = naturalSize;
    this.eventMode = "none";
  }

  /** PlayScene 이 타격마다 호출 — 피격 부위 기록 (bodyWrap local 좌표) */
  noteHit(x: number, y: number) {
    this.recentHits.push({ x, y });
    if (this.recentHits.length > RECENT_HITS_MAX) this.recentHits.shift();
  }

  /** 점수 변화 시 호출 — 1000점/10000점 단위 누적, 0 이면 초기화 */
  setScore(score: number) {
    if (score <= 0) {
      if (this.minorCount || this.majorCount) {
        const removed = this.removeChildren();
        for (const c of removed) c.destroy();
        this.minorCount = 0;
        this.majorCount = 0;
        this.recentHits = [];
      }
      return;
    }
    const minor = Math.floor(score / MINOR_STEP);
    const major = Math.floor(score / MAJOR_STEP);
    // 한 프레임에 점수가 크게 뛰어도 전부 따라잡음
    while (this.minorCount < minor) {
      this.minorCount++;
      this.addMinor();
    }
    while (this.majorCount < major) {
      this.majorCount++;
      this.addMajor();
    }
  }

  /** 약한 꼬질 1세트 — 때 + (작은 멍 | 스크래치) */
  private addMinor() {
    this.place(this.drawDirt());
    if (Math.random() < 0.55) {
      this.place(this.drawBruise(this.base * (0.045 + Math.random() * 0.03), 1));
    } else {
      this.place(this.drawScratch());
    }
  }

  /** 임팩트 꼬질 — 크고 진한 멍 + 넓은 얼룩 스프레이 */
  private addMajor() {
    // 큰 멍: 반경 ~2.5배, 진하게
    this.place(
      this.drawBruise(this.base * (0.11 + Math.random() * 0.05), 1.7)
    );
    // 주변에 넓게 퍼진 진한 때
    this.place(this.drawDirt(2.2, 1.5));
    this.place(this.drawScratch(1.6));
  }

  /**
   * 데칼 배치 — 최근 피격 부위 부근 우선, 실루엣 밖이면 재시도,
   * 기록 없거나 전부 실패하면 실루엣 안 랜덤.
   */
  private place(g: Graphics) {
    // 1) 피격 부위 + 지터
    if (this.recentHits.length > 0) {
      for (let tries = 0; tries < 10; tries++) {
        const hit =
          this.recentHits[Math.floor(Math.random() * this.recentHits.length)];
        const jitter = this.base * 0.07;
        const x = hit.x + gaussian() * jitter;
        const y = hit.y + gaussian() * jitter;
        if (this.isInside(x, y)) {
          this.attach(g, x, y);
          return;
        }
      }
    }
    // 2) 랜덤 fallback
    const r = this.base * 0.55;
    for (let tries = 0; tries < 24; tries++) {
      const x = (Math.random() * 2 - 1) * r;
      const y = (Math.random() * 2 - 1) * r;
      if (this.isInside(x, y)) {
        this.attach(g, x, y);
        return;
      }
    }
    g.destroy();
  }

  private attach(g: Graphics, x: number, y: number) {
    g.x = x;
    g.y = y;
    g.rotation = Math.random() * Math.PI * 2;
    this.addChild(g);
    // 성능 안전망 — 오래된 데칼부터 정리
    while (this.children.length > MAX_DECALS) {
      const old = this.removeChildAt(0);
      old.destroy();
    }
  }

  /** 때/먼지 — 가우시안 스프레이. scale/strength 로 major 용 확대 가능 */
  private drawDirt(scale = 1, strength = 1): Graphics {
    const g = new Graphics();
    const spread = this.base * (0.04 + Math.random() * 0.03) * scale;
    const tones = [0x57534e, 0x6d655e, 0x7a7068];
    const count = Math.round((24 + Math.floor(Math.random() * 14)) * scale);
    for (let i = 0; i < count; i++) {
      const dx = gaussian() * spread;
      const dy = gaussian() * spread * (0.7 + Math.random() * 0.5);
      const dist = Math.hypot(dx, dy) / spread;
      const size = Math.max(
        0.6,
        (1.9 - dist * 0.45) * (0.6 + Math.random() * 0.8) * scale
      );
      g.circle(dx, dy, size).fill({
        color: tones[Math.floor(Math.random() * tones.length)],
        alpha: Math.min(0.5, Math.max(0.06, 0.22 - dist * 0.05) * strength),
      });
    }
    return g;
  }

  /** 멍 — 불규칙 blob + radial gradient. r/strength 로 major 용 확대·강화 */
  private drawBruise(r: number, strength: number): Graphics {
    const g = new Graphics();
    const a = (v: number) => Math.min(0.85, v * strength);

    const outer = new FillGradient({
      type: "radial",
      colorStops: [
        { offset: 0, color: `rgba(107,45,92,${a(0.3)})` },
        { offset: 0.55, color: `rgba(126,58,110,${a(0.18)})` },
        { offset: 1, color: "rgba(142,69,133,0)" },
      ],
    });
    g.poly(blobPoints(r)).fill(outer);

    const core = new FillGradient({
      type: "radial",
      colorStops: [
        { offset: 0, color: `rgba(84,32,72,${a(0.28)})` },
        { offset: 1, color: "rgba(84,32,72,0)" },
      ],
    });
    const cg = new Graphics();
    cg.poly(blobPoints(r * 0.5)).fill(core);
    cg.x = (Math.random() - 0.5) * r * 0.5;
    cg.y = (Math.random() - 0.5) * r * 0.5;
    g.addChild(cg);
    return g;
  }

  /** 스크래치 — 살짝 휜 곡선 + 길이 다른 보조선 */
  private drawScratch(scale = 1): Graphics {
    const g = new Graphics();
    const len = this.base * (0.07 + Math.random() * 0.05) * scale;
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * len * 0.22;
      const l = len * (0.6 + Math.random() * 0.5);
      const bend = (Math.random() - 0.5) * l * 0.4;
      g.moveTo(-l / 2, off)
        .quadraticCurveTo(0, off + bend, l / 2, off + (Math.random() - 0.5) * 6)
        .stroke({
          color: 0x3f3a36,
          width: (1 + Math.random() * 1.2) * scale,
          alpha: 0.24 + Math.random() * 0.12,
          cap: "round",
        });
    }
    return g;
  }
}
