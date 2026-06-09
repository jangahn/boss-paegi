import {
  Container,
  Graphics,
  Text,
  type FederatedPointerEvent,
} from "pixi.js";
import type { Weapon } from "@/lib/weapons";

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  currentX: number;
  currentY: number;
  weapon: Weapon;
};

type Callbacks = {
  /** drag 시작 — 무기 미리보기 sprite 그리기 위해 호출자 알림 */
  onDragStart?: () => void;
  /** drag 끝 — 발사 결정. velocity 는 px/sec, position 은 stage 좌표 */
  onRelease: (info: {
    startX: number;
    startY: number;
    vx: number;
    vy: number;
    weapon: Weapon;
  }) => void;
  /** drag 취소 — 너무 짧으면 발사 안 함 */
  onCancel?: () => void;
};

/**
 * 던지기 입력 — pointer down → drag → release.
 * 스테이지 전체(=PlayScene Container) 에 부착. 활성/비활성 toggle 로 동작 제어.
 * 활성 시: 화면 어디 누르면 weapon emoji 잡고, 드래그하면 trajectory 표시, 놓으면 발사.
 */
export class ThrowInput {
  private stage: Container;
  private cb: Callbacks;
  private active = false;
  private currentWeapon: Weapon | null = null;
  private drag: DragState | null = null;

  // visual feedback
  private dragLayer: Container;
  private aimLine: Graphics;
  private grabbedEmoji: Text;
  private hint: Text;

  constructor(stage: Container, cb: Callbacks) {
    this.stage = stage;
    this.cb = cb;
    this.dragLayer = new Container();
    this.dragLayer.eventMode = "none";
    this.aimLine = new Graphics();
    this.grabbedEmoji = new Text({ text: "", style: { fontSize: 56 } });
    this.grabbedEmoji.anchor.set(0.5);
    this.grabbedEmoji.visible = false;
    this.hint = new Text({
      text: "끌어서 던지기",
      style: {
        fontSize: 13,
        fill: 0xffffff,
        align: "center",
      },
    });
    this.hint.anchor.set(0.5, 1);
    this.hint.alpha = 0.55;
    this.hint.visible = false;
    this.dragLayer.addChild(this.aimLine);
    this.dragLayer.addChild(this.grabbedEmoji);
    this.dragLayer.addChild(this.hint);
    this.stage.addChild(this.dragLayer);
  }

  setActive(active: boolean, weapon: Weapon | null) {
    this.active = active;
    this.currentWeapon = weapon;
    if (!active) {
      this.cancel();
    }
    this.hint.visible = active && !this.drag;
    if (active) {
      this.layoutHint();
    }
  }

  /** hint 텍스트를 화면 하단 가운데 살짝 위에 위치. PlayScene.layout 에서 호출. */
  layoutHint(width?: number, height?: number) {
    if (typeof width === "number" && typeof height === "number") {
      this.hint.x = width / 2;
      this.hint.y = height - 140;
    }
  }

  handlePointerDown = (e: FederatedPointerEvent) => {
    if (!this.active || !this.currentWeapon) return;
    if (this.drag) return; // 한 손가락만
    const local = this.stage.toLocal(e.global);
    this.drag = {
      pointerId: e.pointerId,
      startX: local.x,
      startY: local.y,
      currentX: local.x,
      currentY: local.y,
      weapon: this.currentWeapon,
    };
    this.grabbedEmoji.text = this.currentWeapon.emoji;
    this.grabbedEmoji.style.fontSize = this.currentWeapon.projectileSize ?? 56;
    this.grabbedEmoji.x = local.x;
    this.grabbedEmoji.y = local.y;
    this.grabbedEmoji.visible = true;
    this.hint.visible = false;
    this.cb.onDragStart?.();
  };

  handlePointerMove = (e: FederatedPointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const local = this.stage.toLocal(e.global);
    this.drag.currentX = local.x;
    this.drag.currentY = local.y;
    this.grabbedEmoji.x = local.x;
    this.grabbedEmoji.y = local.y;
    this.drawAimLine();
  };

  handlePointerUp = (e: FederatedPointerEvent) => {
    if (!this.drag || e.pointerId !== this.drag.pointerId) return;
    const d = this.drag;
    this.drag = null;
    this.grabbedEmoji.visible = false;
    this.aimLine.clear();
    this.hint.visible = this.active;

    // 던진 방향 = drag 의 반대 (당겼다 놓는 느낌). distance 가 너무 작으면 발사 X.
    const dx = d.currentX - d.startX;
    const dy = d.currentY - d.startY;
    const dist = Math.hypot(dx, dy);
    if (dist < 12) {
      this.cb.onCancel?.();
      return;
    }
    // power: 0..1, distance 12~240 mapping
    const power = Math.min(1, dist / 240);
    const speed = 600 + power * 1200; // 600~1800 px/sec
    // 던진 방향 = drag 시작점에서 → 손가락이 끌고 간 반대 방향. 즉 "끌어당겼다 놓기 = 슬링샷".
    const dirX = -dx / dist;
    const dirY = -dy / dist;
    this.cb.onRelease({
      startX: d.startX,
      startY: d.startY,
      vx: dirX * speed,
      vy: dirY * speed,
      weapon: d.weapon,
    });
  };

  cancel() {
    this.drag = null;
    this.grabbedEmoji.visible = false;
    this.aimLine.clear();
  }

  private drawAimLine() {
    if (!this.drag) return;
    const d = this.drag;
    // 끌어당기는 trajectory: 시작→현재 점선, 그리고 시작에서 반대방향(=발사 방향)으로 미리보기 화살표.
    this.aimLine.clear();
    this.aimLine
      .moveTo(d.startX, d.startY)
      .lineTo(d.currentX, d.currentY)
      .stroke({ color: 0xffffff, width: 2, alpha: 0.45 });

    const dx = d.currentX - d.startX;
    const dy = d.currentY - d.startY;
    const len = Math.hypot(dx, dy);
    if (len < 12) return;
    const previewLen = Math.min(180, len * 1.2);
    const dirX = -dx / len;
    const dirY = -dy / len;
    const tipX = d.startX + dirX * previewLen;
    const tipY = d.startY + dirY * previewLen;
    this.aimLine
      .moveTo(d.startX, d.startY)
      .lineTo(tipX, tipY)
      .stroke({ color: 0xffd166, width: 4, alpha: 0.85 });
    // 화살촉
    const perpX = -dirY;
    const perpY = dirX;
    this.aimLine
      .moveTo(tipX, tipY)
      .lineTo(
        tipX - dirX * 14 + perpX * 8,
        tipY - dirY * 14 + perpY * 8
      )
      .moveTo(tipX, tipY)
      .lineTo(
        tipX - dirX * 14 - perpX * 8,
        tipY - dirY * 14 - perpY * 8
      )
      .stroke({ color: 0xffd166, width: 4, alpha: 0.85 });
  }

  destroy() {
    this.dragLayer.destroy({ children: true });
  }
}
