import {
  Container,
  Text,
  type FederatedPointerEvent,
} from "pixi.js";
import type { Weapon } from "@/lib/weapons";
import type { DrawingLayer } from "@/game/entities/DrawingLayer";

type Callbacks = {
  onStroke: (length: number, weapon: Weapon) => void;
};

type IsInsideFn = (sx: number, sy: number) => boolean;

/**
 * 펜 낙서 입력. 활성 시 stage 의 pointer 를 trace 해 DrawingLayer 에 누적.
 * 좌표는 stage local. inside 체크는 외부에서 주입 (PlayScene 이 dollBody 위치 + scaled radius 기반 closure).
 */
export class DrawInput {
  private stage: Container;
  private layer: DrawingLayer;
  private cb: Callbacks;
  private isInsideFn: IsInsideFn;
  private active = false;
  private currentWeapon: Weapon | null = null;
  private pointerId: number | null = null;
  private accumDist = 0;
  private lastLocal: { x: number; y: number } | null = null;
  private wasInside = false;
  private hint: Text;

  constructor(
    stage: Container,
    layer: DrawingLayer,
    isInside: IsInsideFn,
    cb: Callbacks
  ) {
    this.stage = stage;
    this.layer = layer;
    this.isInsideFn = isInside;
    this.cb = cb;
    this.hint = new Text({
      text: "얼굴에 낙서",
      style: { fontSize: 13, fill: 0xffffff },
    });
    this.hint.anchor.set(0.5, 1);
    this.hint.alpha = 0.55;
    this.hint.visible = false;
    this.stage.addChild(this.hint);
  }

  setActive(active: boolean, weapon: Weapon | null) {
    this.active = active;
    this.currentWeapon = weapon;
    if (!active) {
      this.endIfActive();
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
    this.lastLocal = { x: local.x, y: local.y };
    this.accumDist = 0;
    this.wasInside = this.isInsideFn(local.x, local.y);
    if (this.wasInside) {
      this.layer.beginStroke(local.x, local.y);
    }
    this.hint.visible = false;
  };

  handlePointerMove = (e: FederatedPointerEvent) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    if (!this.currentWeapon) return;
    const w = this.currentWeapon;
    const local = this.stage.toLocal(e.global);
    const inside = this.isInsideFn(local.x, local.y);
    if (inside) {
      if (this.wasInside) {
        this.layer.extendStroke(local.x, local.y, w.color, w.strokeWidth ?? 3);
        if (this.lastLocal) {
          const dx = local.x - this.lastLocal.x;
          const dy = local.y - this.lastLocal.y;
          const d = Math.hypot(dx, dy);
          if (d < 60) {
            this.accumDist += d;
            while (this.accumDist >= 40) {
              this.accumDist -= 40;
              this.cb.onStroke(40, w);
            }
          }
        }
      } else {
        this.layer.beginStroke(local.x, local.y);
      }
    } else if (this.wasInside) {
      this.layer.endStroke();
    }
    this.wasInside = inside;
    this.lastLocal = { x: local.x, y: local.y };
  };

  handlePointerUp = (e: FederatedPointerEvent) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    this.endIfActive();
    this.hint.visible = this.active;
  };

  private endIfActive() {
    if (this.pointerId !== null) {
      this.layer.endStroke();
      this.pointerId = null;
      this.lastLocal = null;
      this.accumDist = 0;
      this.wasInside = false;
    }
  }

  destroy() {
    this.hint.destroy();
  }
}
