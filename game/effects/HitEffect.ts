import { Container, Graphics, Text } from "pixi.js";

type Particle = {
  g: Graphics;
  vx: number;
  vy: number;
  life: number;
  ttl: number;
};

type Shockwave = {
  g: Graphics;
  life: number;
  ttl: number;
  startR: number;
  endR: number;
  color: number;
};

type ScorePop = {
  g: Container;
  life: number;
  ttl: number;
  vy: number;
};

const DEFAULT_COLORS = [0xffd166, 0xef476f, 0xff9f1c, 0xfdf6e3];

/**
 * 일회성 파티클 + shockwave + score popup. 자체 ticker 없음 — 외부 update(delta).
 */
export class HitEffect extends Container {
  private particles: Particle[] = [];
  private shockwaves: Shockwave[] = [];
  private scorePops: ScorePop[] = [];

  burst(x: number, y: number, count = 10, baseColor?: number) {
    const palette = baseColor !== undefined
      ? [baseColor, baseColor, ...DEFAULT_COLORS]
      : DEFAULT_COLORS;
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      const r = 4 + Math.random() * 6;
      g.circle(0, 0, r).fill(palette[i % palette.length]);
      g.x = x;
      g.y = y;
      this.addChild(g);

      const angle = Math.random() * Math.PI * 2;
      const speed = 200 + Math.random() * 250;
      this.particles.push({
        g,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 180,
        life: 0,
        ttl: 0.6 + Math.random() * 0.3,
      });
    }
  }

  /** 임팩트 — 큰 ring 1개 + 발산 페이드. 타격감 강조용. */
  shockwave(x: number, y: number, startR = 20, endR = 140, color = 0xffffff) {
    const g = new Graphics();
    g.x = x;
    g.y = y;
    this.addChild(g);
    this.shockwaves.push({ g, life: 0, ttl: 0.35, startR, endR, color });
  }

  /** +N 점수 popup — 위로 떠오르며 페이드. */
  scorePop(x: number, y: number, points: number, color = 0xffd166) {
    const wrap = new Container();
    wrap.x = x;
    wrap.y = y;
    const t = new Text({
      text: `+${points}`,
      style: {
        fontSize: 22,
        fontWeight: "900",
        fill: color,
        stroke: { color: 0x000000, width: 4 },
      },
    });
    t.anchor.set(0.5);
    wrap.addChild(t);
    this.addChild(wrap);
    this.scorePops.push({ g: wrap, life: 0, ttl: 0.7, vy: -120 });
  }

  update(deltaSec: number) {
    const gravity = 900;
    for (let i = this.particles.length - 1; i >= 0; i--) {
      const p = this.particles[i];
      p.life += deltaSec;
      if (p.life >= p.ttl) {
        this.removeChild(p.g);
        p.g.destroy();
        this.particles.splice(i, 1);
        continue;
      }
      p.vy += gravity * deltaSec;
      p.g.x += p.vx * deltaSec;
      p.g.y += p.vy * deltaSec;
      p.g.alpha = 1 - p.life / p.ttl;
    }

    for (let i = this.shockwaves.length - 1; i >= 0; i--) {
      const s = this.shockwaves[i];
      s.life += deltaSec;
      const t = s.life / s.ttl;
      if (t >= 1) {
        this.removeChild(s.g);
        s.g.destroy();
        this.shockwaves.splice(i, 1);
        continue;
      }
      const r = s.startR + (s.endR - s.startR) * t;
      s.g.clear();
      s.g.circle(0, 0, r).stroke({ color: s.color, width: 6 * (1 - t), alpha: 1 - t });
    }

    for (let i = this.scorePops.length - 1; i >= 0; i--) {
      const p = this.scorePops[i];
      p.life += deltaSec;
      const t = p.life / p.ttl;
      if (t >= 1) {
        this.removeChild(p.g);
        p.g.destroy({ children: true });
        this.scorePops.splice(i, 1);
        continue;
      }
      p.g.y += p.vy * deltaSec;
      p.vy *= 0.93;
      p.g.alpha = 1 - t * t;
      p.g.scale.set(1 + t * 0.3);
    }
  }
}
