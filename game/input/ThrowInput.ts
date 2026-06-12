import {
  Container,
  Text,
  type FederatedPointerEvent,
} from "pixi.js";
import type { Weapon } from "@/lib/weapons";

type LaunchInfo = {
  /** 놓은 지점 (stage 좌표) */
  x: number;
  y: number;
  /** 발사 속도 (px/sec) — 드래그 방향 그대로 */
  vx: number;
  vy: number;
  /** 0~1. 놓는 순간 속도 비례 */
  power: number;
  weapon: Weapon;
};

type Callbacks = {
  onLaunch: (info: LaunchInfo) => void;
};

const MIN_LAUNCH_SPEED = 240; // px/sec — 이보다 느리면 발사 취소
const MAX_POWER_SPEED = 1600; // px/sec — power 1.0 기준

/**
 * 던지기 입력 — 잡고 휘둘러 놓기 (flick).
 * pointerdown 으로 무기를 잡으면 emoji 가 손가락을 따라다니고,
 * 캐릭터 쪽으로 휘두르다 놓으면 놓는 순간의 드래그 방향·속도 그대로 날아감.
 */
export class ThrowInput {
  private stage: Container;
  private cb: Callbacks;
  private active = false;
  private currentWeapon: Weapon | null = null;

  private pointerId: number | null = null;
  private history: { x: number; y: number; t: number }[] = [];

  private grabbedEmoji: Text;
  private hint: Text;

  constructor(stage: Container, cb: Callbacks) {
    this.stage = stage;
    this.cb = cb;
    this.grabbedEmoji = new Text({ text: "", style: { fontSize: 52 } });
    this.grabbedEmoji.anchor.set(0.5);
    this.grabbedEmoji.visible = false;
    this.grabbedEmoji.eventMode = "none";
    this.hint = new Text({
      text: "무기를 잡고 휘둘러 던지기",
      style: { fontSize: 13, fill: 0xffffff, align: "center" },
    });
    this.hint.anchor.set(0.5, 1);
    this.hint.alpha = 0.55;
    this.hint.visible = false;
    this.hint.eventMode = "none";
    this.stage.addChild(this.grabbedEmoji);
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
    this.history = [{ x: local.x, y: local.y, t: performance.now() }];
    this.grabbedEmoji.text = this.currentWeapon.emoji;
    this.grabbedEmoji.style.fontSize = this.currentWeapon.projectileSize ?? 48;
    this.grabbedEmoji.x = local.x;
    this.grabbedEmoji.y = local.y;
    this.grabbedEmoji.alpha = 1;
    this.grabbedEmoji.visible = true;
    this.hint.visible = false;
  };

  handlePointerMove = (e: FederatedPointerEvent) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    const local = this.stage.toLocal(e.global);
    this.grabbedEmoji.x = local.x;
    this.grabbedEmoji.y = local.y;
    // 드래그 방향으로 살짝 기울여 휘두르는 느낌
    const prev = this.history[this.history.length - 1];
    if (prev) {
      const dx = local.x - prev.x;
      const dy = local.y - prev.y;
      if (Math.hypot(dx, dy) > 2) {
        this.grabbedEmoji.rotation = Math.atan2(dy, dx) * 0.25;
      }
    }
    this.history.push({ x: local.x, y: local.y, t: performance.now() });
    const cutoff = performance.now() - 120;
    while (this.history.length > 1 && this.history[0].t < cutoff) {
      this.history.shift();
    }
  };

  handlePointerUp = (e: FederatedPointerEvent) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    this.pointerId = null;
    this.grabbedEmoji.visible = false;
    this.grabbedEmoji.rotation = 0;
    this.hint.visible = this.active;

    const w = this.currentWeapon;
    if (!w) return;
    const upAt = performance.now();
    const recent = this.history.filter((p) => p.t > upAt - 100);
    this.history = [];
    if (recent.length < 2) return;
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = Math.max(0.008, (last.t - first.t) / 1000);
    const vx = (last.x - first.x) / dt;
    const vy = (last.y - first.y) / dt;
    const speed = Math.hypot(vx, vy);
    if (speed < MIN_LAUNCH_SPEED) return; // 너무 느림 — 발사 취소
    const power = Math.min(1, speed / MAX_POWER_SPEED);
    this.cb.onLaunch({ x: last.x, y: last.y, vx, vy, power, weapon: w });
  };

  cancel() {
    this.pointerId = null;
    this.history = [];
    this.grabbedEmoji.visible = false;
    this.grabbedEmoji.rotation = 0;
  }

  destroy() {
    this.grabbedEmoji.destroy();
    this.hint.destroy();
  }
}
