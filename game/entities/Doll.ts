import { Container, Graphics, Sprite, Texture } from "pixi.js";

type DollOptions = {
  texture?: Texture;
  size?: number;
};

/**
 * 인형 본체. placeholder (Graphics) 또는 AI 생성 PNG sprite.
 *
 * - bodyWrap: shake/펀치 transform 이 걸리는 내부 컨테이너. 낙서 레이어도 여기 붙음 —
 *   인형이 흔들리거나 던져질 때 낙서가 같은 레이어로 함께 움직임.
 * - isInsideBody(lx, ly): bodyWrap local 좌표가 캐릭터 실루엣 안인지.
 *   AI sprite 는 PNG 알파맵 기반 (누끼 딴 실루엣 그대로), placeholder 는 도형 근사.
 */
export class Doll extends Container {
  /** 인형의 base 지름 (px) — 외부에서 viewport 기반 scale 계산 시 참조 */
  public readonly naturalSize: number;
  /** AI sprite 인지 placeholder 인지 */
  public readonly isSprite: boolean;
  /** shake transform 대상 + 낙서 레이어 부착 지점 */
  public readonly bodyWrap: Container;

  private shakeTime = 0;
  private shakeIntensity = 1;

  // AI sprite 의 알파맵 (실루엣 판정용)
  private alphaMap: { data: Uint8ClampedArray; w: number; h: number } | null =
    null;
  /** bodyWrap local px → texture px 변환 비율의 역수 (sprite scale) */
  private spriteScale = 1;

  constructor(opts: DollOptions = {}) {
    super();
    this.isSprite = !!opts.texture;
    // placeholder: 머리+셔츠+넥타이 합쳐 240 base. AI sprite: frame 200 base.
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

  /** bodyWrap local 좌표 (lx, ly) 가 캐릭터 실루엣 안인지 */
  isInsideBody(lx: number, ly: number): boolean {
    if (this.alphaMap) {
      const { data, w, h } = this.alphaMap;
      const tx = Math.round(lx / this.spriteScale + w / 2);
      const ty = Math.round(ly / this.spriteScale + h / 2);
      if (tx < 0 || ty < 0 || tx >= w || ty >= h) return false;
      return data[(ty * w + tx) * 4 + 3] >= 48;
    }
    if (this.isSprite) {
      // 알파맵 추출 실패 fallback — face circle 근사
      const r = this.naturalSize * 0.45;
      return lx * lx + ly * ly <= r * r;
    }
    // placeholder: 머리 circle + 셔츠 rect 근사
    const r = this.naturalSize / 2;
    if (lx * lx + ly * ly <= r * r) return true;
    return Math.abs(lx) <= r * 0.7 && ly >= r * 0.55 && ly <= r * 1.45;
  }

  private buildSprite(texture: Texture): Container {
    const wrap = new Container();
    const sprite = new Sprite(texture);
    sprite.anchor.set(0.5);
    const scale = this.naturalSize / Math.max(texture.width, texture.height);
    sprite.scale.set(scale);
    this.spriteScale = scale;
    wrap.addChild(sprite);
    this.buildAlphaMap(texture);
    return wrap;
  }

  /** PNG 알파 채널을 한 번 읽어 실루엣 맵 생성. 실패 시 circle fallback. */
  private buildAlphaMap(texture: Texture) {
    try {
      const tw = Math.max(1, Math.round(texture.width));
      const th = Math.max(1, Math.round(texture.height));
      const canvas = document.createElement("canvas");
      canvas.width = tw;
      canvas.height = th;
      const c2d = canvas.getContext("2d", { willReadFrequently: true });
      if (!c2d) return;
      c2d.drawImage(
        texture.source.resource as CanvasImageSource,
        0,
        0,
        tw,
        th
      );
      const img = c2d.getImageData(0, 0, tw, th);
      this.alphaMap = { data: img.data, w: tw, h: th };
    } catch (e) {
      console.warn("[doll] alpha map build failed — circle fallback:", e);
      this.alphaMap = null;
    }
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

  /** 피격 시 호출 — 흔들림/스케일 펀치 시작. intensity 1.0 = 기본 */
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
      this.bodyWrap.rotation =
        (Math.random() - 0.5) * 0.12 * t * this.shakeIntensity;
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
