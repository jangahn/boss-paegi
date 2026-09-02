import { Container, FillGradient, Graphics } from "pixi.js";

/**
 * 일시 데칼 — 손자국(싸대기)·혹(주먹/뿅망치)·홍조(꼬집기) 등 타격 리액션의
 * 시간제 흔적. decalRoot(실루엣 mask) 아래에 붙어 캐릭터 픽셀 위에만 그려지고
 * 흔들림/던지기와 함께 움직인다. DamageLayer(점수 비례 영구 꼬질)와 달리
 * TTL 페이드로 사라진다. 자체 ticker 없음 — PlayScene.update 가 구동.
 */

type DecalItem = {
  g: Graphics;
  life: number;
  ttl: number;
  baseAlpha: number;
};

const MAX_ITEMS = 60;

export class TransientDecals extends Container {
  private items: DecalItem[] = [];
  /** 데칼 크기 기준 — doll naturalSize */
  private base: number;

  constructor(naturalSize: number) {
    super();
    this.base = naturalSize;
    this.eventMode = "none";
  }

  private push(g: Graphics, x: number, y: number, ttl: number, baseAlpha: number, rotation = 0) {
    g.x = x;
    g.y = y;
    g.rotation = rotation;
    g.alpha = baseAlpha;
    this.addChild(g);
    this.items.push({ g, life: 0, ttl, baseAlpha });
    while (this.items.length > MAX_ITEMS) {
      const old = this.items.shift()!;
      this.removeChild(old.g);
      old.g.destroy();
    }
  }

  /** 빨간 손자국 — 싸대기. 손바닥 + 손가락 4개 실루엣, 스치듯 기울여 찍힘 */
  handprint(x: number, y: number, angle: number, scale = 1) {
    const g = new Graphics();
    const s = this.base * 0.09 * scale;
    const red = 0xe25555;
    // 손바닥
    g.roundRect(-s * 0.75, -s * 0.55, s * 1.5, s * 1.35, s * 0.45).fill(red);
    // 손가락 4개
    for (let i = 0; i < 4; i++) {
      const fx = -s * 0.62 + i * s * 0.42;
      const fh = s * (0.95 + (i === 1 || i === 2 ? 0.25 : 0));
      g.roundRect(fx, -s * 0.55 - fh, s * 0.3, fh + s * 0.2, s * 0.15).fill(red);
    }
    // 엄지
    g.roundRect(s * 0.62, -s * 0.35, s * 0.85, s * 0.32, s * 0.16).fill(red);
    this.push(g, x, y, 2.6, 0.42, angle);
  }

  /** 혹 — 주먹/뿅망치. 밝은 볼록 + 하이라이트 점 */
  bump(x: number, y: number, scale = 1) {
    const g = new Graphics();
    const r = this.base * 0.055 * scale;
    const grad = new FillGradient({
      type: "radial",
      colorStops: [
        { offset: 0, color: "rgba(255,214,165,0.95)" },
        { offset: 0.7, color: "rgba(240,170,120,0.75)" },
        { offset: 1, color: "rgba(240,170,120,0)" },
      ],
    });
    g.circle(0, 0, r).fill(grad);
    g.circle(-r * 0.3, -r * 0.35, r * 0.22).fill({ color: 0xffffff, alpha: 0.85 });
    this.push(g, x, y, 4.0, 0.9);
  }

  /** 홍조 — 꼬집힌 자리. 부드러운 빨간 원 (꼬집는 동안 반복 갱신) */
  blush(x: number, y: number) {
    const g = new Graphics();
    const r = this.base * 0.075;
    const grad = new FillGradient({
      type: "radial",
      colorStops: [
        { offset: 0, color: "rgba(235,88,88,0.5)" },
        { offset: 1, color: "rgba(235,88,88,0)" },
      ],
    });
    g.circle(0, 0, r).fill(grad);
    this.push(g, x, y, 1.3, 0.85);
  }

  /** 비비탄 자국 — 작은 붉은 점 (딱콩 맞은 자리) */
  welt(x: number, y: number) {
    const g = new Graphics();
    const r = this.base * 0.026;
    const grad = new FillGradient({
      type: "radial",
      colorStops: [
        { offset: 0, color: "rgba(226,72,72,0.85)" },
        { offset: 0.6, color: "rgba(226,72,72,0.45)" },
        { offset: 1, color: "rgba(226,72,72,0)" },
      ],
    });
    g.circle(0, 0, r).fill(grad);
    this.push(g, x, y, 2.6, 0.9);
  }

  clear() {
    for (const it of this.items) {
      this.removeChild(it.g);
      it.g.destroy();
    }
    this.items = [];
  }

  update(deltaSec: number) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const it = this.items[i];
      it.life += deltaSec;
      const t = it.life / it.ttl;
      if (t >= 1) {
        this.removeChild(it.g);
        it.g.destroy();
        this.items.splice(i, 1);
        continue;
      }
      // 앞 60% 유지 후 페이드
      it.g.alpha = it.baseAlpha * (t < 0.6 ? 1 : 1 - (t - 0.6) / 0.4);
    }
  }
}
