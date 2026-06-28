import {
  Container,
  Text,
  type FederatedPointerEvent,
} from "pixi.js";
import type { Weapon } from "@/lib/weapons";

type SwipeHit = {
  /** 타격 지점 (stage 좌표) */
  x: number;
  y: number;
  /** 손 이동 속도 (px/sec) */
  speed: number;
  /** 손 이동 방향 (unit vector) — 캐릭터 밀치기 방향 */
  dirX: number;
  dirY: number;
  weapon: Weapon;
};

type Callbacks = {
  onSwipeHit: (info: SwipeHit) => void;
  /** stage 좌표가 캐릭터 타격 범위 안인지 */
  isOverDoll: (x: number, y: number) => boolean;
};

const HIT_MIN_SPEED = 500; // px/sec — 이보다 빨라야 타격
const HIT_COOLDOWN_MS = 150; // 연속 타격 최소 간격 — 왔다갔다 1회당 1대

/**
 * 싸대기 입력 — 터치/드래그 시작하면 손바닥(✋)이 손가락을 따라다니고,
 * 캐릭터 위를 좌우/상하로 빠르게 문지르면 속도 비례로 찰싹찰싹 타격.
 */
export class SwipeInput {
  private stage: Container;
  private cb: Callbacks;
  private active = false;
  private currentWeapon: Weapon | null = null;

  private pointerId: number | null = null;
  private history: { x: number; y: number; t: number }[] = [];
  private lastHitAt = 0;

  private palm: Text;

  constructor(stage: Container, cb: Callbacks) {
    this.stage = stage;
    this.cb = cb;
    this.palm = new Text({ text: "✋", style: { fontSize: 64 } });
    this.palm.anchor.set(0.5);
    this.palm.visible = false;
    this.palm.eventMode = "none";
    this.stage.addChild(this.palm);
  }

  setActive(active: boolean, weapon: Weapon | null) {
    this.active = active;
    this.currentWeapon = weapon;
    if (!active) {
      this.cancel();
    }
  }

  handlePointerDown = (e: FederatedPointerEvent) => {
    if (!this.active || !this.currentWeapon) return;
    if (this.pointerId !== null) return;
    this.pointerId = e.pointerId;
    const local = this.stage.toLocal(e.global);
    this.history = [{ x: local.x, y: local.y, t: performance.now() }];
    this.palm.x = local.x;
    this.palm.y = local.y;
    this.palm.visible = true;
  };

  handlePointerMove = (e: FederatedPointerEvent) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    const w = this.currentWeapon;
    if (!w) return;
    const local = this.stage.toLocal(e.global);
    const now = performance.now();
    this.palm.x = local.x;
    this.palm.y = local.y;

    this.history.push({ x: local.x, y: local.y, t: now });
    const cutoff = now - 100;
    while (this.history.length > 1 && this.history[0].t < cutoff) {
      this.history.shift();
    }
    if (this.history.length < 2) return;

    const first = this.history[0];
    const dt = Math.max(0.008, (now - first.t) / 1000);
    const vx = (local.x - first.x) / dt;
    const vy = (local.y - first.y) / dt;
    const speed = Math.hypot(vx, vy);

    // 이동 방향으로 손바닥 기울이기 + 좌우 방향 따라 손 뒤집기
    if (speed > 120) {
      this.palm.rotation = Math.atan2(vy, vx) * 0.2;
      this.palm.scale.x = vx < 0 ? -1 : 1;
    }

    if (
      speed >= HIT_MIN_SPEED &&
      now - this.lastHitAt >= HIT_COOLDOWN_MS &&
      this.cb.isOverDoll(local.x, local.y)
    ) {
      this.lastHitAt = now;
      this.cb.onSwipeHit({
        x: local.x,
        y: local.y,
        speed,
        dirX: vx / speed,
        dirY: vy / speed,
        weapon: w,
      });
    }
  };

  handlePointerUp = (e: FederatedPointerEvent) => {
    if (this.pointerId === null || e.pointerId !== this.pointerId) return;
    this.cancel();
  };

  cancel() {
    this.pointerId = null;
    this.history = [];
    this.palm.visible = false;
    this.palm.rotation = 0;
    this.palm.scale.set(1);
  }

  destroy() {
    this.palm.destroy();
  }
}
