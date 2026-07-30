import { Container, Graphics } from "pixi.js";

/** 한 판이 길어져도 GPU geometry/DisplayObject 수가 유한하도록 유지한다. */
export const MAX_DRAW_SEGMENTS = 256;
export const MAX_DRAW_DOTS_PER_SEGMENT = 128;

/**
 * 펜 낙서 누적 레이어 — Doll.bodyWrap 의 child (bodyWrap local 좌표).
 * 캐릭터와 같은 레이어라 흔들림/던지기/회전 시 낙서가 함께 움직임.
 *
 * stroke 는 lastPt→현재점을 dot row 로 보간하는데, 빠른 드래그에서 두 샘플 사이
 * 직선이 실루엣의 오목한 투명 영역(목/어깨 갭 등)을 가로지를 수 있어
 * 보간 dot 각각을 isInside (PNG 알파맵) 로 재검증한다.
 */
export class DrawingLayer extends Container {
  private lastPt: { x: number; y: number } | null = null;
  private isInside: (x: number, y: number) => boolean;
  /** 비어있음 ↔ 낙서있음 전이 시에만 호출 (React picker 의 펜/지우개 토글용) */
  private onHasDrawingChange?: (hasDrawing: boolean) => void;

  constructor(
    isInside: (x: number, y: number) => boolean,
    onHasDrawingChange?: (hasDrawing: boolean) => void
  ) {
    super();
    this.isInside = isInside;
    this.onHasDrawingChange = onHasDrawingChange;
  }

  get hasDrawing(): boolean {
    return this.children.length > 0;
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
    const wasEmpty = this.children.length === 0;
    const step = Math.max(1.8, width * 0.7);
    const n = Math.min(
      MAX_DRAW_DOTS_PER_SEGMENT,
      Math.max(1, Math.ceil(dist / step)),
    );
    const r = width / 2;
    // pointer sample마다 dot별 Graphics를 만들지 않고 같은 색/폭의 점들을
    // 한 Graphics geometry로 batch한다. segment 수는 아래에서 FIFO cap.
    const segment = new Graphics();
    let dotCount = 0;
    for (let i = 1; i <= n; i++) {
      const t = i / n;
      const px = this.lastPt.x + dx * t;
      const py = this.lastPt.y + dy * t;
      if (!this.isInside(px, py)) continue; // 실루엣 밖 보간점 skip
      segment.circle(px, py, r);
      dotCount += 1;
    }
    if (dotCount > 0) {
      segment.fill(color);
      this.addChild(segment);
      while (this.children.length > MAX_DRAW_SEGMENTS) {
        const oldest = this.removeChildAt(0);
        oldest.destroy();
      }
    } else {
      segment.destroy();
    }
    this.lastPt = { x, y };
    if (wasEmpty && this.children.length > 0) {
      this.onHasDrawingChange?.(true);
    }
  }

  endStroke() {
    this.lastPt = null;
  }

  /** 낙서 전체 삭제 — 점수 영향 없음 */
  clear() {
    if (this.children.length === 0) return;
    const removed = this.removeChildren();
    for (const c of removed) c.destroy();
    this.lastPt = null;
    this.onHasDrawingChange?.(false);
  }
}
