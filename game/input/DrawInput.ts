import {
  Container,
  Text,
  type FederatedPointerEvent,
} from "pixi.js";
import type { Weapon } from "@/lib/weapons";
import type { DrawingLayer } from "@/game/entities/DrawingLayer";
import type { Doll } from "@/game/entities/Doll";

type Callbacks = {
  onStroke: (lengthScreenPx: number, weapon: Weapon) => void;
};

/**
 * 펜 낙서 입력.
 * - 좌표: doll.bodyWrap local 로 변환해 DrawingLayer (bodyWrap 의 child) 에 그림 —
 *   인형이 흔들리거나 던져져도 낙서가 같은 레이어로 함께 움직임.
 * - 영역: doll.isInsideBody (PNG 알파맵) 안만 stroke 허용. 밖은 입력 자체 무시.
 */
export class DrawInput {
  private stage: Container;
  private doll: Doll;
  private layer: DrawingLayer;
  private cb: Callbacks;
  private active = false;
  private currentWeapon: Weapon | null = null;
  private pointerId: number | null = null;
  private accumDist = 0;
  private lastLocal: { x: number; y: number } | null = null;
  private wasInside = false;
  private hint: Text;

  constructor(stage: Container, doll: Doll, layer: DrawingLayer, cb: Callbacks) {
    this.stage = stage;
    this.doll = doll;
    this.layer = layer;
    this.cb = cb;
    this.hint = new Text({
      text: "얼굴에 낙서",
      style: { fontSize: 13, fill: 0xffffff },
    });
    this.hint.anchor.set(0.5, 1);
    this.hint.alpha = 0.55;
    this.hint.visible = false;
    this.hint.eventMode = "none";
    this.stage.addChild(this.hint);
  }

  setActive(active: boolean, weapon: Weapon | null) {
    this.active = active;
    this.currentWeapon = weapon;
    if (weapon?.hint) this.hint.text = weapon.hint;
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
    const local = this.doll.bodyWrap.toLocal(e.global);
    this.lastLocal = { x: local.x, y: local.y };
    this.accumDist = 0;
    this.wasInside = this.doll.isInsideBody(local.x, local.y);
    if (this.wasInside) {
      this.layer.beginStroke(local.x, local.y);
    }
    this.hint.visible = false;
  };

  handlePointerMove = (e: FederatedPointerEvent) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    if (!this.currentWeapon) return;
    const w = this.currentWeapon;
    const local = this.doll.bodyWrap.toLocal(e.global);
    const inside = this.doll.isInsideBody(local.x, local.y);
    if (inside) {
      if (this.wasInside) {
        // stroke 두께는 화면 px 기준 → doll scale 로 나눠 local 두께로
        const dollScale = this.doll.scale.x || 1;
        const localWidth = (w.strokeWidth ?? 3) / dollScale;
        this.layer.extendStroke(local.x, local.y, w.color, localWidth);
        if (this.lastLocal) {
          const dx = local.x - this.lastLocal.x;
          const dy = local.y - this.lastLocal.y;
          const dScreen = Math.hypot(dx, dy) * dollScale;
          if (dScreen < 80) {
            this.accumDist += dScreen;
            while (this.accumDist >= 40) {
              this.accumDist -= 40;
              this.cb.onStroke(40, w);
            }
          }
        }
      } else {
        // 실루엣 밖 → 안으로 막 들어옴: 새 stroke 시작
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

  /** 브라우저 pointercancel 등 외부 취소 — stroke 상태만 리셋 */
  cancel() {
    this.endIfActive();
    this.hint.visible = this.active;
  }

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
