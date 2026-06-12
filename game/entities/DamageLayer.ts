import { Container, FillGradient, Graphics } from "pixi.js";

/**
 * 점수가 쌓일수록 인형이 꼬질꼬질해지는 데미지 데칼 레이어.
 * Doll.bodyWrap 의 child — 낙서처럼 인형과 함께 흔들리고 던져짐.
 *
 * 자연스러움 포인트:
 *  - 멍: 반경을 랜덤으로 흔든 불규칙 폴리곤 + radial gradient (중심 진함 →
 *    가장자리 완전 투명) — 매끈한 타원/경계선 없음
 *  - 때/먼지: 가우시안 분포로 흩뿌린 수십 개의 미세 점 (스프레이 자국)
 *  - 스크래치: 살짝 휜 곡선 + 길이가 다른 보조선
 *
 * 점수 임계 (등급과 동일: 600/1500/3000/5000/8000) 를 넘을 때마다 추가,
 * 라운드 리셋 (score 0) 시 전부 제거.
 */

export const DAMAGE_THRESHOLDS = [600, 1500, 3000, 5000, 8000] as const;

export function damageLevelFor(score: number): number {
  let level = 0;
  for (const t of DAMAGE_THRESHOLDS) {
    if (score >= t) level++;
  }
  return level;
}

type IsInside = (x: number, y: number) => boolean;

/** 레벨별 추가 데칼 구성 (해당 레벨 도달 시 더해지는 양) */
const LEVEL_DECALS: { dirt: number; bruise: number; scratch: number }[] = [
  { dirt: 2, bruise: 0, scratch: 0 }, // L1 — 살짝 때
  { dirt: 2, bruise: 1, scratch: 0 }, // L2 — 멍 시작
  { dirt: 2, bruise: 2, scratch: 1 }, // L3
  { dirt: 3, bruise: 2, scratch: 2 }, // L4
  { dirt: 3, bruise: 3, scratch: 2 }, // L5 — 만신창이
];

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
  // 인접 꼭짓점 간 급격한 차이를 피하려 사인 기반 저주파 + 랜덤 고주파 혼합
  const phase = Math.random() * Math.PI * 2;
  const wob = 0.18 + Math.random() * 0.12;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const noise =
      1 +
      wob * Math.sin(a * 2 + phase) +
      (Math.random() - 0.5) * 0.22;
    pts.push(Math.cos(a) * r * noise, Math.sin(a) * r * noise);
  }
  return pts;
}

export class DamageLayer extends Container {
  private isInside: IsInside;
  /** 데칼 크기 기준 — doll naturalSize */
  private base: number;
  private level = 0;

  constructor(isInside: IsInside, naturalSize: number) {
    super();
    this.isInside = isInside;
    this.base = naturalSize;
    this.eventMode = "none";
  }

  /** 점수 변화 시 호출 — 레벨 상승분만 추가, 0 으로 떨어지면 초기화 */
  setScore(score: number) {
    const next = damageLevelFor(score);
    if (next === this.level) return;
    if (next < this.level) {
      const removed = this.removeChildren();
      for (const c of removed) c.destroy();
      this.level = 0;
      if (next === 0) return;
    }
    for (let l = this.level + 1; l <= next; l++) {
      this.addLevelDecals(LEVEL_DECALS[Math.min(l, LEVEL_DECALS.length) - 1]);
    }
    this.level = next;
  }

  private addLevelDecals(cfg: { dirt: number; bruise: number; scratch: number }) {
    for (let i = 0; i < cfg.dirt; i++) this.addDecal(this.drawDirt());
    for (let i = 0; i < cfg.bruise; i++) this.addDecal(this.drawBruise());
    for (let i = 0; i < cfg.scratch; i++) this.addDecal(this.drawScratch());
  }

  /** 실루엣 안 랜덤 위치 (rejection sampling) 에 데칼 배치 */
  private addDecal(g: Graphics) {
    const r = this.base * 0.55;
    for (let tries = 0; tries < 24; tries++) {
      const x = (Math.random() * 2 - 1) * r;
      const y = (Math.random() * 2 - 1) * r;
      if (this.isInside(x, y)) {
        g.x = x;
        g.y = y;
        g.rotation = Math.random() * Math.PI * 2;
        this.addChild(g);
        return;
      }
    }
    g.destroy(); // 자리 못 찾으면 포기 (희박)
  }

  /** 때/먼지 — 가우시안 스프레이 (중심 밀집, 외곽 희박한 미세 점들) */
  private drawDirt(): Graphics {
    const g = new Graphics();
    const spread = this.base * (0.04 + Math.random() * 0.03);
    const tones = [0x57534e, 0x6d655e, 0x7a7068];
    const count = 24 + Math.floor(Math.random() * 14);
    for (let i = 0; i < count; i++) {
      const dx = gaussian() * spread;
      const dy = gaussian() * spread * (0.7 + Math.random() * 0.5);
      const dist = Math.hypot(dx, dy) / spread; // 0(중심)~3+
      const size = Math.max(0.6, (1.9 - dist * 0.45) * (0.6 + Math.random() * 0.8));
      g.circle(dx, dy, size).fill({
        color: tones[Math.floor(Math.random() * tones.length)],
        alpha: Math.max(0.06, 0.22 - dist * 0.05),
      });
    }
    return g;
  }

  /** 멍 — 불규칙 blob + radial gradient (중심 진함 → 가장자리 완전 투명) */
  private drawBruise(): Graphics {
    const g = new Graphics();
    const r = this.base * (0.05 + Math.random() * 0.035);

    const outer = new FillGradient({
      type: "radial",
      colorStops: [
        { offset: 0, color: "rgba(107,45,92,0.30)" },
        { offset: 0.55, color: "rgba(126,58,110,0.18)" },
        { offset: 1, color: "rgba(142,69,133,0)" },
      ],
    });
    g.poly(blobPoints(r)).fill(outer);

    // 중심 코어 — 살짝 어긋난 작은 blob 한 겹 더 (얼룩덜룩함)
    const core = new FillGradient({
      type: "radial",
      colorStops: [
        { offset: 0, color: "rgba(84,32,72,0.28)" },
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
  private drawScratch(): Graphics {
    const g = new Graphics();
    const len = this.base * (0.07 + Math.random() * 0.05);
    const n = 2 + Math.floor(Math.random() * 2);
    for (let i = 0; i < n; i++) {
      const off = (i - (n - 1) / 2) * len * 0.22;
      const l = len * (0.6 + Math.random() * 0.5);
      const bend = (Math.random() - 0.5) * l * 0.4;
      g.moveTo(-l / 2, off)
        .quadraticCurveTo(0, off + bend, l / 2, off + (Math.random() - 0.5) * 6)
        .stroke({
          color: 0x3f3a36,
          width: 1 + Math.random() * 1.2,
          alpha: 0.24 + Math.random() * 0.12,
          cap: "round",
        });
    }
    return g;
  }
}
