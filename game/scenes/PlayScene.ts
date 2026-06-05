import { Container, FederatedPointerEvent, Sprite, Texture } from "pixi.js";
import { Doll } from "@/game/entities/Doll";
import { HitEffect } from "@/game/effects/HitEffect";

export type HitInfo = {
  x: number;
  y: number;
  strength: number;
};

type PlaySceneOptions = {
  dollTexture?: Texture;
  bgTexture?: Texture;
  onHit?: (info: HitInfo) => void;
};

const HIT_STRENGTH = 10;

export class PlayScene extends Container {
  private bg?: Sprite;
  private doll: Doll;
  private fx: HitEffect;
  private onHit?: (info: HitInfo) => void;

  constructor(opts: PlaySceneOptions = {}) {
    super();
    this.onHit = opts.onHit;

    if (opts.bgTexture) {
      this.bg = new Sprite(opts.bgTexture);
      this.bg.anchor.set(0.5);
      this.addChild(this.bg);
    }

    this.doll = new Doll({ texture: opts.dollTexture });
    this.addChild(this.doll);

    this.fx = new HitEffect();
    this.addChild(this.fx);

    this.doll.on("pointerdown", this.handlePointerDown);
  }

  private handlePointerDown = (e: FederatedPointerEvent) => {
    const local = this.toLocal(e.global);
    this.doll.triggerHit();
    this.fx.burst(local.x, local.y);
    this.onHit?.({ x: local.x, y: local.y, strength: HIT_STRENGTH });
  };

  /** 매 프레임 외부에서 호출. */
  update(deltaSec: number) {
    this.doll.update(deltaSec);
    this.fx.update(deltaSec);
  }

  /** 화면 크기 변경 시 호출. */
  layout(width: number, height: number) {
    if (this.bg) {
      this.bg.x = width / 2;
      this.bg.y = height / 2;
      // cover scaling — 캔버스 채우고 비율 안 맞으면 가장자리 crop
      const scale = Math.max(
        width / this.bg.texture.width,
        height / this.bg.texture.height
      );
      this.bg.scale.set(scale);
    }
    this.doll.x = width / 2;
    this.doll.y = height * 0.55;
    this.fx.x = 0;
    this.fx.y = 0;
  }

  destroy() {
    this.doll.off("pointerdown", this.handlePointerDown);
    super.destroy({ children: true });
  }
}
