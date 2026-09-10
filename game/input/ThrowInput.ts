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

const MIN_LAUNCH_SPEED = 240; // px/sec — 이보다 느리면 power 0 의 '약한 토스'(PlayScene 이 캐릭터 쪽으로 조준 보정)
const MAX_POWER_SPEED = 1600; // px/sec — power 1.0 기준
/** pointer timestamp가 뭉치거나 합성 입력이어도 물리 body 속도를 유한하게 제한한다. */
export const MAX_THROW_LAUNCH_SPEED = 1600;
/** 동시에 잡을 수 있는 손가락 수(이모지 풀 크기). 주먹 연타처럼 손가락마다 독립 발사(v1.34). */
export const MAX_CONCURRENT_GRABS = 5;

/** 손가락 하나의 잡기 상태 — 이력(속도 계산)과 따라다니는 이모지 */
type Grab = {
  history: { x: number; y: number; t: number }[];
  emoji: Text;
};

/**
 * 던지기 입력 — 잡고 휘둘러 놓기 (flick).
 * pointerdown 으로 무기를 잡으면 emoji 가 손가락을 따라다니고,
 * 캐릭터 쪽으로 휘두르다 놓으면 놓는 순간의 드래그 방향·속도 그대로 날아감.
 * 손가락마다 독립(v1.34): 여러 손가락이 동시에 잡고 각자 놓는다 — 빈 곳 멀티 탭이면 그 자리마다 발사.
 * 무기 변경·비활성화는 진행 중인 잡기를 전부 취소한다.
 */
export class ThrowInput {
  private stage: Container;
  private cb: Callbacks;
  private active = false;
  private currentWeapon: Weapon | null = null;

  private grabs = new Map<number, Grab>();
  /** 잡기 이모지 풀 — 손가락 수만큼만 만들고 재사용 */
  private emojiPool: Text[] = [];

  constructor(stage: Container, cb: Callbacks) {
    this.stage = stage;
    this.cb = cb;
  }

  /** 진행 중인 잡기 중 가장 최근 손가락(없으면 null) — 라이프사이클 검증·디버그용 관측점. */
  get pointerId(): number | null {
    let last: number | null = null;
    for (const id of this.grabs.keys()) last = id;
    return last;
  }

  setActive(active: boolean, weapon: Weapon | null) {
    const weaponChanged = this.currentWeapon?.key !== weapon?.key;
    if (!active || weaponChanged) {
      // book→keyboard처럼 같은 throw category 전환도 진행 중 gesture를
      // 취소한다. down은 구 무기, up은 신 무기가 되는 혼합 발사를 금지.
      this.cancel();
    }
    this.active = active;
    this.currentWeapon = weapon;
  }

  private acquireEmoji(): Text | null {
    const idle = this.emojiPool.find((t) => !t.visible);
    if (idle) return idle;
    if (this.emojiPool.length >= MAX_CONCURRENT_GRABS) return null;
    const t = new Text({ text: "", style: { fontSize: 52 } });
    t.anchor.set(0.5);
    t.visible = false;
    t.eventMode = "none";
    this.stage.addChild(t);
    this.emojiPool.push(t);
    return t;
  }

  private releaseEmoji(t: Text) {
    t.visible = false;
    t.rotation = 0;
  }

  handlePointerDown = (e: FederatedPointerEvent) => {
    if (!this.active || !this.currentWeapon) return;
    if (this.grabs.has(e.pointerId)) return;
    const emoji = this.acquireEmoji();
    if (!emoji) return; // 손가락 상한 초과
    const local = this.stage.toLocal(e.global);
    emoji.text = this.currentWeapon.emoji;
    emoji.style.fontSize = this.currentWeapon.projectileSize ?? 48;
    emoji.x = local.x;
    emoji.y = local.y;
    emoji.alpha = 1;
    emoji.visible = true;
    this.grabs.set(e.pointerId, {
      history: [{ x: local.x, y: local.y, t: performance.now() }],
      emoji,
    });
  };

  handlePointerMove = (e: FederatedPointerEvent) => {
    const grab = this.grabs.get(e.pointerId);
    if (!grab) return;
    const local = this.stage.toLocal(e.global);
    grab.emoji.x = local.x;
    grab.emoji.y = local.y;
    // 드래그 방향으로 살짝 기울여 휘두르는 느낌
    const prev = grab.history[grab.history.length - 1];
    if (prev) {
      const dx = local.x - prev.x;
      const dy = local.y - prev.y;
      if (Math.hypot(dx, dy) > 2) {
        grab.emoji.rotation = Math.atan2(dy, dx) * 0.25;
      }
    }
    grab.history.push({ x: local.x, y: local.y, t: performance.now() });
    const cutoff = performance.now() - 120;
    while (grab.history.length > 1 && grab.history[0].t < cutoff) {
      grab.history.shift();
    }
  };

  handlePointerUp = (e: FederatedPointerEvent) => {
    const grab = this.grabs.get(e.pointerId);
    if (!grab) return;
    this.grabs.delete(e.pointerId);
    this.releaseEmoji(grab.emoji);

    const w = this.currentWeapon;
    if (!w) return;
    const upAt = performance.now();
    const recent = grab.history.filter((p) => p.t > upAt - 100);
    const up = this.stage.toLocal(e.global);
    // 놓기만 해도 항상 던져진다 — 느린 릴리즈는 power 0 의 약한 토스로 넘기고
    // PlayScene 이 캐릭터 쪽으로 조준 보정 + 최소 비행 속도를 준다(놓은 자리에서 떨어지지 않게).
    if (recent.length < 2) {
      this.cb.onLaunch({ x: up.x, y: up.y, vx: 0, vy: 0, power: 0, weapon: w });
      return;
    }
    const first = recent[0];
    const last = recent[recent.length - 1];
    const dt = Math.max(0.008, (last.t - first.t) / 1000);
    const rawVx = (last.x - first.x) / dt;
    const rawVy = (last.y - first.y) / dt;
    const rawSpeed = Math.hypot(rawVx, rawVy);
    if (!Number.isFinite(rawSpeed) || rawSpeed < MIN_LAUNCH_SPEED) {
      this.cb.onLaunch({ x: last.x, y: last.y, vx: 0, vy: 0, power: 0, weapon: w });
      return;
    }
    const launchSpeed = Math.min(rawSpeed, MAX_THROW_LAUNCH_SPEED);
    const scale = launchSpeed / rawSpeed;
    const vx = rawVx * scale;
    const vy = rawVy * scale;
    const power = Math.min(1, launchSpeed / MAX_POWER_SPEED);
    this.cb.onLaunch({ x: last.x, y: last.y, vx, vy, power, weapon: w });
  };

  cancel() {
    for (const grab of this.grabs.values()) this.releaseEmoji(grab.emoji);
    this.grabs.clear();
  }

  destroy() {
    this.grabs.clear();
    for (const t of this.emojiPool) t.destroy();
    this.emojiPool = [];
  }
}
