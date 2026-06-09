import { Container, Graphics, Sprite, Texture } from "pixi.js";

type DollOptions = {
  texture?: Texture;
  size?: number;
};

/**
 * 인형 본체. M2 단계에선 PIXI.Graphics 로 그린 placeholder 얼굴.
 * M3+ 에서 AI 생성 이미지를 texture 로 받아 sprite 로 교체.
 *
 * v0.4: matter.js body 와 분리. PlayScene 이 body.position 을 매 프레임 doll.x/y 에 sync.
 * shake 는 internal body container 의 미세 진동으로만 (위치 자체는 물리 결과).
 */
export class Doll extends Container {
  /** 인형의 base 지름 (px) — 외부에서 viewport 기반 scale 계산 시 참조 */
  public readonly naturalSize: number;
  /** AI sprite 인지 placeholder 인지. PlayScene 이 sizeBoost 결정에 활용. */
  public readonly isSprite: boolean;
  /** 낙서 layer 가 부착될 컨테이너 — body 와 같은 transform 따라감 */
  public readonly bodyWrap: Container;
  private shakeTime = 0;

  constructor(opts: DollOptions = {}) {
    super();
    this.isSprite = !!opts.texture;
    // placeholder: 머리+셔츠+넥타이 합쳐 240 base. AI sprite: frame 200 base (캐릭터는 그 안 ~77%).
    this.naturalSize = opts.size ?? (this.isSprite ? 200 : 240);
    this.bodyWrap = opts.texture
      ? this.buildSprite(opts.texture)
      : this.buildPlaceholder();
    this.addChild(this.bodyWrap);

    this.eventMode = "static";
    this.cursor = "pointer";
    this.hitArea = {
      contains: (x, y) => {
        const r = this.naturalSize / 2;
        return x * x + y * y <= r * r;
      },
    };
  }

  private buildSprite(texture: Texture): Container {
    const wrap = new Container();
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    const scale = this.naturalSize / Math.max(texture.width, texture.height);
    sprite.scale.set(scale);
    wrap.addChild(sprite);
    return wrap;
  }

  private buildPlaceholder(): Container {
    const wrap = new Container();
    const r = this.naturalSize / 2;

    const shirt = new Graphics();
    shirt.roundRect(-r * 0.7, r * 0.55, r * 1.4, r * 0.9, 16);
    shirt.fill(0x2f3a4d);
    wrap.addChild(shirt);

    const tie = new Graphics();
    tie.poly([0, r * 0.55, r * 0.15, r * 0.7, 0, r * 1.3, -r * 0.15, r * 0.7]);
    tie.fill(0xd94545);
    wrap.addChild(tie);

    const head = new Graphics();
    head.circle(0, 0, r);
    head.fill(0xf2d2a0);
    head.stroke({ color: 0x000000, width: 3, alpha: 0.15 });
    wrap.addChild(head);

    const hair = new Graphics();
    hair.arc(0, -r * 0.1, r * 0.95, Math.PI * 1.05, Math.PI * 1.95);
    hair.lineTo(r * 0.65, -r * 0.1);
    hair.arc(0, -r * 0.1, r * 0.65, Math.PI * 1.95, Math.PI * 1.05, true);
    hair.fill(0x2a1a14);
    wrap.addChild(hair);

    const brows = new Graphics();
    brows.moveTo(-r * 0.45, -r * 0.2).lineTo(-r * 0.15, -r * 0.1);
    brows.moveTo(r * 0.15, -r * 0.1).lineTo(r * 0.45, -r * 0.2);
    brows.stroke({ color: 0x111111, width: 6, cap: "round" });
    wrap.addChild(brows);

    const eyes = new Graphics();
    eyes.circle(-r * 0.3, r * 0.02, r * 0.06).fill(0x111111);
    eyes.circle(r * 0.3, r * 0.02, r * 0.06).fill(0x111111);
    wrap.addChild(eyes);

    const mouth = new Graphics();
    mouth
      .moveTo(-r * 0.25, r * 0.35)
      .quadraticCurveTo(0, r * 0.25, r * 0.25, r * 0.35);
    mouth.stroke({ color: 0x111111, width: 5, cap: "round" });
    wrap.addChild(mouth);

    return wrap;
  }

  private shakeIntensity = 1;

  /** 피격 시 호출 — 흔들림/스케일 펀치 시작. intensity 1.0 = 기본, 1.5 = 더 큰 흔들림 */
  triggerHit(intensity = 1) {
    this.shakeTime = 0.35 * Math.max(0.5, intensity);
    this.shakeIntensity = intensity;
  }

  /** ticker 에서 매 프레임 호출. delta 는 초 단위. */
  update(deltaSec: number) {
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - deltaSec);
      const peak = 0.35 * this.shakeIntensity;
      const t = peak > 0 ? this.shakeTime / peak : 0;
      const amp = 8 * t * this.shakeIntensity;
      this.bodyWrap.x = (Math.random() - 0.5) * amp;
      this.bodyWrap.y = (Math.random() - 0.5) * amp;
      this.bodyWrap.rotation = (Math.random() - 0.5) * 0.12 * t * this.shakeIntensity;
      const punch = 1 + 0.06 * t * this.shakeIntensity;
      this.bodyWrap.scale.set(punch);
    } else {
      this.bodyWrap.x = 0;
      this.bodyWrap.y = 0;
      this.bodyWrap.rotation = 0;
      this.bodyWrap.scale.set(1);
    }
  }
}
