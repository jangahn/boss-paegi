import { Container, Graphics } from "pixi.js";

/**
 * 펜 낙서 누적 — HitEffect.burst 와 동일 패턴 (graphic 의 local 0,0 + position x,y).
 * 각 dot 마다 새 Graphics 한 개. PIXI v8 환경에서 이게 가장 신뢰성 있음.
 */
export class DrawingLayer extends Container {
  private lastPt: { x: number; y: number } | null = null;

  beginStroke(x: number, y: number) {
    this.lastPt = { x, y };
  }

  extendStroke(x: number, y: number, color: number, width: number) {
    if (!this.lastPt) {
      this.lastPt = { x, y };
      return;
    }
    const dx = x - this.lastPt.x;
    const dy = y - this.lastPt.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.5) {
      this.lastPt = { x, y };
      return;
    }
    const step = Math.max(1.8, width * 0.7);
    const n = Math.max(1, Math.ceil(dist / step));
    const r = width / 2;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const g = new Graphics();
      g.circle(0, 0, r).fill(color);
      g.x = this.lastPt.x + dx * t;
      g.y = this.lastPt.y + dy * t;
      this.addChild(g);
    }
    this.lastPt = { x, y };
  }

  endStroke() {
    this.lastPt = null;
  }
}
