import {
  Application,
  Container,
  FederatedPointerEvent,
  Graphics,
  Sprite,
  Text,
  Texture,
} from "pixi.js";
import { Body, Constraint } from "matter-js";
import { Doll } from "@/game/entities/Doll";
import { HitEffect } from "@/game/effects/HitEffect";
import { Projectile } from "@/game/entities/Projectile";
import { DrawingLayer } from "@/game/entities/DrawingLayer";
import { PhysicsWorld } from "@/game/physics/PhysicsWorld";
import { ThrowInput } from "@/game/input/ThrowInput";
import { SwipeInput } from "@/game/input/SwipeInput";
import { ShootInput } from "@/game/input/ShootInput";
import { DrawInput } from "@/game/input/DrawInput";
import { Weapon, WeaponCategory, WEAPONS } from "@/lib/weapons";
import { playHitSound, unlockAudio } from "@/lib/sound";

type Pellet = {
  g: Graphics;
  x: number;
  y: number;
  vx: number;
  vy: number;
  weapon: Weapon;
};

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

// fling 으로 전환되는 이동 거리 (stage px)
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

  // drawing — doll.bodyWrap 의 child. 인형과 같은 레이어로 함께 움직임.
  private drawingLayer: DrawingLayer;

  // input
  private throwInput: ThrowInput;
  private swipeInput: SwipeInput;
  private shootInput: ShootInput;
  private drawInput: DrawInput;
  private mode: WeaponCategory = "tap";
  // tap/grab 모드용 안내 텍스트 (다른 모드는 각 input 클래스가 자체 hint 관리)
  private modeHint: Text;
  // 비비탄
  private pellets: Pellet[] = [];

  // doll pointer state — tap vs fling 분기용
  private dollPointerId: number | null = null;
  private dollDownAt = 0;
  private dollDownPos = { x: 0, y: 0 };
  private flingActive = false;
  private flingHistory: { x: number; y: number; t: number }[] = [];
  /** drag 중 손가락 위치 — update() 가 매 tick 여기로 body 를 고정 (중력 누적 방지) */
  private flingPointerPos = { x: 0, y: 0 };
  private springRestoreTimer: ReturnType<typeof setTimeout> | null = null;
  private originalAirFriction = 0.14;
  /** 물리 body 에 적용된 표시 scale — layout 에서 Body.scale 동기화용 */
  private dollBodyScale = 1;
  // drag 중 벽 진입 추적 — 진입 순간(에지)만 점수 발생
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

    // 낙서 레이어 — 인형 bodyWrap 에 부착. 흔들림/던지기/회전 전부 인형과 함께.
    // 보간 dot 도 실루엣 안만 허용 (빠른 스트로크가 오목 영역을 가로지를 때 잉크 새는 것 방지)
    this.drawingLayer = new DrawingLayer((x, y) => this.doll.isInsideBody(x, y));
    this.doll.bodyWrap.addChild(this.drawingLayer);

    this.fx = new HitEffect();
    this.addChild(this.fx);

    this.projectileLayer = new Container();
    this.addChild(this.projectileLayer);

    // physics
    this.physics = new PhysicsWorld();
    this.dollBody = this.physics.createDollAnchor(
      0,
      0,
      this.doll.naturalSize * 0.55
    );
    this.dollSpring = this.physics.createDollSpring(this.dollBody, 0, 0);
    this.physics.add(this.dollBody);
    this.physics.add(this.dollSpring);
    this.removeCollisionListener = this.physics.onCollision(
      this.handleCollision
    );

    // input
    this.eventMode = "static";
    this.hitArea = { contains: () => true };
    this.throwInput = new ThrowInput(this, { onLaunch: this.handleThrowLaunch });
    this.swipeInput = new SwipeInput(this, {
      onSwipeHit: this.handleSwipeHit,
      isOverDoll: (x, y) => this.isOverDoll(x, y),
    });
    this.shootInput = new ShootInput(this, { onFire: this.handleShootFire });
    this.drawInput = new DrawInput(this, this.doll, this.drawingLayer, {
      onStroke: this.handleDrawStroke,
    });
    this.modeHint = new Text({
      text: "",
      style: { fontSize: 13, fill: 0xffffff, align: "center" },
    });
    this.modeHint.anchor.set(0.5, 1);
    this.modeHint.alpha = 0.55;
    this.modeHint.visible = false;
    this.addChild(this.modeHint);

    this.on("pointerdown", this.handleStagePointerDown);
    this.on("pointermove", this.handleStagePointerMove);
    this.on("pointerup", this.handleStagePointerUp);
    this.on("pointerupoutside", this.handleStagePointerUp);

    this.doll.on("pointerdown", this.handleDollPointerDown);
    // v8 의 pointermove 는 hit-test 경로에만 dispatch — 드래그가 인형 밖으로
    // 나가는 순간 끊기므로 globalpointermove 로 추적 (pointerId 가드로 필터).
    this.doll.on("globalpointermove", this.handleDollPointerMove);
    this.doll.on("pointerup", this.handleDollPointerUp);
    this.doll.on("pointerupoutside", this.handleDollPointerUp);

    this.updateMode();
  }

  setWeapon(w: Weapon) {
    if (this.weapon.key === w.key) return;
    this.weapon = w;
    this.updateMode();
  }

  /** 배경만 교체 — 게임 상태 (점수/낙서/projectile) 그대로 유지. */
  setBackground(texture: Texture) {
    if (this.bg) {
      this.bg.texture = texture;
    } else {
      this.bg = new Sprite(texture);
      this.bg.anchor.set(0.5);
      this.addChildAt(this.bg, 0);
    }
    this.layoutBg();
  }

  private updateMode() {
    this.mode = this.weapon.category;
    this.throwInput.setActive(this.mode === "throw", this.weapon);
    this.swipeInput.setActive(this.mode === "swipe", this.weapon);
    this.shootInput.setActive(this.mode === "shoot", this.weapon);
    this.drawInput.setActive(this.mode === "draw", this.weapon);

    // tap/grab 모드 hint — 다른 모드는 각 input 의 hint 가 표시됨
    if (this.mode === "tap" || this.mode === "grab") {
      this.modeHint.text = this.weapon.hint;
      this.modeHint.visible = true;
    } else {
      this.modeHint.visible = false;
    }

    // tap: 인형 탭만. grab: 인형 잡고 fling. 나머지: 인형 위 제스처를 stage 입력에 양보.
    const dollInteractive = this.mode === "tap" || this.mode === "grab";
    this.doll.eventMode = dollInteractive ? "static" : "none";
    this.doll.cursor = dollInteractive ? "pointer" : "default";
    if (this.mode !== "grab") {
      this.cancelFling();
    }
  }

  /** stage 좌표가 인형 타격 범위(원, face+여유) 안인지 — swipe 용 관대한 판정 */
  private isOverDoll(sx: number, sy: number): boolean {
    const r = this.doll.naturalSize * 0.55 * (this.doll.scale.x || 1);
    const dx = sx - this.doll.x;
    const dy = sy - this.doll.y;
    return dx * dx + dy * dy <= r * r;
  }

  // ── doll pointer — tap / fling 통합 ─────────────────────────────────
  private handleDollPointerDown = (e: FederatedPointerEvent) => {
    unlockAudio();
    if (this.dollPointerId !== null) return;
    if (this.mode !== "tap" && this.mode !== "grab") return;
    e.stopPropagation();
    this.dollPointerId = e.pointerId;
    const local = this.toLocal(e.global);
    this.dollDownAt = performance.now();
    this.dollDownPos = { x: local.x, y: local.y };
    this.flingActive = false;
    this.flingHistory = [{ x: local.x, y: local.y, t: this.dollDownAt }];
    this.wallState = { L: false, R: false, T: false, B: false };
    if (this.mode === "grab") this.modeHint.visible = false;
  };

  private handleDollPointerMove = (e: FederatedPointerEvent) => {
    if (this.dollPointerId === null || e.pointerId !== this.dollPointerId)
      return;
    const local = this.toLocal(e.global);
    // history 는 모드 무관 항상 추적 — tap 모드의 "드래그면 탭 아님" 판정에도 사용
    this.flingHistory.push({ x: local.x, y: local.y, t: performance.now() });
    const cutoff = performance.now() - 120;
    while (this.flingHistory.length > 1 && this.flingHistory[0].t < cutoff) {
      this.flingHistory.shift();
    }
    const dx = local.x - this.dollDownPos.x;
    const dy = local.y - this.dollDownPos.y;
    const dist = Math.hypot(dx, dy);
    if (
      !this.flingActive &&
      dist >= FLING_DRAG_THRESHOLD &&
      this.mode === "grab"
    ) {
      this.flingActive = true;
      if (this.springRestoreTimer) clearTimeout(this.springRestoreTimer);
      this.dollSpring.stiffness = 0;
      this.originalAirFriction = this.dollBody.frictionAir;
      this.dollBody.frictionAir = 0;
      // drag 중에는 벽 충돌 off — 모바일처럼 인형 body 가 화면 폭에 끼는
      // 경우 벽 해소가 손가락 추적을 x 축에서 막아버림 (위아래로만 움직임).
      this.dollBody.collisionFilter.mask = 0x0001;
      // 누적된 각도 정규화 — 다음 자유비행에서 다회전 unwind 방지
      const a = this.dollBody.angle % (Math.PI * 2);
      Body.setAngle(this.dollBody, a > Math.PI ? a - Math.PI * 2 : a);
      Body.setVelocity(this.dollBody, { x: 0, y: 0 });
    }
    if (this.flingActive) {
      this.flingPointerPos = { x: local.x, y: local.y };
      Body.setPosition(this.dollBody, { x: local.x, y: local.y });
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
      const points = 15;
      this.fx.shockwave(impactX, impactY, 22, 100, 0xffd166);
      this.fx.burst(impactX, impactY, 10, 0xffd166);
      this.fx.scorePop(impactX, impactY - 30, points, 0xffd166);
      this.doll.triggerHit(1.4);
      playHitSound("thud");
      this.onHit?.({
        x: impactX,
        y: impactY,
        strength: points,
        weapon: this.weapon.key,
      });
    };
    if (!this.wallState.L && newL) fire(0, y);
    if (!this.wallState.R && newR) fire(this.viewW, y);
    if (!this.wallState.T && newT) fire(x, 0);
    if (!this.wallState.B && newB) fire(x, this.viewH);
    this.wallState = { L: newL, R: newR, T: newT, B: newB };
  }

  private handleDollPointerUp = (e: FederatedPointerEvent) => {
    if (this.dollPointerId === null || e.pointerId !== this.dollPointerId)
      return;
    this.dollPointerId = null;
    if (this.mode === "tap" || this.mode === "grab") {
      this.modeHint.visible = true;
    }
    const upAt = performance.now();
    const elapsed = upAt - this.dollDownAt;
    if (!this.flingActive) {
      // 진짜 탭만: 총 이동거리까지 확인 (경계 밖으로 끌다 놓은 드래그 오발사 방지)
      const lastPt = this.flingHistory[this.flingHistory.length - 1];
      const moved = lastPt
        ? Math.hypot(lastPt.x - this.dollDownPos.x, lastPt.y - this.dollDownPos.y)
        : 0;
      if (this.mode === "tap" && elapsed < 350 && moved < FLING_DRAG_THRESHOLD) {
        this.executeTap(this.dollDownPos.x, this.dollDownPos.y);
      }
      return;
    }
    // fling release
    const recent = this.flingHistory.filter((p) => p.t > upAt - 80);
    let vx = 0,
      vy = 0;
    if (recent.length >= 2) {
      const first = recent[0];
      const last = recent[recent.length - 1];
      const dt = Math.max(0.01, (last.t - first.t) / 1000);
      vx = (last.x - first.x) / dt;
      vy = (last.y - first.y) / dt;
    }
    // matter velocity 단위: px/step (~16ms). px/sec → /60.
    // 속도 cap 28px/step — 벽 관통 방지 (벽 두께 400px 와 함께 2중 안전망).
    let svx = vx / 60;
    let svy = vy / 60;
    const sv = Math.hypot(svx, svy);
    if (sv > 28) {
      svx = (svx / sv) * 28;
      svy = (svy / sv) * 28;
    }
    Body.setVelocity(this.dollBody, { x: svx, y: svy });
    Body.setAngularVelocity(this.dollBody, (Math.random() - 0.5) * 0.4);
    this.dollBody.frictionAir = this.originalAirFriction;
    this.dollBody.collisionFilter.mask = 0x0001 | 0x0008; // 벽 충돌 복원
    if (this.springRestoreTimer) clearTimeout(this.springRestoreTimer);
    this.springRestoreTimer = setTimeout(() => {
      this.dollSpring.stiffness = 0.06;
      Body.setAngularVelocity(this.dollBody, 0);
      this.springRestoreTimer = null;
    }, 900);

    const speed = Math.hypot(vx, vy);
    const power = Math.min(1, speed / 1500);
    if (power > 0.08) {
      playHitSound("whoosh", 0.5 + power * 0.7);
      const points = Math.round(20 + power * 30);
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

  private cancelFling() {
    if (!this.flingActive && this.dollPointerId === null) return;
    this.dollPointerId = null;
    this.flingActive = false;
    this.flingHistory = [];
    this.dollBody.frictionAir = this.originalAirFriction;
    this.dollBody.collisionFilter.mask = 0x0001 | 0x0008;
    if (this.springRestoreTimer) clearTimeout(this.springRestoreTimer);
    this.springRestoreTimer = null;
    this.dollSpring.stiffness = 0.06;
    Body.setVelocity(this.dollBody, { x: 0, y: 0 });
    Body.setAngularVelocity(this.dollBody, 0);
  }

  /**
   * 브라우저 pointercancel 등 외부 취소 — 진행 중이던 모든 포인터 시퀀스를
   * 점수/발사 없이 상태만 리셋. (pixi 8.19 는 pointercancel 을 display object 로
   * 전달하지 않아 DOM 레벨에서 호출됨)
   */
  cancelActivePointers() {
    this.cancelFling();
    this.throwInput.cancel();
    this.swipeInput.cancel();
    this.shootInput.cancel();
    this.drawInput.cancel();
  }

  /** 탭 무기 (주먹/뿅망치) — 한 방. 타격 지점에 무기 이모지가 뿅. */
  private executeTap(x: number, y: number) {
    const w = this.weapon;
    this.doll.triggerHit(w.shake);
    this.fx.emojiPop(x, y, w.emoji, {
      size: 60,
      swing: w.key === "hammer",
    });
    this.fx.burst(x, y, w.particleCount, w.color);
    this.fx.shockwave(x, y, 18, 75 + w.shake * 30, w.color);
    playHitSound(w.sound);
    const dx = this.dollBody.position.x - x;
    const dy = this.dollBody.position.y - y;
    const len = Math.hypot(dx, dy) || 1;
    const push = 0.018 * w.shake;
    Body.applyForce(this.dollBody, this.dollBody.position, {
      x: (dx / len) * push,
      y: (dy / len) * push,
    });
    this.fx.scorePop(x, y - 30, w.strength, w.color);
    this.onHit?.({ x, y, strength: w.strength, weapon: w.key });
  }

  // ── swipe (싸대기) ──────────────────────────────────────────────────
  private handleSwipeHit = ({
    x,
    y,
    speed,
    dirX,
    dirY,
    weapon,
  }: {
    x: number;
    y: number;
    speed: number;
    dirX: number;
    dirY: number;
    weapon: Weapon;
  }) => {
    // 속도 비례 데미지 (0.6×~2×) + 볼륨
    const factor = Math.min(2, Math.max(0.6, speed / 1100));
    const points = Math.round(weapon.strength * factor);
    this.doll.triggerHit(weapon.shake * factor);
    this.fx.burst(x, y, Math.round(weapon.particleCount * factor), weapon.color);
    this.fx.shockwave(x, y, 16, 60 + 50 * factor, weapon.color);
    this.fx.scorePop(x, y - 30, points, weapon.color);
    playHitSound("slap", 0.6 + factor * 0.5);
    // 손이 움직인 방향으로 인형 밀치기
    Body.applyForce(this.dollBody, this.dollBody.position, {
      x: dirX * 0.012 * factor,
      y: dirY * 0.012 * factor,
    });
    this.onHit?.({ x, y, strength: points, weapon: weapon.key });
  };

  // ── stage pointer 라우팅 ────────────────────────────────────────────
  private handleStagePointerDown = (e: FederatedPointerEvent) => {
    unlockAudio();
    if (this.mode === "throw") this.throwInput.handlePointerDown(e);
    else if (this.mode === "swipe") this.swipeInput.handlePointerDown(e);
    else if (this.mode === "shoot") this.shootInput.handlePointerDown(e);
    else if (this.mode === "draw") this.drawInput.handlePointerDown(e);
  };

  private handleStagePointerMove = (e: FederatedPointerEvent) => {
    if (this.mode === "throw") this.throwInput.handlePointerMove(e);
    else if (this.mode === "swipe") this.swipeInput.handlePointerMove(e);
    else if (this.mode === "shoot") this.shootInput.handlePointerMove(e);
    else if (this.mode === "draw") this.drawInput.handlePointerMove(e);
  };

  private handleStagePointerUp = (e: FederatedPointerEvent) => {
    if (this.mode === "throw") this.throwInput.handlePointerUp(e);
    else if (this.mode === "swipe") this.swipeInput.handlePointerUp(e);
    else if (this.mode === "shoot") this.shootInput.handlePointerUp(e);
    else if (this.mode === "draw") this.drawInput.handlePointerUp(e);
  };

  // ── throw (잡고 휘둘러 놓기) ────────────────────────────────────────
  private handleThrowLaunch = ({
    x,
    y,
    vx,
    vy,
    power,
    weapon,
  }: {
    x: number;
    y: number;
    vx: number;
    vy: number;
    power: number;
    weapon: Weapon;
  }) => {
    const size = weapon.projectileSize ?? 48;
    const mass = weapon.mass ?? 1;
    // px/sec → matter px/step
    const body = this.physics.createProjectile(
      x,
      y,
      size,
      mass,
      vx / 60,
      vy / 60
    );
    this.physics.add(body);
    const proj = new Projectile(body, weapon);
    this.projectileLayer.addChild(proj);
    this.projectiles.push(proj);
    playHitSound("whoosh", 0.5 + power * 0.7);
  };

  // ── shoot (비비탄총) ────────────────────────────────────────────────
  private handleShootFire = ({
    x,
    y,
    weapon,
  }: {
    x: number;
    y: number;
    weapon: Weapon;
  }) => {
    const dx = this.doll.x - x;
    const dy = this.doll.y - y;
    const len = Math.hypot(dx, dy) || 1;
    const speed = 1400;
    const g = new Graphics();
    g.circle(0, 0, 3.5).fill(weapon.color);
    g.x = x;
    g.y = y;
    this.projectileLayer.addChild(g);
    this.pellets.push({
      g,
      x,
      y,
      vx: (dx / len) * speed,
      vy: (dy / len) * speed,
      weapon,
    });
    playHitSound("pew", 0.9);
  };

  /** 매 프레임 pellet 전진 + 인형 명중 판정 */
  private updatePellets(deltaSec: number) {
    if (!this.pellets.length) return;
    const hitR = this.doll.naturalSize * 0.45 * (this.doll.scale.x || 1);
    for (let i = this.pellets.length - 1; i >= 0; i--) {
      const p = this.pellets[i];
      p.x += p.vx * deltaSec;
      p.y += p.vy * deltaSec;
      p.g.x = p.x;
      p.g.y = p.y;
      const dx = p.x - this.doll.x;
      const dy = p.y - this.doll.y;
      const out =
        p.x < -100 ||
        p.x > this.viewW + 100 ||
        p.y < -100 ||
        p.y > this.viewH + 100;
      if (dx * dx + dy * dy <= hitR * hitR) {
        const w = p.weapon;
        this.doll.triggerHit(w.shake);
        this.fx.burst(p.x, p.y, w.particleCount, w.color);
        this.fx.scorePop(p.x, p.y - 20, w.strength, w.color);
        playHitSound("pop", 0.9);
        this.onHit?.({ x: p.x, y: p.y, strength: w.strength, weapon: w.key });
      } else if (!out) {
        continue;
      }
      this.projectileLayer.removeChild(p.g);
      p.g.destroy();
      this.pellets.splice(i, 1);
    }
  }

  // ── draw (펜) ───────────────────────────────────────────────────────
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
    // 충돌 속도 비례 데미지 (px/step 기준: 1200px/s ≈ 20)
    const impactSpeed = projBody.speed;
    const factor = Math.min(2.2, Math.max(0.6, impactSpeed / 18));
    const points = Math.round(w.strength * factor);

    if (w.impact === "scatter") {
      // 종이 — 흩뿌려지며 타격
      this.fx.paperScatter(hx, hy, 12);
      this.fx.burst(hx, hy, w.particleCount, w.color);
      this.doll.triggerHit(w.shake * factor);
      playHitSound("rustle", 0.8 + factor * 0.4);
    } else {
      // 책/키보드 — 둔탁한 타격
      this.doll.triggerHit(w.shake * factor);
      this.fx.burst(hx, hy, Math.round(w.particleCount * 2 * factor), w.color);
      this.fx.shockwave(hx, hy, 30, 110 + 50 * factor, w.color);
      playHitSound("thud", 0.7 + factor * 0.5);
      if (w.key === "keyboard") playHitSound("clack", 0.8);
      // projectile momentum 으로 인형 밀어내기.
      // collisionStart 안의 applyForce 는 matter 의 step 순서상 적분 전에
      // 클리어되어 no-op — setVelocity 로 직접 임펄스 적용.
      const v = projBody.velocity;
      const k = 0.04 * (w.mass ?? 1) * factor;
      Body.setVelocity(this.dollBody, {
        x: this.dollBody.velocity.x + v.x * k,
        y: this.dollBody.velocity.y + v.y * k,
      });
    }
    this.fx.scorePop(hx, hy - 30, points, w.color);
    this.onHit?.({ x: hx, y: hy, strength: points, weapon: w.key });
  };

  update(deltaSec: number) {
    // drag 중에는 매 tick 손가락 위치에 고정 — 중력 velocity 누적으로
    // 인형이 손에서 처지거나 (포인터 정지 시) 빠져나가는 것 방지.
    if (this.flingActive) {
      Body.setPosition(this.dollBody, this.flingPointerPos);
      Body.setVelocity(this.dollBody, { x: 0, y: 0 });
    }
    this.physics.step(deltaSec * 1000);
    // 최후 안전망: 그래도 화면 밖 멀리 탈출했으면 anchor 로 즉시 복귀
    if (!this.flingActive && this.viewW > 0) {
      const p = this.dollBody.position;
      const m = 450;
      if (
        p.x < -m ||
        p.x > this.viewW + m ||
        p.y < -m ||
        p.y > this.viewH + m
      ) {
        Body.setPosition(this.dollBody, {
          x: this.viewW / 2,
          y: this.viewH * 0.55,
        });
        Body.setVelocity(this.dollBody, { x: 0, y: 0 });
        Body.setAngularVelocity(this.dollBody, 0);
      }
    }
    this.doll.x = this.dollBody.position.x;
    this.doll.y = this.dollBody.position.y;
    if (this.flingActive || this.dollSpring.stiffness === 0) {
      this.doll.rotation = this.dollBody.angle;
    } else {
      // spring 복원 중 — 잔여 각도를 서서히 0 으로 (스냅/영구 기울어짐 방지)
      if (Math.abs(this.dollBody.angle) > 0.001) {
        Body.setAngle(
          this.dollBody,
          this.dollBody.angle * Math.exp(-6 * deltaSec)
        );
      }
      this.doll.rotation = this.dollBody.angle;
    }
    this.doll.update(deltaSec);
    this.fx.update(deltaSec);
    this.shootInput.update(deltaSec, this.doll.x, this.doll.y);
    this.updatePellets(deltaSec);

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

  private layoutBg() {
    if (!this.bg || !this.viewW || !this.viewH) return;
    this.bg.x = this.viewW / 2;
    this.bg.y = this.viewH / 2;
    const scale = Math.max(
      this.viewW / this.bg.texture.width,
      this.viewH / this.bg.texture.height
    );
    this.bg.scale.set(scale);
  }

  layout(width: number, height: number) {
    this.viewW = width;
    this.viewH = height;
    this.layoutBg();

    const anchorX = width / 2;
    const anchorY = height * 0.55;

    Body.setPosition(this.dollBody, { x: anchorX, y: anchorY });
    Body.setVelocity(this.dollBody, { x: 0, y: 0 });
    this.dollSpring.pointB = { x: anchorX, y: anchorY };

    const baseTarget = Math.min(width * 0.75, 420);
    const targetDoll = this.doll.isSprite ? baseTarget * 1.3 : baseTarget;
    this.doll.scale.set(targetDoll / this.doll.naturalSize);
    // 물리 body 반경을 표시 scale 에 동기화 — 안 하면 충돌 판정이
    // 보이는 인형보다 한참 작고 벽 반사도 화면 밖으로 뚫림.
    const nextScale = this.doll.scale.x || 1;
    const ratio = nextScale / this.dollBodyScale;
    if (Math.abs(ratio - 1) > 1e-3) {
      Body.scale(this.dollBody, ratio, ratio);
      // Body.scale 은 mass/inertia 를 면적 기준으로 재계산 — 튜닝된
      // force 상수들 (tap 0.018, swipe 0.012 등) 이 가정하는 질량으로 재고정.
      Body.setMass(this.dollBody, 6);
      this.dollBodyScale = nextScale;
    }
    this.fx.x = 0;
    this.fx.y = 0;

    // 벽 overhang: 인형 body 반경의 70% 만큼 화면 밖으로 — 좁은 화면에서
    // body 가 좌우 벽 사이에 끼어 수평 이동 불가가 되는 것 방지.
    const bodyRadius = this.doll.naturalSize * 0.55 * nextScale;
    const overhang = bodyRadius * 0.7;
    for (const w of this.walls) this.physics.remove(w);
    this.walls = this.physics.createWalls(width, height, overhang);
    for (const w of this.walls) this.physics.add(w);

    this.throwInput.layoutHint(width, height);
    this.swipeInput.layoutHint(width, height);
    this.shootInput.layoutHint(width, height);
    this.drawInput.layoutHint(width, height);
    this.modeHint.x = width / 2;
    this.modeHint.y = height - 140;
  }

  destroy() {
    if (this.springRestoreTimer) clearTimeout(this.springRestoreTimer);
    this.removeCollisionListener?.();
    this.doll.off("pointerdown", this.handleDollPointerDown);
    this.doll.off("globalpointermove", this.handleDollPointerMove);
    this.doll.off("pointerup", this.handleDollPointerUp);
    this.doll.off("pointerupoutside", this.handleDollPointerUp);
    this.off("pointerdown", this.handleStagePointerDown);
    this.off("pointermove", this.handleStagePointerMove);
    this.off("pointerup", this.handleStagePointerUp);
    this.off("pointerupoutside", this.handleStagePointerUp);
    this.throwInput.destroy();
    this.swipeInput.destroy();
    this.shootInput.destroy();
    this.drawInput.destroy();
    for (const p of this.projectiles) {
      this.physics.remove(p.body);
      p.destroy({ children: true });
    }
    this.projectiles = [];
    for (const p of this.pellets) p.g.destroy();
    this.pellets = [];
    this.physics.destroy();
    super.destroy({ children: true });
  }
}
