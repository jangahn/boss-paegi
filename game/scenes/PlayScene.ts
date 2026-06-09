import {
  Application,
  Container,
  FederatedPointerEvent,
  Sprite,
  Texture,
} from "pixi.js";
import { Body, Constraint } from "matter-js";
import { Doll } from "@/game/entities/Doll";
import { HitEffect } from "@/game/effects/HitEffect";
import { Projectile } from "@/game/entities/Projectile";
import { DrawingLayer } from "@/game/entities/DrawingLayer";
import { PhysicsWorld } from "@/game/physics/PhysicsWorld";
import { ThrowInput } from "@/game/input/ThrowInput";
import { DrawInput } from "@/game/input/DrawInput";
import { Weapon, WEAPONS } from "@/lib/weapons";
import { playHitSound, unlockAudio } from "@/lib/sound";

export type HitInfo = {
  x: number;
  y: number;
  strength: number;
  weapon: Weapon["key"];
};

type PlaySceneOptions = {
  app: Application;
  dollTexture?: Texture;
  bgTexture?: Texture;
  weapon?: Weapon;
  onHit?: (info: HitInfo) => void;
};

type Mode = "tap" | "throw" | "draw";

// fling 으로 전환되는 이동 거리 (인형 좌표계 px)
const FLING_DRAG_THRESHOLD = 14;

export class PlayScene extends Container {
  private app: Application;
  private bg?: Sprite;
  private doll: Doll;
  private fx: HitEffect;
  private onHit?: (info: HitInfo) => void;
  private weapon: Weapon;

  // physics
  private physics: PhysicsWorld;
  private dollBody: Body;
  private dollSpring: Constraint;
  private walls: Body[] = [];
  private projectileLayer: Container;
  private projectiles: Projectile[] = [];
  private removeCollisionListener?: () => void;

  // drawing
  private drawingLayer: DrawingLayer;
  private drawRadiusFactor = 0.5;

  // input
  private throwInput: ThrowInput;
  private drawInput: DrawInput;
  private mode: Mode = "tap";

  // doll pointer state — tap vs fling 분기용
  private dollPointerId: number | null = null;
  private dollDownAt = 0;
  private dollDownPos = { x: 0, y: 0 };
  private flingActive = false;
  private flingHistory: { x: number; y: number; t: number }[] = [];
  private springRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private originalAirFriction = 0.14;
  // drag 중 벽 진입 추적 — 진입 순간(에지) 만 점수 발생
  private wallState = { L: false, R: false, T: false, B: false };

  // viewport memo
  private viewW = 0;
  private viewH = 0;

  constructor(opts: PlaySceneOptions) {
    super();
    this.app = opts.app;
    this.onHit = opts.onHit;
    this.weapon = opts.weapon ?? WEAPONS[0];

    if (opts.bgTexture) {
      this.bg = new Sprite(opts.bgTexture);
      this.bg.anchor.set(0.5);
      this.addChild(this.bg);
    }

    this.doll = new Doll({ texture: opts.dollTexture });
    this.addChild(this.doll);

    // DrawingLayer — PlayScene 의 child 로 stage 좌표. inside check 는 매 frame doll.x/y + scaled radius 기준.
    this.drawingLayer = new DrawingLayer();
    this.drawRadiusFactor = this.doll.isSprite ? 0.42 : 0.5;
    this.addChild(this.drawingLayer);

    this.fx = new HitEffect();
    this.addChild(this.fx);

    this.projectileLayer = new Container();
    this.addChild(this.projectileLayer);

    // physics
    this.physics = new PhysicsWorld();
    // doll body radius 키움 — projectile 충돌 영역 확장 (face 보다 살짝 큼).
    this.dollBody = this.physics.createDollAnchor(0, 0, this.doll.naturalSize * 0.55);
    this.dollSpring = this.physics.createDollSpring(this.dollBody, 0, 0);
    this.physics.add(this.dollBody);
    this.physics.add(this.dollSpring);
    this.removeCollisionListener = this.physics.onCollision(this.handleCollision);

    // input
    this.eventMode = "static";
    this.hitArea = { contains: () => true };
    this.throwInput = new ThrowInput(this, { onRelease: this.handleThrowRelease });
    this.drawInput = new DrawInput(
      this,
      this.drawingLayer,
      (sx, sy) => this.isInsideDoll(sx, sy),
      { onStroke: this.handleDrawStroke }
    );

    this.on("pointerdown", this.handleStagePointerDown);
    this.on("pointermove", this.handleStagePointerMove);
    this.on("pointerup", this.handleStagePointerUp);
    this.on("pointerupoutside", this.handleStagePointerUp);
    this.on("pointercancel", this.handleStagePointerUp);

    this.doll.on("pointerdown", this.handleDollPointerDown);
    this.doll.on("pointermove", this.handleDollPointerMove);
    this.doll.on("pointerup", this.handleDollPointerUp);
    this.doll.on("pointerupoutside", this.handleDollPointerUp);
    this.doll.on("pointercancel", this.handleDollPointerUp);

    this.updateMode();
  }

  setWeapon(w: Weapon) {
    if (this.weapon.key === w.key) return;
    this.weapon = w;
    this.updateMode();
  }

  private updateMode() {
    const w = this.weapon;
    if (w.category === "tap") this.mode = "tap";
    else if (w.category === "throw") this.mode = "throw";
    else this.mode = "draw";

    this.throwInput.setActive(this.mode === "throw", w);
    this.drawInput.setActive(this.mode === "draw", w);

    // draw 모드일 땐 인형 자체를 stage 에 양보 (인형 위 stroke 가능)
    // tap/throw 일 땐 인형 자체가 pointer 받음 — 인형 위 드래그 = 인형 던지기
    const dollInteractive = this.mode !== "draw";
    this.doll.eventMode = dollInteractive ? "static" : "none";
    this.doll.cursor = dollInteractive ? "pointer" : "default";
  }

  // ── doll pointer — tap / fling 통합 ─────────────────────────────────
  private handleDollPointerDown = (e: FederatedPointerEvent) => {
    unlockAudio();
    if (this.dollPointerId !== null) return;
    // draw 모드는 doll.eventMode = "none" 이라 여기 안 옴. 안전망으로 가드.
    if (this.mode === "draw") return;
    e.stopPropagation();
    this.dollPointerId = e.pointerId;
    const local = this.toLocal(e.global);
    this.dollDownAt = performance.now();
    this.dollDownPos = { x: local.x, y: local.y };
    this.flingActive = false;
    this.flingHistory = [{ x: local.x, y: local.y, t: this.dollDownAt }];
    this.wallState = { L: false, R: false, T: false, B: false };
  };

  private handleDollPointerMove = (e: FederatedPointerEvent) => {
    if (this.dollPointerId === null || e.pointerId !== this.dollPointerId) return;
    const local = this.toLocal(e.global);
    const dx = local.x - this.dollDownPos.x;
    const dy = local.y - this.dollDownPos.y;
    const dist = Math.hypot(dx, dy);
    if (!this.flingActive && dist >= FLING_DRAG_THRESHOLD) {
      // fling 활성화 — spring 해제, frictionAir 0
      this.flingActive = true;
      if (this.springRestoreTimer) clearTimeout(this.springRestoreTimer);
      this.dollSpring.stiffness = 0;
      this.originalAirFriction = this.dollBody.frictionAir;
      this.dollBody.frictionAir = 0;
      Body.setVelocity(this.dollBody, { x: 0, y: 0 });
    }
    if (this.flingActive) {
      Body.setPosition(this.dollBody, { x: local.x, y: local.y });
      this.flingHistory.push({ x: local.x, y: local.y, t: performance.now() });
      const cutoff = performance.now() - 120;
      while (this.flingHistory.length > 1 && this.flingHistory[0].t < cutoff) {
        this.flingHistory.shift();
      }
      // 벽 박기 — drag 중 doll body 가 화면 가장자리 margin 안으로 진입할 때 hit
      this.checkWallHit(local.x, local.y);
    }
  };

  /** drag 중 화면 4벽 margin 안 진입 (edge trigger) 시 점수+이펙트. */
  private checkWallHit(x: number, y: number) {
    const margin = 60;
    const newL = x < margin;
    const newR = x > this.viewW - margin;
    const newT = y < margin;
    const newB = y > this.viewH - margin;
    const fire = (impactX: number, impactY: number) => {
      const w = this.weapon;
      const points = 15;
      this.fx.shockwave(impactX, impactY, 22, 100, 0xffd166);
      this.fx.burst(impactX, impactY, 10, 0xffd166);
      this.fx.scorePop(impactX, impactY - 30, points, 0xffd166);
      this.doll.triggerHit(1.4);
      playHitSound("thud");
      this.onHit?.({ x: impactX, y: impactY, strength: points, weapon: w.key });
    };
    if (!this.wallState.L && newL) fire(0, y);
    if (!this.wallState.R && newR) fire(this.viewW, y);
    if (!this.wallState.T && newT) fire(x, 0);
    if (!this.wallState.B && newB) fire(x, this.viewH);
    this.wallState = { L: newL, R: newR, T: newT, B: newB };
  }

  private handleDollPointerUp = (e: FederatedPointerEvent) => {
    if (this.dollPointerId === null || e.pointerId !== this.dollPointerId) return;
    this.dollPointerId = null;
    const upAt = performance.now();
    const elapsed = upAt - this.dollDownAt;
    if (!this.flingActive) {
      // 짧은 탭 → mode 별 단발 액션
      if (this.mode === "tap" && elapsed < 350) {
        this.executeTap(this.dollDownPos.x, this.dollDownPos.y);
      }
      // throw 모드의 짧은 탭은 무효 (사용자가 인형 위 짧은 탭으로 슬링샷 시작 불가) — 자연스러움.
      return;
    }
    // fling release
    const recent = this.flingHistory.filter((p) => p.t > upAt - 80);
    let vx = 0, vy = 0;
    if (recent.length >= 2) {
      const first = recent[0];
      const last = recent[recent.length - 1];
      const dt = Math.max(0.01, (last.t - first.t) / 1000);
      vx = (last.x - first.x) / dt;
      vy = (last.y - first.y) / dt;
    }
    // matter velocity 단위: px/step (~16ms). px/sec / 60 ≈ px/step.
    Body.setVelocity(this.dollBody, { x: vx / 60, y: vy / 60 });
    Body.setAngularVelocity(this.dollBody, (Math.random() - 0.5) * 0.4);
    this.dollBody.frictionAir = this.originalAirFriction;
    // 0.9초 자유 비행 후 spring 복원
    if (this.springRestoreTimer) clearTimeout(this.springRestoreTimer);
    this.springRestoreTimer = setTimeout(() => {
      this.dollSpring.stiffness = 0.06;
      this.springRestoreTimer = null;
    }, 900);

    const speed = Math.hypot(vx, vy);
    const power = Math.min(1, speed / 1500);
    if (power > 0.08) {
      playHitSound("whoosh");
      const points = Math.round(20 + power * 30); // 20~50점
      this.fx.shockwave(
        this.dollBody.position.x,
        this.dollBody.position.y,
        24,
        100 + power * 80,
        0xef476f
      );
      this.fx.scorePop(
        this.dollBody.position.x,
        this.dollBody.position.y - 40,
        points,
        0xef476f
      );
      this.doll.triggerHit(1 + power);
      this.onHit?.({
        x: this.dollBody.position.x,
        y: this.dollBody.position.y,
        strength: points,
        weapon: this.weapon.key,
      });
    }
    this.flingHistory = [];
    this.flingActive = false;
  };

  private executeTap(x: number, y: number) {
    const w = this.weapon;
    this.doll.triggerHit(w.shake);
    this.fx.burst(x, y, w.particleCount, w.color);
    this.fx.shockwave(x, y, 18, 70 + w.shake * 25, w.color);
    playHitSound(w.sound);
    const dx = this.dollBody.position.x - x;
    const dy = this.dollBody.position.y - y;
    const len = Math.hypot(dx, dy) || 1;
    const push = 0.012 * w.shake;
    Body.applyForce(this.dollBody, this.dollBody.position, {
      x: (dx / len) * push,
      y: (dy / len) * push,
    });
    this.fx.scorePop(x, y - 30, w.strength, w.color);
    this.onHit?.({ x, y, strength: w.strength, weapon: w.key });
  }

  // ── stage pointer (throw projectile / draw, 인형 밖) ──────────────
  private handleStagePointerDown = (e: FederatedPointerEvent) => {
    unlockAudio();
    if (this.mode === "throw") this.throwInput.handlePointerDown(e);
    else if (this.mode === "draw") this.drawInput.handlePointerDown(e);
  };

  private handleStagePointerMove = (e: FederatedPointerEvent) => {
    if (this.mode === "throw") this.throwInput.handlePointerMove(e);
    else if (this.mode === "draw") this.drawInput.handlePointerMove(e);
  };

  private handleStagePointerUp = (e: FederatedPointerEvent) => {
    if (this.mode === "throw") this.throwInput.handlePointerUp(e);
    else if (this.mode === "draw") this.drawInput.handlePointerUp(e);
  };

  private handleThrowRelease = ({
    startX,
    startY,
    vx,
    vy,
    weapon,
  }: {
    startX: number;
    startY: number;
    vx: number;
    vy: number;
    weapon: Weapon;
  }) => {
    const size = weapon.projectileSize ?? 48;
    const mass = weapon.mass ?? 1;
    const body = this.physics.createProjectile(startX, startY, size, mass, vx, vy);
    this.physics.add(body);
    const proj = new Projectile(body, weapon);
    this.projectileLayer.addChild(proj);
    this.projectiles.push(proj);
    playHitSound("whoosh");
  };

  /** stage 좌표 (sx, sy) 가 인형 face 안인지 — DrawInput 의 inside check closure 용. */
  private isInsideDoll(sx: number, sy: number): boolean {
    // 인형의 화면 face radius = naturalSize × drawRadiusFactor × doll.scale
    const r = this.doll.naturalSize * this.drawRadiusFactor * this.doll.scale.x;
    const dx = sx - this.doll.x;
    const dy = sy - this.doll.y;
    return dx * dx + dy * dy <= r * r;
  }

  private handleDrawStroke = (length: number, weapon: Weapon) => {
    void length;
    playHitSound("scribble");
    this.onHit?.({
      x: this.dollBody.position.x,
      y: this.dollBody.position.y,
      strength: weapon.strength,
      weapon: weapon.key,
    });
  };

  // ── collision (projectile ↔ doll) ──────────────────────────────────
  private handleCollision = (a: Body, b: Body) => {
    let projBody: Body | null = null;
    if (a.label === "projectile" && b.label === "doll") projBody = a;
    else if (b.label === "projectile" && a.label === "doll") projBody = b;
    if (!projBody) return;
    const proj = this.projectiles.find((p) => p.body === projBody);
    if (!proj || proj.hasHit) return;
    proj.markHit();
    const w = proj.weapon;
    const hx = projBody.position.x;
    const hy = projBody.position.y;
    // 강력한 임팩트 — punch ×1.4, burst ×3, 큰 shockwave, 인형에 추가 force
    this.doll.triggerHit(w.shake * 1.4);
    this.fx.burst(hx, hy, w.particleCount * 3, w.color);
    this.fx.shockwave(hx, hy, 30, 150, w.color);
    this.fx.scorePop(hx, hy - 30, w.strength, w.color);
    // projectile 의 momentum 으로 doll 자체 밀어내기 (체감 강화)
    const v = projBody.velocity;
    const factor = 0.0006 * (w.mass ?? 1);
    Body.applyForce(this.dollBody, this.dollBody.position, {
      x: v.x * factor,
      y: v.y * factor,
    });
    playHitSound(w.sound);
    this.onHit?.({ x: hx, y: hy, strength: w.strength, weapon: w.key });
  };

  update(deltaSec: number) {
    this.physics.step(deltaSec * 1000);
    this.doll.x = this.dollBody.position.x;
    this.doll.y = this.dollBody.position.y;
    if (this.flingActive || this.dollSpring.stiffness === 0) {
      this.doll.rotation = this.dollBody.angle;
    } else {
      this.doll.rotation = Math.max(-0.25, Math.min(0.25, this.dollBody.angle));
    }
    this.doll.update(deltaSec);
    this.fx.update(deltaSec);

    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.syncFromBody(this.viewW, this.viewH, deltaSec);
      if (p.isDead) {
        this.projectileLayer.removeChild(p);
        this.physics.remove(p.body);
        p.destroy({ children: true });
        this.projectiles.splice(i, 1);
      }
    }
  }

  layout(width: number, height: number) {
    this.viewW = width;
    this.viewH = height;
    if (this.bg) {
      this.bg.x = width / 2;
      this.bg.y = height / 2;
      const scale = Math.max(
        width / this.bg.texture.width,
        height / this.bg.texture.height
      );
      this.bg.scale.set(scale);
    }
    const anchorX = width / 2;
    const anchorY = height * 0.55;

    Body.setPosition(this.dollBody, { x: anchorX, y: anchorY });
    Body.setVelocity(this.dollBody, { x: 0, y: 0 });
    this.dollSpring.pointB = { x: anchorX, y: anchorY };

    const baseTarget = Math.min(width * 0.75, 420);
    const targetDoll = this.doll.isSprite ? baseTarget * 1.3 : baseTarget;
    this.doll.scale.set(targetDoll / this.doll.naturalSize);
    this.fx.x = 0;
    this.fx.y = 0;

    for (const w of this.walls) this.physics.remove(w);
    this.walls = this.physics.createWalls(width, height);
    for (const w of this.walls) this.physics.add(w);

    this.throwInput.layoutHint(width, height);
    this.drawInput.layoutHint(width, height);
  }

  destroy() {
    if (this.springRestoreTimer) clearTimeout(this.springRestoreTimer);
    this.removeCollisionListener?.();
    this.doll.off("pointerdown", this.handleDollPointerDown);
    this.doll.off("pointermove", this.handleDollPointerMove);
    this.doll.off("pointerup", this.handleDollPointerUp);
    this.doll.off("pointerupoutside", this.handleDollPointerUp);
    this.doll.off("pointercancel", this.handleDollPointerUp);
    this.off("pointerdown", this.handleStagePointerDown);
    this.off("pointermove", this.handleStagePointerMove);
    this.off("pointerup", this.handleStagePointerUp);
    this.off("pointerupoutside", this.handleStagePointerUp);
    this.off("pointercancel", this.handleStagePointerUp);
    this.throwInput.destroy();
    this.drawInput.destroy();
    for (const p of this.projectiles) {
      this.physics.remove(p.body);
      p.destroy({ children: true });
    }
    this.projectiles = [];
    this.physics.destroy();
    super.destroy({ children: true });
  }
}
