import {
  Container,
  Text,
  type FederatedPointerEvent,
} from "pixi.js";
import type { Weapon } from "@/lib/weapons";

type Callbacks = {
  /** 한 발 발사 — (x, y) 에서 인형을 향해. PlayScene 이 pellet 생성. */
  onFire: (info: { x: number; y: number; weapon: Weapon }) => void;
};

const FIRE_INTERVAL_SEC = 0.18;

/**
 * 비비탄총 입력 — 빈 곳을 꾹 누르고 있으면 🔫 이 인형을 자동 조준,
 * 일정 간격으로 연사. 손가락을 떼면 멈춤.
 */
export class ShootInput {
  private stage: Container;
  private cb: Callbacks;
  private active = false;
  private currentWeapon: Weapon | null = null;

  private pointerId: number | null = null;
  private holdPos = { x: 0, y: 0 };
  private fireAccum = 0;

  private gunSprite: Text;
  private hint: Text;

  constructor(stage: Container, cb: Callbacks) {
    this.stage = stage;
    this.cb = cb;
    this.gunSprite = new Text({ text: "🔫", style: { fontSize: 56 } });
    this.gunSprite.anchor.set(0.5);
    this.gunSprite.visible = false;
    this.gunSprite.eventMode = "none";
    this.hint = new Text({
      text: "빈 곳을 꾹 누르면 자동 발사",
      style: { fontSize: 13, fill: 0xffffff, align: "center" },
    });
    this.hint.anchor.set(0.5, 1);
    this.hint.alpha = 0.55;
    this.hint.visible = false;
    this.stage.addChild(this.gunSprite);
    this.stage.addChild(this.hint);
  }

  setActive(active: boolean, weapon: Weapon | null) {
    this.active = active;
    this.currentWeapon = weapon;
    if (weapon?.hint) this.hint.text = weapon.hint;
    if (!active) {
      this.cancel();
    }
    this.hint.visible = active && this.pointerId === null;
  }

  layoutHint(width: number, height: number) {
    this.hint.x = width / 2;
    this.hint.y = height - 140;
  }

  handlePointerDown = (e: FederatedPointerEvent) => {
    if (!this.active || !this.currentWeapon) return;
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    const local = this.stage.toLocal(e.global);
    this.holdPos = { x: local.x, y: local.y };
    this.gunSprite.x = local.x;
    this.gunSprite.y = local.y;
    this.gunSprite.visible = true;
    this.hint.visible = false;
    // 누르자마자 첫 발
    this.fireAccum = FIRE_INTERVAL_SEC;
  };

  handlePointerMove = (e: FederatedPointerEvent) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    const local = this.stage.toLocal(e.global);
    this.holdPos = { x: local.x, y: local.y };
    this.gunSprite.x = local.x;
    this.gunSprite.y = local.y;
  };

  handlePointerUp = (e: FederatedPointerEvent) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    this.cancel();
    this.hint.visible = this.active;
  };

  /** 매 프레임 — 조준 회전 + 연사 타이밍. (dollX, dollY) 는 인형 현재 위치. */
  update(deltaSec: number, dollX: number, dollY: number) {
    if (this.pointerId === null || !this.currentWeapon) return;
    // 🔫 이모지는 왼쪽을 향함 — 타겟 각도 + π 로 총구가 인형을 향하게.
    const angle = Math.atan2(dollY - this.holdPos.y, dollX - this.holdPos.x);
    this.gunSprite.rotation = angle + Math.PI;
    // 타겟이 오른쪽이면 회전 결과가 뒤집히므로 수직 미러로 바로 세움
    this.gunSprite.scale.y = Math.cos(angle) > 0 ? -1 : 1;

    this.fireAccum += deltaSec;
    while (this.fireAccum >= FIRE_INTERVAL_SEC) {
      this.fireAccum -= FIRE_INTERVAL_SEC;
      this.cb.onFire({
        x: this.holdPos.x,
        y: this.holdPos.y,
        weapon: this.currentWeapon,
      });
    }
  }

  cancel() {
    this.pointerId = null;
    this.fireAccum = 0;
    this.gunSprite.visible = false;
    this.gunSprite.rotation = 0;
    this.gunSprite.scale.set(1);
  }

  destroy() {
    this.gunSprite.destroy();
    this.hint.destroy();
  }
}
