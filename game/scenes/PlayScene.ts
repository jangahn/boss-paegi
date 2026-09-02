/**
 * PlayScene — 게임의 중심 씬(Container). 의도적으로 큰 오케스트레이터로,
 * 다음 ~12개 책임을 한 곳에서 조율한다(실시간 루프 타이밍·히트 판정이 강결합돼 있어
 * 분리 시 단편화 비용이 큼):
 *   1. 게임 루프(update: 델타·궁극기·물리 step·doll/projectile/pellet sync·효과 정리)
 *   2. 입력 라우팅(stage pointer → 무기 모드별 입력 핸들러 위임)
 *   3. 히트 처리(reportHit → 점수/데미지레이어/사운드, 6개 입력 컨텍스트 공통)
 *   4. 궁극기 능력(triggerUltimate/ultBlow/ultThrow/ultFinish/restoreDoll)
 *   5. 탭/플링 메커닉(doll pointer down/move/up, fling 물리, wall hit)
 *   6~9. 스와이프/스로우/슛/드로우 핸들러
 *   10. 충돌(projectile ↔ doll, 임팩트 데미지)
 *   11. 레이아웃/뷰포트(stage 사이즈, doll scale, 물리 바디 리스케일)
 *   12. 생명주기(constructor/destroy/setWeapon/setDamageScore 등)
 *
 * 제스처별 입력 로직은 이미 game/input/{Throw,Swipe,Shoot,Draw}Input 으로 분리됨
 * (PlayScene 은 그 콜백을 해석/라우팅만). 추가로 비대해지면 분리 후보:
 *   - 궁극기 상태머신 → game/abilities/UltimateAbility.ts
 *   - 탭/플링(grab) → game/input/GrabInput.ts
 */
import {
  Application,
  Container,
  FederatedPointerEvent,
  Graphics,
  Sprite,
  Texture,
} from "pixi.js";
import { Body, Constraint } from "matter-js";
import { Doll } from "@/game/entities/Doll";
import { HitEffect } from "@/game/effects/HitEffect";
import { Projectile } from "@/game/entities/Projectile";
import { DrawingLayer } from "@/game/entities/DrawingLayer";
import { DamageLayer } from "@/game/entities/DamageLayer";
import { TransientDecals } from "@/game/entities/TransientDecals";
import { DazeFx } from "@/game/effects/DazeFx";
import { PhysicsWorld } from "@/game/physics/PhysicsWorld";
import { ThrowInput } from "@/game/input/ThrowInput";
import { SwipeInput } from "@/game/input/SwipeInput";
import { ShootInput } from "@/game/input/ShootInput";
import { DrawInput } from "@/game/input/DrawInput";
import {
  WEAPONS,
  SWIPE_FACTOR_MAX,
  THROW_FACTOR_MAX,
  GRAB_FLING_POWER_BONUS,
  PINCH_STRETCH_BONUS,
  type Weapon,
  type WeaponCategory,
} from "@/lib/weapons";
import {
  playHitSound,
  playYelp,
  startPinchTension,
  setPinchTension,
  stopPinchTension,
  unlockAudio,
} from "@/lib/sound";

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
  /** false 면 점수만 (궁극기 게이지 충전 제외 — 난타 중 타격) */
  chargeUlt?: boolean;
};

// 궁극기 난사타 지속/간격 — 총 타격 예산(ULT_BLOW_BUDGET)은 구 등간격 난타와 동일(≈42타)해
// 점수 총량 분포가 불변(어뷰징 봉투 무영향). 연타는 예산을 앞당겨 터뜨릴 뿐 늘리지 않는다.
const ULT_DURATION_SEC = 3.9;
const ULT_BLOW_INTERVAL = 0.085;
const ULT_BLOW_BUDGET = Math.floor((ULT_DURATION_SEC - 0.25) / ULT_BLOW_INTERVAL);
/** 자동 난타 간격 — 발동 즉시 시작해 예산 소진까지 끊김 없이 가속(진행도² 곡선) */
const ULT_BLOW_INTERVAL_START = 0.12;
const ULT_BLOW_INTERVAL_END = 0.035;
/** 연타 입력 최소 간격(ms) — 더블 이벤트 방지 */
const ULT_MASH_MIN_MS = 45;
// 궁극기 중 캐릭터를 마구 내던지는 간격 + 임펄스 세기 (px/step)
const ULT_THROW_INTERVAL = 0.4;

type PlaySceneOptions = {
  app: Application;
  dollTexture?: Texture;
  bgTexture?: Texture;
  weapon?: Weapon;
  onHit?: (info: HitInfo) => number | void;
  /** 낙서 비어있음 ↔ 있음 전이 시 호출 — picker 의 펜/지우개 토글용 */
  onDrawingChange?: (hasDrawing: boolean) => void;
};

// fling 으로 전환되는 이동 거리 (stage px)
const FLING_DRAG_THRESHOLD = 14;
/** 투척 최소 비행 속도(px/sec) — 이보다 느린 릴리즈는 이 속도로 캐릭터를 향해 날아감 */
const THROW_MIN_FLY_SPEED = 950;
/** 이 속도(px/sec) 미만이면 드래그 방향을 캐릭터 방향으로 점진 보정(느릴수록 강하게) */
const THROW_ASSIST_FULL_SPEED = 750;
/** 투척물 중력 상쇄 비율 — 포물선을 눕혀 더 멀리 날아가게 (1=무중력) */
const THROW_GRAVITY_CANCEL = 0.72;
/** 0xRRGGBB 두 색을 t(0..1)로 보간 — 궁극기 진행도별 붉은 물듦 */
function lerpColor(a: number, b: number, t: number): number {
  const k = Math.max(0, Math.min(1, t));
  const ch = (shift: number) => {
    const x = (a >> shift) & 0xff;
    const y = (b >> shift) & 0xff;
    return Math.round(x + (y - x) * k) & 0xff;
  };
  return (ch(16) << 16) | (ch(8) << 8) | ch(0);
}

/** 꼬집기 흔들기 — 당긴 채 손가락이 이 거리(px)만큼 움직일 때마다 피격(볼따구 쥐고 괴롭히기) */
const PINCH_SHAKE_PX = 55;
/** 흔들기 피격 최소 간격(ms) — 연타 무기와 비슷한 상한(≈10/s) */
const PINCH_SHAKE_MIN_MS = 95;

export class PlayScene extends Container {
  private app: Application;
  private bg?: Sprite;
  private doll: Doll;
  private fx: HitEffect;
  private onHit?: (info: HitInfo) => number | void;
  private weapon: Weapon;

  // physics
  private physics: PhysicsWorld;
  private dollBody: Body;
  private dollSpring: Constraint;
  private walls: Body[] = [];
  private projectileLayer: Container;
  private projectiles: Projectile[] = [];
  private removeCollisionListener?: () => void;

  // drawing — doll.bodyWrap 의 child. 캐릭터와 같은 레이어로 함께 움직임.
  private drawingLayer: DrawingLayer;
  // 점수 누적에 따른 꼬질꼬질 데칼 — 역시 bodyWrap child
  private damageLayer: DamageLayer;

  // input
  private throwInput: ThrowInput;
  private swipeInput: SwipeInput;
  private shootInput: ShootInput;
  private drawInput: DrawInput;
  private mode: WeaponCategory = "tap";
  private lifecycle: "running" | "paused" | "ended" = "running";
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

  // ── 타격감 (2026-08 개편) ──────────────────────────────────────────
  /** 히트스톱 — 큰 타격 순간 짧게 전체 동결(임팩트 강조). 초 단위 잔여. */
  private hitStop = 0;
  /** 최근 타격 시각(ms) 롤링 윈도우 — 해롱해롱 발동·비명 티어 판정 */
  private hitTimes: number[] = [];
  private dazeCooldownUntil = 0;
  private dazeFx: DazeFx;
  private transientDecals: TransientDecals;
  // 꼬집기 상태 (mode === "pinch" 에서 dollPointerId 를 공유)
  private pinchActive = false;
  private pinchRatio = 0;
  private pinchBlushAccum = 0;
  private pinchTravel = 0;
  private pinchLastShakeAt = 0;
  private pinchPos = { x: 0, y: 0 };

  // viewport memo
  private viewW = 0;
  private viewH = 0;

  // 궁극기 난사타 상태
  private ultActive = false;
  private ultTimer = 0;
  private ultBlowAccum = 0;
  private ultThrowAccum = 0;
  private ultShake = 0;
  /** 남은 타격 예산 — 자동·연타 공유. 0 이면 피니시로 직행 */
  private ultBudget = 0;
  private ultFired = 0;
  private ultLastMashAt = 0;

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

    // 데칼 루트 — 꼬질꼬질 + 낙서를 담고 캐릭터 실루엣 mask 로 클리핑.
    // 데칼이 면적을 가져도 (멍 반경, 먼지 spread) 캐릭터 픽셀 밖으로는
    // 한 픽셀도 안 나감 (sprite = alpha mask, placeholder = 도형 mask).
    const decalRoot = new Container();
    decalRoot.eventMode = "none";
    const silhouette = this.doll.makeSilhouetteMask();
    this.doll.bodyWrap.addChild(silhouette);
    decalRoot.mask = silhouette;

    // 꼬질꼬질 데칼 — 낙서보다 아래 레이어 (낙서가 항상 위에 보이게)
    this.damageLayer = new DamageLayer(
      (x, y) => this.doll.isInsideBody(x, y),
      this.doll.naturalSize
    );
    decalRoot.addChild(this.damageLayer);

    // 일시 데칼 (손자국/혹/홍조) — 꼬질 위, 낙서 아래
    this.transientDecals = new TransientDecals(this.doll.naturalSize);
    decalRoot.addChild(this.transientDecals);

    // 낙서 레이어 — 캐릭터 bodyWrap 에 부착. 흔들림/던지기/회전 전부 캐릭터와 함께.
    // 보간 dot 도 실루엣 안만 허용 (빠른 스트로크가 오목 영역을 가로지를 때 잉크 새는 것 방지)
    this.drawingLayer = new DrawingLayer(
      (x, y) => this.doll.isInsideBody(x, y),
      opts.onDrawingChange
    );
    decalRoot.addChild(this.drawingLayer);
    this.doll.bodyWrap.addChild(decalRoot);

    // 해롱해롱 별 궤도 — doll child (bodyWrap 지터에 안 떨리게 doll 레벨)
    this.dazeFx = new DazeFx(this.doll.naturalSize);
    this.doll.addChild(this.dazeFx);

    this.fx = new HitEffect();
    // 이펙트 (이모지/점수팝/파티클) 가 hit-test 를 가로채 연타가 씹히는 것 방지
    this.fx.eventMode = "none";
    this.addChild(this.fx);

    this.projectileLayer = new Container();
    this.projectileLayer.eventMode = "none";
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
    this.on("pointerdown", this.handleStagePointerDown);
    this.on("pointermove", this.handleStagePointerMove);
    this.on("pointerup", this.handleStagePointerUp);
    this.on("pointerupoutside", this.handleStagePointerUp);

    this.doll.on("pointerdown", this.handleDollPointerDown);
    // v8 의 pointermove 는 hit-test 경로에만 dispatch — 드래그가 캐릭터 밖으로
    // 나가는 순간 끊기므로 globalpointermove 로 추적 (pointerId 가드로 필터).
    this.doll.on("globalpointermove", this.handleDollPointerMove);
    this.doll.on("pointerup", this.handleDollPointerUp);
    this.doll.on("pointerupoutside", this.handleDollPointerUp);

    this.updateMode();
  }

  /** blur/hidden 동안 ticker가 돌더라도 입력·물리·충돌·점수를 함께 동결한다. */
  pause() {
    if (this.lifecycle === "ended") return;
    this.lifecycle = "paused";
    this.cancelActivePointers();
  }

  /** blur와 hidden이 모두 해제됐을 때만 BossPaegiGame이 호출한다. */
  resume() {
    if (this.lifecycle === "paused") this.lifecycle = "running";
  }

  /** 새 판 시작. 이전 판의 비행체/held input/궁극기 상태는 재사용하지 않는다. */
  start() {
    this.cancelActivePointers();
    this.stopUltimate();
    this.clearTransientAttacks();
    // 새 판 = 새 얼굴: 낙서·일시 데칼·해롱·연타 열기 전부 초기화 (꼬질 데칼은 스토어 점수 0 → setDamageScore 가 정리)
    this.drawingLayer.clear();
    this.transientDecals.clear();
    this.dazeFx.stop();
    this.hitTimes = [];
    this.hitStop = 0;
    this.lifecycle = "running";
  }

  /** 결과 스냅샷보다 먼저 호출해 Pixi 쪽 점수 생산자를 원자적으로 닫는다. */
  end() {
    if (this.lifecycle === "ended") return;
    this.lifecycle = "ended";
    this.cancelActivePointers();
    this.stopUltimate();
    this.clearTransientAttacks();
  }

  setWeapon(w: Weapon) {
    if (this.weapon.key === w.key) return;
    // 같은 category(book→keyboard)도 down/up 사이에 무기가 바뀌면
    // 혼합 gesture가 된다. 전환 경계에서 항상 기존 sequence를 폐기.
    this.cancelActivePointers();
    this.weapon = w;
    this.updateMode();
  }

  /** 현재 점수 전달 — 1000/10000점 단위로 꼬질꼬질 누적. 0 이면 초기화. */
  setDamageScore(score: number) {
    this.damageLayer.setScore(score);
  }

  /**
   * 타격 공통 처리 — 피격 부위 (stage 좌표) 를 bodyWrap local 로 변환해
   * 데미지 레이어에 기록하고 React 에 점수 콜백.
   */
  private reportHit(
    x: number,
    y: number,
    strength: number,
    weapon: Weapon["key"],
    charge = true
  ): number {
    if (this.lifecycle !== "running") return 0;
    const local = this.doll.bodyWrap.toLocal({ x, y }, this);
    this.damageLayer.noteHit(local.x, local.y);
    // 궁극기 연출 중 어떤 타격(난타·비행 중이던 투척물/비비탄 명중 포함)도
    // 게이지를 재충전하지 않음 — ultActive 면 charge 강제 false.
    // 반환 = 화면 데미지 팝업 값(콤보×무기변경 배율 적용). onHit 미설정 시 strength 폴백.
    return (
      this.onHit?.({ x, y, strength, weapon, chargeUlt: charge && !this.ultActive }) ??
      strength
    );
  }

  /** 화면 흔들림 추가 — 궁극기 셰이크 채널을 공용으로 재사용(자연 감쇠). */
  private addShake(power: number) {
    this.ultShake = Math.max(this.ultShake, power);
  }

  /** 히트스톱 — 큰 타격만. 상한 90ms(연타 조작감 보호). */
  private addHitStop(sec: number) {
    this.hitStop = Math.min(0.09, Math.max(this.hitStop, sec));
  }

  /** 캐릭터 머리 위치 (scene 좌표) — 눈물/진땀 스폰 기준 */
  private headPos() {
    const sc = this.doll.scale.x || 1;
    return { x: this.doll.x, y: this.doll.y - this.doll.naturalSize * 0.25 * sc };
  }

  /**
   * 타격 펄스 기록 — 2.5초 롤링 윈도우. weight 로 무기별 가중(뿅망치/투척 2, 플링 3).
   * 임계(14) 도달 시 해롱해롱 발동(별 궤도 + sway + 눈물, 6초 쿨다운).
   */
  private registerHitPulse(weight = 1) {
    const now = performance.now();
    for (let i = 0; i < weight; i++) this.hitTimes.push(now);
    const cutoff = now - 2500;
    while (this.hitTimes.length && this.hitTimes[0] < cutoff) this.hitTimes.shift();
    if (this.hitTimes.length >= 14 && now >= this.dazeCooldownUntil) {
      this.dazeCooldownUntil = now + 6000;
      this.dazeFx.start(1.7);
      this.doll.setDazed(1.7);
      const head = this.headPos();
      this.fx.tearDrops(head.x, head.y, 5);
      playHitSound("twinkle");
      playYelp(2);
    }
  }

  /** 연타 열기에 비례한 비굴 비명 — chance 확률로 재생, 티어는 최근 타격 수 기준 */
  private maybeYelp(chance: number, tierBoost = 0) {
    if (Math.random() >= chance) return;
    const n = this.hitTimes.length;
    const base = n >= 12 ? 2 : n >= 6 ? 1 : 0;
    playYelp(Math.min(2, base + tierBoost) as 0 | 1 | 2);
  }

  /** 게임 종료/중단 시 궁극기 난타 즉시 정지 + 화면 흔들림 복원 */
  stopUltimate() {
    if (!this.ultActive && this.ultShake <= 0.3) return;
    const wasActive = this.ultActive;
    this.ultActive = false;
    this.ultTimer = 0;
    this.ultShake = 0;
    this.ultBudget = 0;
    this.fx.stopSpeedLines();
    this.position.set(0, 0);
    if (wasActive) this.restoreDollAfterUlt();
  }

  /** 궁극기 발동 — 난사타 연출 시작. 진행 중엔 입력 차단. */
  triggerUltimate() {
    if (this.lifecycle !== "running" || this.ultActive) return;
    // 진행 중이던 드래그/연사 정리 후 난타 시작
    this.cancelActivePointers();
    this.ultActive = true;
    this.ultTimer = ULT_DURATION_SEC;
    this.ultBlowAccum = 0;
    this.ultThrowAccum = ULT_THROW_INTERVAL; // 첫 던지기 즉시
    this.ultShake = 22;
    this.ultBudget = ULT_BLOW_BUDGET;
    this.ultFired = 0;
    this.ultLastMashAt = 0;
    // 첫 타는 발동 후 첫 프레임에 즉시 — 누산기를 간격 직전까지 채워 둔다
    // (정확히 간격이면 dt=0 프레임에도 발사돼 "0초=0타" 불변식이 깨짐)
    this.ultBlowAccum = ULT_BLOW_INTERVAL_START - 1e-4;
    // 캐릭터를 멀리 날려보내려 스프링을 약하게 (난타 동안 자유롭게 휘저음)
    this.dollSpring.stiffness = 0.02;
    this.dollBody.collisionFilter.mask = 0x0001 | 0x0008; // 벽 튕김 유지
    // 발동 연출 — 화이트 플래시 + 집중선 (난타는 즉시 시작)
    this.fx.flash(this.viewW, this.viewH, 0xffffff, 0.35, 0.3);
    this.fx.startSpeedLines(this.viewW, this.viewH);
    this.doll.tremble(ULT_DURATION_SEC);
    playHitSound("whoosh", 1.3);
    playYelp(1, 1.1);
  }

  /** 궁극기 진행도 0..1 (예산 소진 기준) */
  private get ultProgress(): number {
    return ULT_BLOW_BUDGET > 0 ? this.ultFired / ULT_BLOW_BUDGET : 1;
  }

  /**
   * 궁극기 연타 — 난타 중 탭하면 남은 예산에서 한 타를 **즉시, 탭한 자리에** 터뜨린다.
   * 타격 수·점수 분포는 자동 난타와 동일(예산 공유)이라 총량 불변, 체감만 "내가 팬다".
   */
  private ultMash(sx: number, sy: number) {
    if (!this.ultActive || this.ultBudget <= 0) return;
    const now = performance.now();
    if (now - this.ultLastMashAt < ULT_MASH_MIN_MS) return;
    this.ultLastMashAt = now;
    this.ultBlow(sx, sy, true);
  }

  /** 궁극기 중 캐릭터를 랜덤 방향으로 내던짐 (벽에 튕기며 화면을 휘젓다 복귀) */
  private ultThrow() {
    const sp = 20 + Math.random() * 16;
    const a = Math.random() * Math.PI * 2;
    Body.setVelocity(this.dollBody, { x: Math.cos(a) * sp, y: Math.sin(a) * sp });
    Body.setAngularVelocity(this.dollBody, (Math.random() - 0.5) * 0.7);
    playHitSound("whoosh", 0.8);
  }

  /**
   * 난사타 1발 — 랜덤 무기로 캐릭터 타격 (게이지 재충전 X). 예산 1 소모.
   * aim 이 있으면(연타) 그 자리(실루엣 반경 내 클램프)를, 없으면 랜덤 위치를 때린다.
   * 진행도에 따라 흔들림·비명·별이 고조된다.
   */
  private ultBlow(aimX?: number, aimY?: number, mashed = false) {
    if (this.ultBudget <= 0) return;
    this.ultBudget -= 1;
    this.ultFired += 1;
    const progress = this.ultProgress;
    const w = WEAPONS[Math.floor(Math.random() * WEAPONS.length)];
    const r = this.doll.naturalSize * 0.45 * (this.doll.scale.x || 1);
    let x: number;
    let y: number;
    if (aimX !== undefined && aimY !== undefined) {
      let dx = aimX - this.doll.x;
      let dy = aimY - this.doll.y;
      const len = Math.hypot(dx, dy);
      if (len > r) {
        dx = (dx / len) * r;
        dy = (dy / len) * r;
      }
      x = this.doll.x + dx;
      y = this.doll.y + dy;
    } else {
      const ang = Math.random() * Math.PI * 2;
      const rad = Math.random() * r;
      x = this.doll.x + Math.cos(ang) * rad;
      y = this.doll.y + Math.sin(ang) * rad;
    }

    this.doll.triggerHit(2.2 + progress * 0.8);
    this.doll.hitSquash(this.doll.x - x, this.doll.y - y, 0.8 + progress * 0.9, {
      freq: 11,
      damp: 8,
    });
    // 난타가 쌓일수록 연한 분홍 → 진한 붉음으로 물듦 (타 간격보다 길게 유지해 끊기지 않음)
    this.doll.hitFlash(lerpColor(0xffc4c4, 0xff5252, progress), 0.16);
    this.fx.burst(x, y, w.particleCount * 2, w.color);
    this.fx.shockwave(x, y, 18, 120 + progress * 60, w.color);
    if (mashed || Math.random() < 0.55) {
      this.fx.emojiPop(x, y, w.emoji, { size: mashed ? 62 : 50, swing: w.key === "hammer" });
    }
    if (mashed) {
      this.fx.impactLines(x, y, 0xffffff, 6);
      this.fx.starBurst(x, y, 2);
    } else if (this.ultFired % 6 === 0) {
      this.fx.starBurst(x, y, 3);
    }
    if (this.ultFired % 7 === 0) {
      const tier = progress < 0.35 ? 0 : progress < 0.7 ? 1 : 2;
      playYelp(tier, 0.9);
    }
    this.ultShake = Math.max(this.ultShake, 12 + progress * 16);
    playHitSound(w.sound, 0.85 + progress * 0.35);
    // 난타 한 타격당 점수 — 기존(40~85)의 절반 수준 (분포 불변)
    const pts = 20 + Math.floor(Math.random() * 22);
    const gain = this.reportHit(x, y, pts, w.key, false);
    this.fx.scorePop(x, y - 20, gain, w.color);
    // 예산 소진 → 짧은 정적 후 피니시
    if (this.ultBudget <= 0) this.ultTimer = Math.min(this.ultTimer, 0.3);
  }

  /** 난사타 마무리 — 남은 예산 정산 + 특대 임팩트 + "반려" 도장 + 해롱 */
  private ultFinish() {
    this.fx.stopSpeedLines();
    // 프레임 드랍 등으로 예산이 남았으면 즉시 정산(점수 총량 결정성 유지)
    while (this.ultBudget > 0) this.ultBlow();
    const cx = this.doll.x;
    const cy = this.doll.y;
    for (let i = 0; i < 3; i++) {
      this.fx.shockwave(cx, cy, 30, 220 + i * 80, i === 0 ? 0xffd166 : 0xef476f);
    }
    this.fx.burst(cx, cy, 56, 0xef476f);
    this.fx.starBurst(cx, cy - 20, 12);
    this.fx.impactLines(cx, cy, 0xffd166, 12);
    this.fx.flash(this.viewW, this.viewH, 0xffffff, 0.9, 0.5);
    this.fx.stampPop(this.viewW / 2, this.viewH * 0.36, "반려");
    this.doll.triggerHit(3);
    this.doll.bounce(1.8);
    this.doll.hitFlash(0xff3d3d, 0.32);
    this.dazeFx.start(2.4);
    this.doll.setDazed(2.4);
    this.addHitStop(0.09);
    this.addShake(30);
    playHitSound("thud", 1.5);
    playHitSound("snap", 1.2);
    playHitSound("twinkle", 0.9);
    playYelp(2, 1.3);
    this.position.set(0, 0);
    this.restoreDollAfterUlt();
  }

  /** 궁극기 종료 — 스프링 복원 + 캐릭터 anchor 즉시 복귀 (던져진 상태 정리) */
  private restoreDollAfterUlt() {
    this.dollSpring.stiffness = 0.06;
    Body.setPosition(this.dollBody, {
      x: this.viewW / 2,
      y: this.viewH * 0.55,
    });
    Body.setVelocity(this.dollBody, { x: 0, y: 0 });
    Body.setAngularVelocity(this.dollBody, 0);
    Body.setAngle(this.dollBody, 0);
  }

  /** 낙서 전체 삭제 — 점수 영향 없음. 가벼운 쓱싹 사운드만. */
  clearDrawing() {
    if (!this.drawingLayer.hasDrawing) return;
    this.drawingLayer.clear();
    playHitSound("rustle", 0.7);
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

    // tap: 캐릭터 탭만. grab: 잡고 fling. pinch: 잡아 늘리기. 나머지: stage 입력에 양보.
    const dollInteractive =
      this.mode === "tap" || this.mode === "grab" || this.mode === "pinch";
    this.doll.eventMode = dollInteractive ? "static" : "none";
    this.doll.cursor = dollInteractive ? "pointer" : "default";
    if (this.mode !== "grab") {
      this.cancelFling();
    }
    if (this.mode !== "pinch") {
      this.cancelPinch();
    }
  }

  /** stage 좌표가 캐릭터 타격 범위(원, face+여유) 안인지 — swipe 용 관대한 판정 */
  private isOverDoll(sx: number, sy: number): boolean {
    const r = this.doll.naturalSize * 0.55 * (this.doll.scale.x || 1);
    const dx = sx - this.doll.x;
    const dy = sy - this.doll.y;
    return dx * dx + dy * dy <= r * r;
  }

  // ── doll pointer — tap / fling ──────────────────────────────────────
  private handleDollPointerDown = (e: FederatedPointerEvent) => {
    if (this.lifecycle !== "running" || this.ultActive) return;
    unlockAudio();
    if (this.mode === "tap") {
      // 연타가 생명 — down 즉시 타격, 포인터 잠금 없음 (멀티터치 동시 연타 전부 접수).
      e.stopPropagation();
      const local = this.toLocal(e.global);
      this.executeTap(local.x, local.y);
      return;
    }
    if (this.mode === "pinch") {
      if (this.dollPointerId !== null) return; // 꼬집기는 한 손가락만
      e.stopPropagation();
      this.dollPointerId = e.pointerId;
      this.pinchActive = true;
      this.pinchRatio = 0;
      this.pinchBlushAccum = 0;
      this.pinchTravel = 0;
      this.pinchLastShakeAt = 0;
      const downLocal = this.toLocal(e.global);
      this.pinchPos = { x: downLocal.x, y: downLocal.y };
      startPinchTension();
      // 꼬집힌 자리 홍조 (bodyWrap local — down 시점엔 transform 이 사실상 원점)
      const grabLocal = this.doll.bodyWrap.toLocal(e.global, undefined);
      if (this.doll.isInsideBody(grabLocal.x, grabLocal.y)) {
        this.transientDecals.blush(grabLocal.x, grabLocal.y);
      }
      return;
    }
    if (this.mode !== "grab") return;
    if (this.dollPointerId !== null) return; // fling 은 한 손가락만
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
    if (this.lifecycle !== "running") return;
    if (this.dollPointerId === null || e.pointerId !== this.dollPointerId)
      return;
    const local = this.toLocal(e.global);
    if (this.pinchActive) {
      // 꼬집기 — 캐릭터 중심에서 손가락까지의 당김 벡터를 로컬 px 로 환산
      const sc = this.doll.scale.x || 1;
      const maxLen = this.doll.naturalSize * sc * 0.6;
      let dx = local.x - this.doll.x;
      let dy = local.y - this.doll.y;
      const len = Math.hypot(dx, dy);
      const ratio = Math.min(1, len / maxLen);
      if (len > maxLen) {
        dx = (dx / len) * maxLen;
        dy = (dy / len) * maxLen;
      }
      this.pinchRatio = ratio;
      // 흔들기 — 당긴 채 움직인 거리를 누적해 임계마다 피격
      this.pinchTravel += Math.hypot(local.x - this.pinchPos.x, local.y - this.pinchPos.y);
      this.pinchPos = { x: local.x, y: local.y };
      this.doll.setPinchPull(dx / sc, dy / sc, ratio);
      setPinchTension(ratio);
      if (this.pinchTravel >= PINCH_SHAKE_PX) {
        this.pinchTravel = 0;
        const now = performance.now();
        if (now - this.pinchLastShakeAt >= PINCH_SHAKE_MIN_MS) {
          this.pinchLastShakeAt = now;
          this.pinchShake();
        }
      }
      // 한계 근처 — 진땀
      if (ratio > 0.82 && Math.random() < 0.1) {
        const head = this.headPos();
        this.fx.sweatDrops(head.x, head.y, 2);
      }
      // 당기는 동안 홍조 갱신 (0.35s 간격 근사 — move 이벤트 기반 누산)
      this.pinchBlushAccum += 1;
      if (this.pinchBlushAccum % 22 === 0 && ratio > 0.25) {
        const grabLocal = this.doll.bodyWrap.toLocal(e.global, undefined);
        if (this.doll.isInsideBody(grabLocal.x, grabLocal.y)) {
          this.transientDecals.blush(grabLocal.x, grabLocal.y);
        }
      }
      return;
    }
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
      // drag 중에는 벽 충돌 off — 모바일처럼 캐릭터 body 가 화면 폭에 끼는
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
    const fire = (impactX: number, impactY: number, nx: number, ny: number) => {
      const points = 15;
      this.fx.shockwave(impactX, impactY, 22, 100, 0xffd166);
      this.fx.burst(impactX, impactY, 10, 0xffd166);
      this.fx.starBurst(impactX, impactY, 4);
      this.doll.triggerHit(1.4);
      this.doll.hitSquash(nx, ny, 1.5);
      this.addShake(7);
      this.addHitStop(0.035);
      playHitSound("thud");
      this.registerHitPulse(2);
      this.maybeYelp(0.6);
      const gain = this.reportHit(impactX, impactY, points, this.weapon.key);
      this.fx.scorePop(impactX, impactY - 30, gain, 0xffd166);
    };
    if (!this.wallState.L && newL) fire(0, y, 1, 0);
    if (!this.wallState.R && newR) fire(this.viewW, y, -1, 0);
    if (!this.wallState.T && newT) fire(x, 0, 0, 1);
    if (!this.wallState.B && newB) fire(x, this.viewH, 0, -1);
    this.wallState = { L: newL, R: newR, T: newT, B: newB };
  }

  private handleDollPointerUp = (e: FederatedPointerEvent) => {
    if (this.lifecycle !== "running") return;
    if (this.dollPointerId === null || e.pointerId !== this.dollPointerId)
      return;
    this.dollPointerId = null;
    if (this.pinchActive) {
      const ratio = this.pinchRatio;
      this.pinchActive = false;
      this.pinchRatio = 0;
      if (ratio > 0.12) {
        const w = this.weapon;
        this.doll.releasePinch();
        this.doll.hitFlash(0xff7a7a, 0.07 + 0.07 * ratio);
        stopPinchTension(true, ratio);
        const local = this.toLocal(e.global);
        const points = Math.round(w.strength + ratio * PINCH_STRETCH_BONUS);
        this.fx.burst(local.x, local.y, Math.round(4 + 6 * ratio), w.color);
        if (ratio > 0.5) {
          const head = this.headPos();
          this.fx.tearDrops(head.x, head.y, Math.round(2 + ratio * 3));
        }
        if (ratio > 0.7) this.addHitStop(0.05);
        this.addShake(3 + 5 * ratio);
        this.registerHitPulse(1);
        this.maybeYelp(0.4 + ratio * 0.6, ratio > 0.7 ? 1 : 0);
        const gain = this.reportHit(local.x, local.y, points, w.key);
        this.fx.scorePop(local.x, local.y - 30, gain, w.color);
      } else {
        this.doll.cancelPinch();
        stopPinchTension(false);
      }
      return;
    }
    const upAt = performance.now();
    if (!this.flingActive) {
      // grab 모드에서 threshold 미달로 끝난 짧은 터치 — 아무 일 없음
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
      const points = Math.round(
        this.weapon.strength + power * GRAB_FLING_POWER_BONUS
      );
      this.fx.shockwave(
        this.dollBody.position.x,
        this.dollBody.position.y,
        24,
        100 + power * 80,
        0xef476f
      );
      this.fx.starBurst(this.dollBody.position.x, this.dollBody.position.y, Math.round(3 + power * 4));
      this.doll.triggerHit(1 + power);
      this.doll.hitSquash(svx, svy, 1 + power);
      this.addShake(4 + 6 * power);
      this.registerHitPulse(3);
      this.maybeYelp(0.75, 1);
      const gain = this.reportHit(
        this.dollBody.position.x,
        this.dollBody.position.y,
        points,
        this.weapon.key
      );
      this.fx.scorePop(
        this.dollBody.position.x,
        this.dollBody.position.y - 40,
        gain,
        0xef476f
      );
    }
    this.flingHistory = [];
    this.flingActive = false;
  };

  private cancelFling() {
    if (
      !this.flingActive &&
      this.dollPointerId === null &&
      this.springRestoreTimer === null
    ) {
      return;
    }
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
  /**
   * 꼬집기 흔들기 피격 — 볼따구를 쥔 채 흔들 때마다. 데미지는 당긴 비율 비례
   * (릴리즈와 같은 strength+ratio×BONUS 봉투 — 살짝 쥐고 흔들어도 최소 strength 는 들어감).
   */
  private pinchShake() {
    const ratio = this.pinchRatio;
    const w = this.weapon;
    const points = Math.round(w.strength + ratio * PINCH_STRETCH_BONUS);
    const { x, y } = this.pinchPos;
    playHitSound("squeak", 0.45 + ratio * 0.75);
    this.doll.triggerHit(0.6 + ratio * 0.6);
    this.doll.hitFlash(0xffa3a3, 0.06);
    this.doll.tremble(0.2);
    this.fx.burst(x, y, Math.round(2 + 4 * ratio), w.color);
    if (ratio > 0.55 && Math.random() < 0.5) {
      const head = this.headPos();
      this.fx.tearDrops(head.x, head.y, 2);
    }
    this.registerHitPulse(1);
    this.maybeYelp(0.2 + ratio * 0.5, ratio > 0.8 ? 1 : 0);
    const gain = this.reportHit(x, y, points, w.key);
    this.fx.scorePop(x, y - 26, gain, w.color);
  }

  private cancelPinch() {
    if (!this.pinchActive) return;
    this.pinchActive = false;
    this.pinchRatio = 0;
    if (this.dollPointerId !== null) this.dollPointerId = null;
    this.doll.cancelPinch();
    stopPinchTension(false);
  }

  cancelActivePointers() {
    this.cancelPinch();
    this.cancelFling();
    this.throwInput.cancel();
    this.swipeInput.cancel();
    this.shootInput.cancel();
    this.drawInput.cancel();
  }

  /** 탭 무기 (주먹/뿅망치) — 한 방. 무기별 시그니처 연출로 분기. */
  private executeTap(x: number, y: number) {
    const w = this.weapon;
    this.fx.emojiPop(x, y, w.emoji, {
      size: 60,
      swing: w.key === "hammer",
    });
    this.fx.burst(x, y, w.particleCount, w.color);
    this.fx.shockwave(x, y, 18, 75 + w.shake * 30, w.color);
    const dx = this.dollBody.position.x - x;
    const dy = this.dollBody.position.y - y;
    const len = Math.hypot(dx, dy) || 1;
    const push = 0.018 * w.shake;
    Body.applyForce(this.dollBody, this.dollBody.position, {
      x: (dx / len) * push,
      y: (dy / len) * push,
    });
    const hitLocal = this.doll.bodyWrap.toLocal({ x, y }, this);
    if (w.key === "hammer") {
      // 뾱 + 띠용용용 — 깊은 수직 눌림 후 저감쇠 바운스, 별 분출, 스프링 사운드
      this.doll.triggerHit(w.shake * 0.6);
      this.doll.bounce(1.1);
      this.fx.starBurst(x, y - 12, 5);
      playHitSound("springy");
      this.addHitStop(0.045);
      if (Math.random() < 0.45 && this.doll.isInsideBody(hitLocal.x, hitLocal.y)) {
        this.transientDecals.bump(hitLocal.x, hitLocal.y, 1.15);
      }
      this.registerHitPulse(2);
      this.maybeYelp(0.5, 1);
    } else {
      // 주먹 — 묵직: 방사선 임팩트 + 타격 방향 스쿼시 + 붉은 플래시 + 혹
      this.doll.triggerHit(w.shake);
      this.doll.hitSquash(dx, dy, 1.0);
      this.doll.hitFlash(0xff8a8a, 0.07);
      this.fx.impactLines(x, y, 0xffffff, 8);
      playHitSound(w.sound);
      this.addHitStop(0.028);
      if (Math.random() < 0.16 && this.doll.isInsideBody(hitLocal.x, hitLocal.y)) {
        this.transientDecals.bump(hitLocal.x, hitLocal.y, 1);
      }
      this.registerHitPulse(1);
      this.maybeYelp(0.25);
    }
    const gain = this.reportHit(x, y, w.strength, w.key);
    this.fx.scorePop(x, y - 30, gain, w.color);
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
    if (this.lifecycle !== "running") return;
    // 속도 비례 데미지 (0.6×~상한) + 볼륨
    const factor = Math.min(SWIPE_FACTOR_MAX, Math.max(0.6, speed / 1100));
    const points = Math.round(weapon.strength * factor);
    // 싸대기 — 고개가 홱(회전 킥 강화) + 스윙 방향 스쿼시 + 붉은 플래시 + 큰 손자국 + 궤적 스워시
    this.doll.triggerHit(weapon.shake * factor * 0.8);
    this.doll.hitSquash(dirX, dirY, factor * 1.2, { freq: 10, damp: 7 });
    this.doll.rotKick((dirX >= 0 ? 1 : -1) * 0.09 * factor);
    this.doll.hitFlash(0xff7a7a, 0.09);
    this.fx.burst(x, y, Math.round(weapon.particleCount * factor), weapon.color);
    this.fx.impactLines(x, y, 0xffd6dc, 6);
    this.fx.slapArc(x, y, dirX, dirY, 0xffc2cf);
    playHitSound("slap", 0.8 + factor * 0.6);
    const hitLocal = this.doll.bodyWrap.toLocal({ x, y }, this);
    if (this.doll.isInsideBody(hitLocal.x, hitLocal.y)) {
      this.transientDecals.handprint(hitLocal.x, hitLocal.y, Math.atan2(dirY, dirX), 1.35);
    }
    this.addHitStop(factor > 1.4 ? 0.05 : 0.03);
    this.addShake(3 + 4 * factor);
    if (factor > 1.2) {
      const head = this.headPos();
      this.fx.tearDrops(head.x, head.y, 2);
    }
    this.registerHitPulse(1);
    this.maybeYelp(0.85, factor > 1.2 ? 1 : 0);
    // 손이 움직인 방향으로 캐릭터 밀치기 (강화)
    Body.applyForce(this.dollBody, this.dollBody.position, {
      x: dirX * 0.019 * factor,
      y: dirY * 0.019 * factor,
    });
    const gain = this.reportHit(x, y, points, weapon.key);
    this.fx.scorePop(x, y - 30, gain, weapon.color);
  };

  // ── stage pointer 라우팅 ────────────────────────────────────────────
  private handleStagePointerDown = (e: FederatedPointerEvent) => {
    if (this.lifecycle !== "running") return;
    if (this.ultActive) {
      // 난타 중 탭 = 연타(예산 앞당김) — doll 핸들러는 ult 중 early return 이라 여기로 버블
      const local = this.toLocal(e.global);
      this.ultMash(local.x, local.y);
      return;
    }
    unlockAudio();
    if (this.mode === "throw") this.throwInput.handlePointerDown(e);
    else if (this.mode === "swipe") this.swipeInput.handlePointerDown(e);
    else if (this.mode === "shoot") this.shootInput.handlePointerDown(e);
    else if (this.mode === "draw") this.drawInput.handlePointerDown(e);
  };

  private handleStagePointerMove = (e: FederatedPointerEvent) => {
    if (this.lifecycle !== "running") return;
    if (this.mode === "throw") this.throwInput.handlePointerMove(e);
    else if (this.mode === "swipe") this.swipeInput.handlePointerMove(e);
    else if (this.mode === "shoot") this.shootInput.handlePointerMove(e);
    else if (this.mode === "draw") this.drawInput.handlePointerMove(e);
  };

  private handleStagePointerUp = (e: FederatedPointerEvent) => {
    if (this.lifecycle !== "running") return;
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
    if (this.lifecycle !== "running") return;
    const size = weapon.projectileSize ?? 48;
    const mass = weapon.mass ?? 1;
    // 조준 보정: 느린 릴리즈일수록 드래그 방향을 캐릭터 방향으로 섞고, 최소 비행 속도를 보장
    // (놓은 자리에서 툭 떨어지지 않고 항상 '던져진' 궤적으로 날아감). 상한은 기존 1600 유지.
    const rawSpeed = Math.hypot(vx, vy);
    const tdx = this.doll.x - x;
    const tdy = this.doll.y - y;
    const tlen = Math.hypot(tdx, tdy) || 1;
    const aimX = tdx / tlen;
    const aimY = tdy / tlen;
    const assist = rawSpeed <= 0 ? 1 : Math.max(0, 1 - rawSpeed / THROW_ASSIST_FULL_SPEED);
    let dirX = rawSpeed > 0 ? vx / rawSpeed : aimX;
    let dirY = rawSpeed > 0 ? vy / rawSpeed : aimY;
    dirX = dirX * (1 - assist) + aimX * assist;
    dirY = dirY * (1 - assist) + aimY * assist;
    const dlen = Math.hypot(dirX, dirY) || 1;
    dirX /= dlen;
    dirY /= dlen;
    const flySpeed = Math.min(1600, Math.max(rawSpeed, THROW_MIN_FLY_SPEED));
    const launchVx = dirX * flySpeed;
    const launchVy = dirY * flySpeed - 90; // 살짝 띄워 포물선
    const launchPower = Math.max(power, flySpeed / 1600);
    // px/sec → matter px/step
    const body = this.physics.createProjectile(
      x,
      y,
      size,
      mass,
      launchVx / 60,
      launchVy / 60
    );
    Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.9);
    this.physics.add(body);
    const proj = new Projectile(body, weapon);
    this.projectileLayer.addChild(proj);
    this.projectiles.push(proj);
    playHitSound("whoosh", 0.6 + launchPower * 0.7);
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
    if (this.lifecycle !== "running") return;
    const dx = this.doll.x - x;
    const dy = this.doll.y - y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = dx / len;
    const ny = dy / len;
    // 탁! — 고속탄(등속 부유감 제거) + 총구 섬광 + 트레이서 광선
    const speed = 2600;
    const g = new Graphics();
    g.roundRect(-9, -2.2, 18, 4.4, 2.2).fill(weapon.color);
    g.roundRect(-4, -1.2, 9, 2.4, 1.2).fill({ color: 0xffffff, alpha: 0.9 });
    g.rotation = Math.atan2(ny, nx);
    g.x = x;
    g.y = y;
    this.projectileLayer.addChild(g);
    this.pellets.push({
      g,
      x,
      y,
      vx: nx * speed,
      vy: ny * speed,
      weapon,
    });
    this.fx.muzzleFlash(x + nx * 14, y + ny * 14, nx, ny);
    this.fx.tracer(x + nx * 18, y + ny * 18, x + nx * Math.min(len * 0.55, 150), y + ny * Math.min(len * 0.55, 150));
    playHitSound("crack", 0.9);
  };

  /** 매 프레임 pellet 전진 + 캐릭터 명중 판정 */
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
        // 딱콩 — 따끔: 붉은 플래시 + 탄 방향 움찔(강) + 히트스톱 + 스팅 스파이크 + 탄환 튕김 + 넉백 + 자국
        this.doll.triggerHit(w.shake * 1.4);
        this.doll.hitSquash(p.vx, p.vy, 1.0, { freq: 13, damp: 9 });
        this.doll.hitFlash(0xff6b6b, 0.07);
        this.addHitStop(0.03);
        this.fx.hitMarker(p.x, p.y);
        this.fx.impactLines(p.x, p.y, 0xff5a5a, 5);
        this.fx.ricochet(p.x, p.y, p.vx, p.vy, w.color);
        this.fx.burst(p.x, p.y, w.particleCount, w.color);
        const pl = Math.hypot(p.vx, p.vy) || 1;
        Body.applyForce(this.dollBody, this.dollBody.position, {
          x: (p.vx / pl) * 0.006,
          y: (p.vy / pl) * 0.006,
        });
        const hitLocal = this.doll.bodyWrap.toLocal({ x: p.x, y: p.y }, this);
        if (this.doll.isInsideBody(hitLocal.x, hitLocal.y)) {
          this.transientDecals.welt(hitLocal.x, hitLocal.y);
        }
        this.registerHitPulse(1);
        this.maybeYelp(0.5, 1);
        playHitSound("knock", 1.15);
        const gain = this.reportHit(p.x, p.y, w.strength, w.key);
        this.fx.scorePop(p.x, p.y - 20, gain, w.color);
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
    if (this.lifecycle !== "running") return;
    void length;
    this.doll.tremble(0.35);
    if (Math.random() < 0.2) {
      const head = this.headPos();
      this.fx.sweatDrops(head.x, head.y, 2);
    }
    playHitSound("scribble");
    this.reportHit(
      this.dollBody.position.x,
      this.dollBody.position.y,
      weapon.strength,
      weapon.key
    );
  };

  // ── collision (projectile ↔ doll) ──────────────────────────────────
  private handleCollision = (a: Body, b: Body) => {
    if (this.lifecycle !== "running") return;
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
    const factor = Math.min(THROW_FACTOR_MAX, Math.max(0.6, impactSpeed / 18));
    const points = Math.round(w.strength * factor);

    if (w.impact === "scatter") {
      // (은퇴 무기 잔존 경로) — 흩뿌려지며 타격
      this.fx.paperScatter(hx, hy, 12);
      this.fx.burst(hx, hy, w.particleCount, w.color);
      this.doll.triggerHit(w.shake * factor);
      playHitSound("rustle", 0.8 + factor * 0.4);
    } else {
      // 책/키보드 — 둔탁: 충돌 방향 스쿼시 + 붉은 플래시(충돌 세기 비례) + 히트스톱 + 파편 시그니처
      this.doll.triggerHit(w.shake * factor * 0.7);
      this.doll.hitSquash(projBody.velocity.x, projBody.velocity.y, factor);
      this.doll.hitFlash(0xff6e6e, 0.08 + 0.04 * Math.min(1, factor / THROW_FACTOR_MAX));
      this.fx.burst(hx, hy, Math.round(w.particleCount * 2 * factor), w.color);
      this.fx.shockwave(hx, hy, 30, 110 + 50 * factor, w.color);
      this.addShake(3 + 3 * factor);
      this.addHitStop(0.035 + 0.02 * Math.min(1, factor / THROW_FACTOR_MAX));
      if (w.key === "book") this.fx.paperScatter(hx, hy, 8, 0xf1e3c2);
      if (w.key === "keyboard") this.fx.letterDebris(hx, hy, 8);
      this.registerHitPulse(2);
      this.maybeYelp(0.65, factor > 1.5 ? 1 : 0);
      playHitSound("thud", 0.7 + factor * 0.5);
      if (w.key === "keyboard") playHitSound("clack", 0.8);
      // projectile momentum 으로 캐릭터 밀어내기.
      // collisionStart 안의 applyForce 는 matter 의 step 순서상 적분 전에
      // 클리어되어 no-op — setVelocity 로 직접 임펄스 적용.
      const v = projBody.velocity;
      const k = 0.04 * (w.mass ?? 1) * factor;
      Body.setVelocity(this.dollBody, {
        x: this.dollBody.velocity.x + v.x * k,
        y: this.dollBody.velocity.y + v.y * k,
      });
    }
    const gain = this.reportHit(hx, hy, points, w.key);
    this.fx.scorePop(hx, hy - 30, gain, w.color);
  };

  update(deltaSec: number) {
    if (this.lifecycle !== "running") return;
    // 히트스톱 — 큰 타격 순간 전체(물리·이펙트·궁극기) 짧은 동결로 임팩트 강조
    if (this.hitStop > 0) {
      this.hitStop -= deltaSec;
      if (this.hitStop > 0) return;
      this.hitStop = 0;
    }
    // 궁극기 난사타 — 발동 즉시 난타, 예산 소진까지 연속 가속(연타로 앞당김 가능) → 피니시
    if (this.ultActive) {
      this.ultBlowAccum += deltaSec;
      // 진행도² 로 간격이 좁아져 뒤로 갈수록 가속이 붙는다
      const k = this.ultProgress * this.ultProgress;
      const interval = ULT_BLOW_INTERVAL_START + (ULT_BLOW_INTERVAL_END - ULT_BLOW_INTERVAL_START) * k;
      while (this.ultBlowAccum >= interval && this.ultTimer > 0.25 && this.ultBudget > 0) {
        this.ultBlowAccum -= interval;
        this.ultBlow();
      }
      this.ultTimer -= deltaSec;
      // 마무리 직전(0.35s)까진 캐릭터를 계속 내던짐
      this.ultThrowAccum += deltaSec;
      while (this.ultThrowAccum >= ULT_THROW_INTERVAL && this.ultTimer > 0.35) {
        this.ultThrowAccum -= ULT_THROW_INTERVAL;
        this.ultThrow();
      }
      if (this.ultTimer <= 0) {
        this.ultActive = false;
        this.ultFinish();
      }
    }

    // drag 중에는 매 tick 손가락 위치에 고정 — 중력 velocity 누적으로
    // 캐릭터가 손에서 처지거나 (포인터 정지 시) 빠져나가는 것 방지.
    if (this.flingActive) {
      Body.setPosition(this.dollBody, this.flingPointerPos);
      Body.setVelocity(this.dollBody, { x: 0, y: 0 });
    }
    // 투척물 — 중력 일부 상쇄(포물선 눕힘) + 비행 잔상
    for (const proj of this.projectiles) {
      if (proj.hasHit) continue;
      const b = proj.body;
      Body.applyForce(b, b.position, {
        x: 0,
        y: -b.mass * 1.6 * 0.001 * THROW_GRAVITY_CANCEL,
      });
      proj.trailAccum += deltaSec;
      if (proj.trailAccum >= 0.045) {
        proj.trailAccum = 0;
        this.fx.ghost(
          b.position.x,
          b.position.y,
          proj.weapon.emoji,
          (proj.weapon.projectileSize ?? 48) * 0.9,
          b.angle
        );
      }
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
    if (this.ultActive || this.flingActive || this.dollSpring.stiffness === 0) {
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
    this.dazeFx.update(deltaSec);
    this.transientDecals.update(deltaSec);
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

    // 화면 흔들림 (궁극기) — ult 중엔 천천히, 끝나면 빠르게 0 으로 수렴
    if (this.ultShake > 0.3) {
      this.ultShake *= Math.pow(0.5, deltaSec * (this.ultActive ? 0.6 : 9));
      this.position.set(
        (Math.random() - 0.5) * this.ultShake,
        (Math.random() - 0.5) * this.ultShake
      );
    } else if (this.x !== 0 || this.y !== 0) {
      this.position.set(0, 0);
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
    if (
      !Number.isFinite(width) ||
      !Number.isFinite(height) ||
      width <= 0 ||
      height <= 0
    ) {
      return;
    }
    this.viewW = width;
    this.viewH = height;
    this.layoutBg();

    const anchorX = width / 2;
    const anchorY = height * 0.55;

    Body.setPosition(this.dollBody, { x: anchorX, y: anchorY });
    Body.setVelocity(this.dollBody, { x: 0, y: 0 });
    this.dollSpring.pointB = { x: anchorX, y: anchorY };

    const baseTarget = Math.min(width * 0.75, 420);
    // AI sprite 는 프레임 안에 캐릭터가 ~60-80% 로 들어가 있어 1.3 boost,
    // placeholder 는 머리 지름이 곧 전체 폭이라 그대로 두면 AI 보다 커 보임 — 0.8 보정.
    const targetDoll = this.doll.isSprite ? baseTarget * 1.3 : baseTarget * 0.8;
    this.doll.scale.set(targetDoll / this.doll.naturalSize);
    // 물리 body 반경을 표시 scale 에 동기화 — 안 하면 충돌 판정이
    // 보이는 캐릭터보다 한참 작고 벽 반사도 화면 밖으로 뚫림.
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

    // 벽 overhang: 캐릭터 body 반경의 70% 만큼 화면 밖으로 — 좁은 화면에서
    // body 가 좌우 벽 사이에 끼어 수평 이동 불가가 되는 것 방지.
    const bodyRadius = this.doll.naturalSize * 0.55 * nextScale;
    const overhang = bodyRadius * 0.7;
    for (const w of this.walls) this.physics.remove(w);
    this.walls = this.physics.createWalls(width, height, overhang);
    for (const w of this.walls) this.physics.add(w);

  }

  private clearTransientAttacks() {
    for (const p of this.projectiles) {
      if (p.parent === this.projectileLayer) {
        this.projectileLayer.removeChild(p);
      }
      this.physics.remove(p.body);
      p.destroy({ children: true });
    }
    this.projectiles = [];
    for (const p of this.pellets) {
      if (p.g.parent === this.projectileLayer) {
        this.projectileLayer.removeChild(p.g);
      }
      p.g.destroy();
    }
    this.pellets = [];
  }

  destroy() {
    this.end();
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
    this.physics.destroy();
    super.destroy({ children: true });
  }
}
