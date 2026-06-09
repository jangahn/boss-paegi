import { Container, Graphics, Text } from "pixi.js";
import type { Body } from "matter-js";
import type { Weapon } from "@/lib/weapons";

/**
 * 던진 무기 한 발. PIXI 표시 + matter.js body 1:1 매칭.
 *
 * 라이프사이클:
 *  - 발사 → 화면 안에서 비행
 *  - 인형에 충돌 (hasHit=true) → 0.2초 잔존 (회전 멈추고 page fade) → isDead
 *  - 화면 밖 나감 → isDead
 */
export class Projectile extends Container {
  readonly body: Body;
  readonly weapon: Weapon;
  isDead = false;
  hasHit = false;
  private fadeTime = 0;
  private static readonly FADE_DURATION = 0.2;

  constructor(body: Body, weapon: Weapon) {
    super();
    this.body = body;
    this.weapon = weapon;

    const size = weapon.projectileSize ?? 48;
    const shadow = new Graphics();
    shadow.circle(0, size * 0.15, size * 0.45).fill({ color: 0x000000, alpha: 0.18 });
    this.addChild(shadow);

    const t = new Text({
      text: weapon.emoji,
      style: {
        fontSize: size,
        fill: 0xffffff,
      },
    });
    t.anchor.set(0.5);
    this.addChild(t);
  }

  /** 인형에 맞은 직후 호출 — 회전 멈추고 잠시 잔존 후 사라짐 */
  markHit() {
    this.hasHit = true;
    this.fadeTime = 0;
  }

  /** 매 프레임 — body 좌표/회전 동기화 + out-of-bounds 체크 */
  syncFromBody(viewW: number, viewH: number, deltaSec: number) {
    if (this.hasHit) {
      // hit 후엔 body 위치 따라가지만 회전 중지 + alpha fade
      this.x = this.body.position.x;
      this.y = this.body.position.y;
      this.fadeTime += deltaSec;
      const t = this.fadeTime / Projectile.FADE_DURATION;
      this.alpha = Math.max(0, 1 - t);
      this.scale.set(1 + t * 0.4);
      if (this.fadeTime >= Projectile.FADE_DURATION) {
        this.isDead = true;
      }
      return;
    }
    this.x = this.body.position.x;
    this.y = this.body.position.y;
    this.rotation = this.body.angle;
    if (
      this.body.position.y > viewH + 200 ||
      this.body.position.x < -200 ||
      this.body.position.x > viewW + 200
    ) {
      this.isDead = true;
    }
  }
}
