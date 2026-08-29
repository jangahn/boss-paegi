import { Container, Graphics } from "pixi.js";

/**
 * 해롱해롱 상태 연출 — 캐릭터 머리 위를 도는 별 3개 (만화식 기절 표현).
 * Doll(스케일 적용 컨테이너)의 child 로 붙여 머리 위 타원 궤도를 공전.
 * bodyWrap 이 아닌 Doll 에 붙어 타격 지터에 같이 떨리지 않는다.
 * 자체 ticker 없음 — PlayScene.update 가 update(delta) 호출.
 */

/** 5각 별 꼭짓점 (외경 r) */
function starPoints(r: number): number[] {
  const pts: number[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.45;
    const a = (i / 10) * Math.PI * 2 - Math.PI / 2;
    pts.push(Math.cos(a) * rad, Math.sin(a) * rad);
  }
  return pts;
}

export class DazeFx extends Container {
  private stars: Graphics[] = [];
  private time = 0;
  private phase = 0;
  /** 궤도 반경 기준 — doll naturalSize */
  private base: number;

  constructor(naturalSize: number) {
    super();
    this.base = naturalSize;
    this.eventMode = "none";
    this.visible = false;
    this.y = -naturalSize * 0.62;
    for (let i = 0; i < 3; i++) {
      const g = new Graphics();
      g.poly(starPoints(naturalSize * 0.07)).fill(0xffd166);
      g.poly(starPoints(naturalSize * 0.035)).fill(0xfff3c4);
      this.addChild(g);
      this.stars.push(g);
    }
  }

  get active(): boolean {
    return this.time > 0;
  }

  /** 해롱 시작(초). 진행 중이면 연장. */
  start(sec: number) {
    this.time = Math.max(this.time, sec);
    this.visible = true;
  }

  stop() {
    this.time = 0;
    this.visible = false;
  }

  update(deltaSec: number) {
    if (this.time <= 0) {
      if (this.visible) this.visible = false;
      return;
    }
    this.time = Math.max(0, this.time - deltaSec);
    this.phase += deltaSec * 3.4;
    const fade = Math.min(1, this.time / 0.35);
    const rx = this.base * 0.36;
    const ry = this.base * 0.13;
    this.stars.forEach((g, i) => {
      const a = this.phase + (i / this.stars.length) * Math.PI * 2;
      g.x = Math.cos(a) * rx;
      g.y = Math.sin(a) * ry;
      g.rotation = a * 1.6;
      // 궤도 뒤쪽(위)을 돌 땐 살짝 작게 — 얕은 3D 느낌
      const depth = 0.75 + 0.25 * ((Math.sin(a) + 1) / 2);
      g.scale.set(depth);
      g.alpha = fade * (0.75 + 0.25 * depth);
    });
  }
}
