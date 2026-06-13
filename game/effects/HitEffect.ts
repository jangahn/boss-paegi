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

type PaperPiece = {
  g: Graphics;
  vx: number;
  vy: number;
  spin: number;
  wobblePhase: number;
  life: number;
  ttl: number;
};

type EmojiPop = {
  t: Text;
  life: number;
  ttl: number;
  /** true 면 -0.9rad 에서 0 으로 휘두르는 스윙 (뿅망치) */
  swing: boolean;
};

type Flash = {
  g: Graphics;
  life: number;
  ttl: number;
  peak: number;
};

const DEFAULT_COLORS = [0xffd166, 0xef476f, 0xff9f1c, 0xfdf6e3];

/**
 * 일회성 파티클 + shockwave + score popup. 자체 ticker 없음 — 외부 update(delta).
 */
export class HitEffect extends Container {
  private particles: Particle[] = [];
  private shockwaves: Shockwave[] = [];
  private scorePops: ScorePop[] = [];
  private paperPieces: PaperPiece[] = [];
  private emojiPops: EmojiPop[] = [];
  private flashes: Flash[] = [];

  /** 화면 전체 플래시 — 궁극기 마무리 등 임팩트용 (좌표 0,0 ~ viewW,viewH) */
  flash(viewW: number, viewH: number, color = 0xffffff, peak = 0.7, ttl = 0.4) {
    const g = new Graphics();
    g.rect(0, 0, viewW, viewH).fill(color);
    g.alpha = peak;
    this.addChild(g);
    this.flashes.push({ g, life: 0, ttl, peak });
  }

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

  /** 종이 흩뿌려짐 — 흰 조각들이 팔랑팔랑 흩어지며 낙하. */
  paperScatter(x: number, y: number, count = 10) {
    for (let i = 0; i < count; i++) {
      const g = new Graphics();
      const w = 8 + Math.random() * 10;
      const h = 10 + Math.random() * 14;
      g.roundRect(-w / 2, -h / 2, w, h, 2).fill({
        color: 0xffffff,
        alpha: 0.95,
      });
      g.x = x;
      g.y = y;
      g.rotation = Math.random() * Math.PI * 2;
      this.addChild(g);

      const angle = Math.random() * Math.PI * 2;
      const speed = 120 + Math.random() * 220;
      this.paperPieces.push({
        g,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 120,
        spin: (Math.random() - 0.5) * 10,
        wobblePhase: Math.random() * Math.PI * 2,
        life: 0,
        ttl: 0.9 + Math.random() * 0.6,
      });
    }
  }

  /** 타격 지점에 무기 이모지가 뿅 나타났다 사라짐 (주먹/뿅망치 등) */
  emojiPop(
    x: number,
    y: number,
    emoji: string,
    opts?: { size?: number; swing?: boolean }
  ) {
    const t = new Text({
      text: emoji,
      style: { fontSize: opts?.size ?? 56 },
    });
    t.anchor.set(0.5);
    t.x = x;
    t.y = y;
    t.scale.set(0.5);
    if (opts?.swing) t.rotation = -0.9;
    this.addChild(t);
    this.emojiPops.push({ t, life: 0, ttl: 0.32, swing: !!opts?.swing });
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

    for (let i = this.emojiPops.length - 1; i >= 0; i--) {
      const p = this.emojiPops[i];
      p.life += deltaSec;
      const t = p.life / p.ttl;
      if (t >= 1) {
        this.removeChild(p.t);
        p.t.destroy();
        this.emojiPops.splice(i, 1);
        continue;
      }
      // scale 0.5 → 1.15 (ease-out), 마지막 40% 페이드
      const grow = 1 - Math.pow(1 - Math.min(1, t / 0.6), 2);
      p.t.scale.set(0.5 + 0.65 * grow);
      if (p.swing) {
        p.t.rotation = -0.9 * (1 - Math.min(1, t / 0.55));
      }
      p.t.alpha = t > 0.6 ? 1 - (t - 0.6) / 0.4 : 1;
    }

    for (let i = this.paperPieces.length - 1; i >= 0; i--) {
      const p = this.paperPieces[i];
      p.life += deltaSec;
      const t = p.life / p.ttl;
      if (t >= 1) {
        this.removeChild(p.g);
        p.g.destroy();
        this.paperPieces.splice(i, 1);
        continue;
      }
      // 팔랑팔랑 — 낮은 중력 + 좌우 wobble + 공기저항
      p.vy += 320 * deltaSec;
      p.vx *= 0.985;
      p.vy *= 0.985;
      p.wobblePhase += deltaSec * 7;
      p.g.x += (p.vx + Math.sin(p.wobblePhase) * 60) * deltaSec;
      p.g.y += p.vy * deltaSec;
      p.g.rotation += p.spin * deltaSec;
      p.g.alpha = 1 - t * t;
    }

    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life += deltaSec;
      const t = f.life / f.ttl;
      if (t >= 1) {
        this.removeChild(f.g);
        f.g.destroy();
        this.flashes.splice(i, 1);
        continue;
      }
      f.g.alpha = f.peak * (1 - t);
    }
  }
}
