import { Container, Graphics, Sprite, Texture } from "pixi.js";
import { log, errInfo } from "@/lib/log";

type DollOptions = {
  texture?: Texture;
  size?: number;
};

/**
 * 캐릭터 본체. placeholder (Graphics) 또는 AI 생성 PNG sprite.
 *
 * - bodyWrap: shake/펀치 transform 이 걸리는 내부 컨테이너. 낙서 레이어도 여기 붙음 —
 *   캐릭터가 흔들리거나 던져질 때 낙서가 같은 레이어로 함께 움직임.
 * - isInsideBody(lx, ly): bodyWrap local 좌표가 캐릭터 실루엣 안인지.
 *   AI sprite 는 PNG 알파맵 기반 (누끼 딴 실루엣 그대로), placeholder 는 도형 근사.
 */
export class Doll extends Container {
  /** 캐릭터의 base 지름 (px) — 외부에서 viewport 기반 scale 계산 시 참조 */
  public readonly naturalSize: number;
  /** AI sprite 인지 placeholder 인지 */
  public readonly isSprite: boolean;
  /** shake transform 대상 + 낙서 레이어 부착 지점 */
  public readonly bodyWrap: Container;

  private shakeTime = 0;
  private shakeIntensity = 1;

  // ── 젤리 물리 (2026-08 타격감 개편) ──────────────────────────────────
  // 방향성 스쿼시&스트레치: 타격 축으로 눌렸다가 감쇠 진동하며 복원 (인형 몸통 질감)
  private sqAmp = 0;
  private sqPhase = 0;
  private sqFreq = 9; // 진동수 (cycle/sec)
  private sqDamp = 6; // 감쇠 (1/sec)
  private sqAx = 0; // 스쿼시 축 성분 (dirX², dirY² — 축 정렬 근사)
  private sqAy = 1;
  // 회전 킥 스프링 (싸대기 — 고개가 홱 돌아갔다 복원)
  private rotOff = 0;
  private rotVel = 0;
  // 꼬집기 — 당김 벡터(로컬 px)와 비율. 활성 동안 몸이 손가락 쪽으로 늘어남
  private pinchDx = 0;
  private pinchDy = 0;
  private pinchRatio = 0;
  // 해롱해롱 — 좌우 흔들 sway
  private dazeTime = 0;
  private dazePhase = 0;
  // 부들부들 (펜 낙서 굴욕 떨림)
  private trembleTime = 0;
  private tremblePhase = 0;

  // AI sprite 의 알파맵 (실루엣 판정용)
  private alphaMap: { data: Uint8ClampedArray; w: number; h: number } | null =
    null;
  /** bodyWrap local px → texture px 변환 비율의 역수 (sprite scale) */
  private spriteScale = 1;
  /** sprite 경로일 때 원본 텍스처 — 실루엣 mask 생성용 */
  private texture: Texture | null = null;

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

  /**
   * 실루엣 모양의 mask 객체 생성 — 데칼/낙서 레이어에 적용하면
   * 캐릭터 픽셀 위에만 그려짐 (빈 공간으로 삐져나가지 않음).
   * sprite: 같은 텍스처의 Sprite (alpha mask). placeholder: 도형 근사.
   */
  makeSilhouetteMask(): Container {
    if (this.texture) {
      const m = new Sprite(this.texture);
      m.anchor.set(0.5);
      m.scale.set(this.spriteScale);
      return m;
    }
    const r = this.naturalSize / 2;
    const g = new Graphics();
    g.circle(0, 0, r).fill(0xffffff);
    g.roundRect(-r * 0.7, r * 0.55, r * 1.4, r * 0.9, 16).fill(0xffffff);
    return g;
  }

  private buildSprite(texture: Texture): Container {
    this.texture = texture;
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
      // 픽셀 단위 충돌맵 생성 실패 → 원형 fallback (게임 진행엔 무해, 정확도만 저하).
      log.warn("game.alpha_map_fail", errInfo(e));
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

  /**
   * 방향성 스쿼시 — 타격 방향(단위벡터 아님이어도 됨)으로 눌렸다가
   * 감쇠 진동으로 복원. freq/damp 로 무기별 질감 조절(뿅망치=낮은 감쇠 띠용).
   */
  hitSquash(
    dirX: number,
    dirY: number,
    intensity = 1,
    opts?: { freq?: number; damp?: number }
  ) {
    const len = Math.hypot(dirX, dirY);
    const nx = len > 0.001 ? dirX / len : 0;
    const ny = len > 0.001 ? dirY / len : 1;
    const amp = Math.min(0.42, 0.15 * Math.max(0.3, intensity));
    // 진행 중 진동보다 약한 타격은 무시(연타 중 미세 리셋으로 인한 떨림 방지)
    if (amp < this.sqAmp * 0.6) return;
    this.sqAmp = amp;
    this.sqPhase = 0;
    this.sqAx = nx * nx;
    this.sqAy = ny * ny;
    this.sqFreq = opts?.freq ?? 9;
    this.sqDamp = opts?.damp ?? 6;
  }

  /** 뿅망치 — 수직 깊은 눌림 + 낮은 감쇠(띠용용용 4~5회 바운스) */
  bounce(intensity = 1) {
    this.hitSquash(0, 1, intensity * 1.7, { freq: 7.5, damp: 2.4 });
  }

  /** 회전 킥 — 싸대기 방향으로 고개가 홱 돌아갔다 스프링 복원 */
  rotKick(amount: number) {
    this.rotVel += amount * 9;
  }

  /** 꼬집기 당김 — 로컬 px 벡터 + 비율(0..1). 몸이 손가락 쪽으로 늘어남 */
  setPinchPull(dxLocal: number, dyLocal: number, ratio: number) {
    this.pinchDx = dxLocal;
    this.pinchDy = dyLocal;
    this.pinchRatio = Math.max(0, Math.min(1, ratio));
  }

  /** 꼬집기 릴리즈 — 당김 축으로 탄성 스냅백(오버슛 진동) */
  releasePinch() {
    const r = this.pinchRatio;
    if (r > 0.03) {
      this.hitSquash(this.pinchDx, this.pinchDy, 0.6 + r * 1.6, {
        freq: 8.5,
        damp: 3.2,
      });
    }
    this.pinchRatio = 0;
    this.pinchDx = 0;
    this.pinchDy = 0;
  }

  /** 꼬집기 취소 — 점수 없이 조용히 복원 */
  cancelPinch() {
    this.pinchRatio = 0;
    this.pinchDx = 0;
    this.pinchDy = 0;
  }

  get pinching(): boolean {
    return this.pinchRatio > 0.001;
  }

  /** 해롱해롱 sway 시작(초). DazeFx(별 궤도)와 함께 사용 */
  setDazed(sec: number) {
    this.dazeTime = Math.max(this.dazeTime, sec);
  }

  /** 부들부들 떨림(초) — 펜 낙서 굴욕 리액션 */
  tremble(sec: number) {
    this.trembleTime = Math.max(this.trembleTime, sec);
  }

  /** ticker 에서 매 프레임 호출. delta 는 초 단위. 모든 리액션 transform 을 여기서 합성. */
  update(deltaSec: number) {
    let ox = 0;
    let oy = 0;
    let rot = 0;
    let sx = 1;
    let sy = 1;

    // 1) 기존 지터 + 스케일 펀치
    if (this.shakeTime > 0) {
      this.shakeTime = Math.max(0, this.shakeTime - deltaSec);
      const peak = 0.35 * this.shakeIntensity;
      const t = peak > 0 ? this.shakeTime / peak : 0;
      const amp = 8 * t * this.shakeIntensity;
      ox += (Math.random() - 0.5) * amp;
      oy += (Math.random() - 0.5) * amp;
      rot += (Math.random() - 0.5) * 0.12 * t * this.shakeIntensity;
      const punch = 1 + 0.06 * t * this.shakeIntensity;
      sx *= punch;
      sy *= punch;
    }

    // 2) 방향성 스쿼시 감쇠 진동 — 축 성분만큼 압축, 수직 축은 보존 부피처럼 팽창
    if (this.sqAmp > 0.003) {
      this.sqPhase += this.sqFreq * Math.PI * 2 * deltaSec;
      this.sqAmp *= Math.exp(-this.sqDamp * deltaSec);
      const sq = this.sqAmp * Math.cos(this.sqPhase);
      sx *= 1 - sq * this.sqAx + sq * 0.7 * this.sqAy;
      sy *= 1 - sq * this.sqAy + sq * 0.7 * this.sqAx;
    } else {
      this.sqAmp = 0;
    }

    // 3) 회전 킥 스프링 (임계 감쇠 근사)
    if (Math.abs(this.rotOff) > 1e-4 || Math.abs(this.rotVel) > 1e-4) {
      const k = 90;
      const cDamp = 13;
      this.rotVel += (-k * this.rotOff - cDamp * this.rotVel) * deltaSec;
      this.rotOff += this.rotVel * deltaSec;
      rot += this.rotOff;
    } else {
      this.rotOff = 0;
      this.rotVel = 0;
    }

    // 4) 꼬집기 늘림 — 당김 축으로 신장 + 몸이 손가락 쪽으로 끌려감
    if (this.pinchRatio > 0.001) {
      const r = this.pinchRatio;
      const len = Math.hypot(this.pinchDx, this.pinchDy) || 1;
      const nx = this.pinchDx / len;
      const ny = this.pinchDy / len;
      const ax = nx * nx;
      const ay = ny * ny;
      sx *= 1 + 0.4 * r * ax - 0.16 * r * ay;
      sy *= 1 + 0.4 * r * ay - 0.16 * r * ax;
      ox += nx * this.naturalSize * 0.13 * r;
      oy += ny * this.naturalSize * 0.13 * r;
      rot += nx * 0.1 * r * (ny < 0 ? -1 : 1);
    }

    // 5) 해롱해롱 sway
    if (this.dazeTime > 0) {
      this.dazeTime = Math.max(0, this.dazeTime - deltaSec);
      this.dazePhase += deltaSec * 4.2;
      const fade = Math.min(1, this.dazeTime / 0.4);
      rot += Math.sin(this.dazePhase * Math.PI) * 0.085 * fade;
    }

    // 6) 부들부들 (고주파 미세 떨림)
    if (this.trembleTime > 0) {
      this.trembleTime = Math.max(0, this.trembleTime - deltaSec);
      this.tremblePhase += deltaSec * 42;
      ox += Math.sin(this.tremblePhase * Math.PI * 2) * 1.7;
      rot += Math.sin(this.tremblePhase * Math.PI * 2 * 0.7) * 0.01;
    }

    this.bodyWrap.x = ox;
    this.bodyWrap.y = oy;
    this.bodyWrap.rotation = rot;
    this.bodyWrap.scale.set(sx, sy);
  }
}
