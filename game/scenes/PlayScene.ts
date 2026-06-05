import { Container, FederatedPointerEvent, Sprite, Texture } from "pixi.js";
import { Doll } from "@/game/entities/Doll";
import { HitEffect } from "@/game/effects/HitEffect";
import { Weapon, WEAPONS } from "@/lib/weapons";
import { playHitSound, unlockAudio } from "@/lib/sound";

export type HitInfo = {
  x: number;
  y: number;
  strength: number;
  weapon: Weapon["key"];
};

type PlaySceneOptions = {
  dollTexture?: Texture;
  bgTexture?: Texture;
  weapon?: Weapon;
  onHit?: (info: HitInfo) => void;
};

export class PlayScene extends Container {
  private bg?: Sprite;
  private doll: Doll;
  private fx: HitEffect;
  private onHit?: (info: HitInfo) => void;
  private weapon: Weapon;

  constructor(opts: PlaySceneOptions = {}) {
    super();
    this.onHit = opts.onHit;
    this.weapon = opts.weapon ?? WEAPONS[0];

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

  setWeapon(w: Weapon) {
    this.weapon = w;
  }

  private handlePointerDown = (e: FederatedPointerEvent) => {
    unlockAudio(); // 첫 user gesture 에서 AudioContext 해제
    const local = this.toLocal(e.global);
    const w = this.weapon;
    this.doll.triggerHit(w.shake);
    this.fx.burst(local.x, local.y, w.particleCount, w.color);
    playHitSound(w.sound);
    this.onHit?.({ x: local.x, y: local.y, strength: w.strength, weapon: w.key });
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
      const scale = Math.max(
        width / this.bg.texture.width,
        height / this.bg.texture.height
      );
      this.bg.scale.set(scale);
    }
    this.doll.x = width / 2;
    this.doll.y = height * 0.55;
    // 화면 width 의 ~75% 목표 (=기존 50% × 1.5). 좁은 화면(320) 240, 일반 281, 큰화면 420 cap.
    // AI sprite 는 placeholder 보다 시각상 살짝 작아 보이는 경향 + 사용자 요청으로 추가 1.3 boost.
    const baseTarget = Math.min(width * 0.75, 420);
    const targetDoll = this.doll.isSprite ? baseTarget * 1.3 : baseTarget;
    this.doll.scale.set(targetDoll / this.doll.naturalSize);
    this.fx.x = 0;
    this.fx.y = 0;
  }

  destroy() {
    this.doll.off("pointerdown", this.handlePointerDown);
    super.destroy({ children: true });
  }
}
