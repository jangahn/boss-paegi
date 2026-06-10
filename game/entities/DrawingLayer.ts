import { Container, Graphics } from "pixi.js";

/**
 * 펜 낙서 누적 레이어 — Doll.bodyWrap 의 child (bodyWrap local 좌표).
 * 인형과 같은 레이어라 흔들림/던지기/회전 시 낙서가 함께 움직임.
 *
 * stroke 는 lastPt→현재점을 dot row 로 보간하는데, 빠른 드래그에서 두 샘플 사이
 * 직선이 실루엣의 오목한 투명 영역(목/어깨 갭 등)을 가로지를 수 있어
 * 보간 dot 각각을 isInside (PNG 알파맵) 로 재검증한다.
 */
export class DrawingLayer extends Container {
  private lastPt: { x: number; y: number } | null = null;
  private isInside: (x: number, y: number) => boolean;

  constructor(isInside: (x: number, y: number) => boolean) {
    super();
    this.isInside = isInside;
  }

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
      const px = this.lastPt.x + dx * t;
      const py = this.lastPt.y + dy * t;
      if (!this.isInside(px, py)) continue; // 실루엣 밖 보간점 skip
      const g = new Graphics();
      g.circle(0, 0, r).fill(color);
      g.x = px;
      g.y = py;
      this.addChild(g);
    }
    this.lastPt = { x, y };
  }

  endStroke() {
    this.lastPt = null;
  }
}
