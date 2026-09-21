import { Point, type FederatedPointerEvent } from "pixi.js";
import type { Doll } from "@/game/entities/Doll";
import type { Weapon, WeaponCategory } from "@/lib/weapons";
import type { AttackKey, KeyPhase } from "@/lib/keyboard-controls";
import { KEYBOARD_TUNING } from "@/lib/game-tuning";

/** PlayScene 이 넘겨주는 기존 포인터 핸들러·상태 — 키보드는 이 길로만 게임에 들어간다. */
type Host = {
  doll: Doll;
  mode: () => WeaponCategory;
  ultActive: () => boolean;
  view: () => { w: number; h: number };
  dollDown: (e: FederatedPointerEvent) => void;
  dollMove: (e: FederatedPointerEvent) => void;
  dollUp: (e: FederatedPointerEvent) => void;
  stageDown: (e: FederatedPointerEvent) => void;
  stageMove: (e: FederatedPointerEvent) => void;
  stageUp: (e: FederatedPointerEvent) => void;
  /** 싸대기 — 손바닥 표시(준비·가속·여운)와 임팩트 순간의 타격 보고. 포인터 싸대기와 같은 타격 함수(handleSwipeHit)다. */
  weapon: () => Weapon;
  swipePalm: (x: number, y: number, vx: number, vy: number) => void;
  swipePalmHide: () => void;
  swipeHit: (info: { x: number; y: number; speed: number; dirX: number; dirY: number; weapon: Weapon }) => void;
  /** 키 동작이 받아들여질 때마다(쿨다운 통과·제스처 시작·궁극기 연타) — 텔레메트리 keyActions */
  onAction?: () => void;
};

type Vec = { x: number; y: number };
type ArrowKey = Exclude<AttackKey, "space">;

/** 진행 중인 제스처 — 한 번에 하나(포인터 쪽도 싸대기·잡기·꼬집기·총·펜은 한 손가락). 탭·투척은 즉시 끝나 상태가 없다. */
type Gesture =
  | { kind: "swipe"; dir: Vec; startedAt: number; chained: boolean; hits: number }
  | { kind: "grab"; start: Vec; dir: Vec; startedAt: number; chained: boolean }
  | { kind: "pinch"; pull: Vec; vel: Vec; heading: number }
  | { kind: "shoot"; angle: number }
  | { kind: "draw"; local: Vec; heading: number };

/** 가상 포인터 id — 실제 포인터(0 이상)와 겹치지 않는 음수. */
const VIRTUAL_POINTER_ID = -1001;

const DIRS: Readonly<Record<ArrowKey, Vec>> = {
  up: { x: 0, y: -1 },
  down: { x: 0, y: 1 },
  left: { x: -1, y: 0 },
  right: { x: 1, y: 0 },
};
const ARROWS = Object.keys(DIRS) as ArrowKey[];
/** 싸대기 동작 한 구간 — `in` 구간이 0(임팩트 지점)을 지나는 순간이 타격. hit = 그때 손이 가는 방향(1 = 누른 방향, -1 = 되돌아옴). */
type SwipeSeg = { readonly from: number; readonly to: number; readonly ms: number; readonly ease: "in" | "out"; readonly hit?: 1 | -1 };

/** 동작 시작부터 n 번째 임팩트까지 걸리는 시간(ms) — 2차 가속 구간에서 0 을 지나는 시점. */
function swipeImpactMs(segs: readonly SwipeSeg[], nth: number): number {
  let t = 0;
  let seen = 0;
  for (const seg of segs) {
    if (seg.hit && seen++ === nth) return t + seg.ms * Math.sqrt(-seg.from / (seg.to - seg.from));
    t += seg.ms;
  }
  return t;
}

/** 펜 조종이 가장자리에 막혔을 때 시도하는 방향 틀기(rad) — 작은 각부터, 좌우 번갈아. */
const PEN_SLIDE_TURNS = [0, 0.5, -0.5, 1.0, -1.0, 1.4, -1.4] as const;

/**
 * PC 키보드 입력(v1.50) — 스페이스·방향키를 **가상 포인터 제스처**로 바꿔 PlayScene 의 기존 핸들러에 넣는다.
 * 점수식·쿨다운·라이프사이클 펜스(`reportHit`)·이펙트를 전부 그대로 상속하므로 키보드는 포인터로 할 수 있는 것만 한다.
 *
 * 방향키 규칙(사용자 확정): 주먹·뿅망치·투척·비비탄총 = 그 방향 **부위를 타격**(투척·총은 그쪽에서 날아와 맞는다) /
 * 싸대기·잡아던지기 = 그 **방향으로** 치고·던진다 / 꼬집기·펜 = 누르는 동안 그 방향으로 **조종**(키를 바꾸면 방향도 바뀐다).
 * 방향은 **8방향** — 두 키를 같이 누르면 대각선. 한 번 누르고 끝나는 동작(탭·투척·싸대기·잡아던지기)은 첫 방향키 뒤
 * `chordMs` 만큼 기다려 같이 눌린 키를 한 동작으로 묶는다. 스페이스 = 랜덤(싸대기는 상하좌우, 꼬집기·펜은 방향을 계속 바꾸는 자동 움직임).
 * 누르고 있기는 꼬집기·비비탄총·펜만 의미가 있다. OS 키 반복은 호출부(useKeyboardControls)가 버린다.
 * 움직임은 등속이 아니다(사용자 조정) — 싸대기는 준비 동작 → 가속 → 임팩트 → 여운, 잡아던지기는 당겼다 가속해서 놓기,
 * 꼬집기는 관성이 있는 가속. 세기·빈도는 `KEYBOARD_TUNING` — 포인터로 낼 수 있는 세기·빈도 이하라 어뷰징 봉투 불변.
 */
export class KeyboardInput {
  private host: Host;
  private rng: () => number;
  private gesture: Gesture | null = null;
  /** 지금 눌려 있는 공격 키 — 방향(8방향)과 누르고 있기 판정의 근거 */
  private held = new Set<AttackKey>();
  /** 동시 입력 대기 중인 방향키 동작 — `chordMs` 뒤 update 가 발사한다 */
  private pending: { at: number; keys: Set<ArrowKey> } | null = null;
  private lastArrow: ArrowKey = "up";
  /** 지금 낼 수 없어 기억해 둔 입력 한 개(쿨다운·진행 중 동작) — 낼 수 있게 되는 즉시 낸다. 연타가 씹히지 않게. */
  private queued: { dir: Vec | null; at: number } | null = null;
  private lastTapAt = -Infinity;
  private lastThrowAt = -Infinity;
  private lastGrabAt = -Infinity;
  private lastSwipeImpactAt = -Infinity;
  /** 펜촉 마지막 위치(bodyWrap local) — 다음 획이 이어서 시작되는 자리 */
  private penLast: Vec | null = null;
  /** 자동 움직임(꼬집기·펜 스페이스)의 속도 물결 위상 — 등속 기계 동작이 아니라 빨라졌다 느려졌다 한다 */
  private pace = 0;

  constructor(host: Host, rng: () => number = Math.random) {
    this.host = host;
    this.rng = rng;
  }

  /** 진행 중인 제스처·대기 동작이 있는지 — 라이프사이클 검증용 관측점(다른 입력 클래스의 pointerId 와 같은 역할). */
  get active(): boolean {
    return this.gesture !== null || this.pending !== null || this.queued !== null;
  }

  /** 키 하나의 누름/뗌. */
  handle(key: AttackKey, phase: KeyPhase) {
    if (phase === "up") {
      this.held.delete(key);
      this.release();
      return;
    }
    this.held.add(key);
    if (key !== "space") this.lastArrow = key;
    if (this.host.ultActive()) {
      // 난타 중 = 연타(예산 앞당김). 최소 간격·예산은 ultMash 가 지킨다.
      this.host.stageDown(this.event(this.bodyPoint(key === "space" ? null : this.heldDir())));
      this.host.onAction?.();
      return;
    }
    const mode = this.host.mode();
    if (mode === "pinch") return this.startPinch();
    if (mode === "shoot") return this.startOrAimShoot(key);
    if (mode === "draw") return this.startDraw();
    // 한 번 누르고 끝나는 동작 — 스페이스는 즉시(랜덤), 방향키는 동시 입력을 잠깐 모아 8방향으로.
    if (key === "space") return this.request(mode, null);
    if (this.pending) this.pending.keys.add(key);
    else this.pending = { at: performance.now(), keys: new Set([key]) };
  }

  /** 매 프레임 — 대기 중인 방향키 동작 발사 + 여러 프레임에 걸친 제스처(스윕·끌기·당기기·낙서) 진행. */
  update(deltaSec: number) {
    const now = performance.now();
    if (this.pending && now - this.pending.at >= KEYBOARD_TUNING.chordMs) {
      const dir = this.dirOf(this.pending.keys);
      this.pending = null;
      this.request(this.host.mode(), dir);
    }
    if (this.queued) {
      if (now - this.queued.at > KEYBOARD_TUNING.bufferMs) this.queued = null;
      else if (this.fire(this.host.mode(), this.queued.dir)) this.queued = null;
    }
    const g = this.gesture;
    if (!g) return;
    if (g.kind === "swipe") return this.advanceSwipe(g);
    if (g.kind === "grab") return this.advanceGrab(g);
    if (g.kind === "pinch") this.advancePinch(g, deltaSec);
    else if (g.kind === "draw") this.advancePen(g, deltaSec);
  }

  /** blur·hidden·무기 전환·종료 — 점수/발사 없이 상태만 비운다(실제 입력 클래스는 PlayScene 이 같은 자리에서 취소). */
  cancel() {
    if (this.gesture?.kind === "swipe") this.host.swipePalmHide();
    this.gesture = null;
    this.pending = null;
    this.queued = null;
    this.held.clear();
  }

  // ── 한 번 누르고 끝나는 동작 ───────────────────────────────────────────
  /** 지금 낼 수 있으면 내고, 아니면 한 개만 기억해 둔다(나중 입력이 앞의 것을 덮는다). */
  private request(mode: WeaponCategory, dir: Vec | null) {
    if (!this.fire(mode, dir)) this.queued = { dir, at: performance.now() };
  }

  /** dir = null 이면 스페이스(랜덤). 반환 = 동작을 시작했는지(쿨다운·진행 중 동작에 막히면 false). */
  private fire(mode: WeaponCategory, dir: Vec | null): boolean {
    const now = performance.now();
    const doll = this.host.doll;
    if (mode === "tap") {
      if (now - this.lastTapAt < KEYBOARD_TUNING.tapMinMs) return false;
      this.lastTapAt = now;
      this.host.dollDown(this.event(this.bodyPoint(dir)));
    } else if (mode === "throw") {
      if (now - this.lastThrowAt < KEYBOARD_TUNING.throwMinMs) return false;
      this.lastThrowAt = now;
      // 제자리에서 놓기 = 터치의 탭 발사와 같은 길(조준 보정 + 최소 비행 속도).
      const e = this.event(this.spawnPoint(dir ?? this.randomDir()));
      this.host.stageDown(e);
      this.host.stageUp(e);
    } else if (mode === "swipe") {
      // 진행 중이면 두 타를 다 친 뒤에만 끊고 이어 친다(여운 캔슬). 연타는 임팩트 간격 120ms 에 맞춰 시작을 늦춘다.
      const g = this.gesture;
      if (g && (g.kind !== "swipe" || g.hits < 2)) return false;
      const chained = now - this.lastSwipeImpactAt < KEYBOARD_TUNING.swipeChainWindowMs;
      if (chained && now < this.lastSwipeImpactAt + KEYBOARD_TUNING.swipeChainMinMs - swipeImpactMs(KEYBOARD_TUNING.swipeChain, 0)) return false;
      const d = dir ?? DIRS[ARROWS[Math.floor(this.rng() * ARROWS.length)]]; // 스페이스 = 상하좌우 랜덤
      this.gesture = { kind: "swipe", dir: d, startedAt: now, chained, hits: 0 };
      this.advanceSwipe(this.gesture);
    } else if (mode === "grab") {
      if (this.gesture || now - this.lastGrabAt < KEYBOARD_TUNING.grabMinMs) return false;
      const chained = now - this.lastGrabAt < KEYBOARD_TUNING.grabChainWindowMs;
      this.lastGrabAt = now;
      const start = { x: doll.x, y: doll.y };
      this.gesture = { kind: "grab", start, dir: dir ?? this.randomDir(), startedAt: now, chained };
      this.host.dollDown(this.event(start));
    } else {
      return true; // 누르고 있는 무기로 바뀌었다 — 기억해 둔 입력은 버린다
    }
    this.host.onAction?.();
    return true;
  }

  // ── 누르고 있는 동작 ─────────────────────────────────────────────────
  private startPinch() {
    if (this.gesture) return; // 같은 꼬집기에 키만 더해진다(방향이 바뀐다)
    const doll = this.host.doll;
    this.gesture = { kind: "pinch", pull: { x: 0, y: 0 }, vel: { x: 0, y: 0 }, heading: this.rng() * Math.PI * 2 };
    this.host.dollDown(this.event({ x: doll.x, y: doll.y }));
    this.host.onAction?.();
  }

  private startOrAimShoot(key: AttackKey) {
    const g = this.gesture;
    if (g?.kind === "shoot") {
      // 누른 채 방향키를 바꾸면 총구가 그쪽으로 옮겨 간다(발사 줄기는 하나).
      if (key !== "space") this.host.stageMove(this.event(this.spawnPoint(this.heldDir() ?? this.angleDir(g.angle))));
      return;
    }
    if (g) return;
    const dir = key === "space" ? this.randomDir() : (this.heldDir() ?? DIRS[key]);
    this.gesture = { kind: "shoot", angle: Math.atan2(dir.y, dir.x) };
    this.host.stageDown(this.event(this.spawnPoint(dir)));
    this.host.onAction?.();
  }

  private startDraw() {
    if (this.gesture) return; // 같은 획에 키만 더해진다
    const start = this.penStart();
    this.gesture = { kind: "draw", local: start, heading: this.rng() * Math.PI * 2 };
    this.host.stageDown(this.event(this.toStage(start)));
    this.host.onAction?.();
  }

  /** 키를 뗄 때 — 누르고 있는 동작은 관련 키가 전부 떨어지면 끝난다. */
  private release() {
    const g = this.gesture;
    if (!g) return;
    if (this.held.size > 0) {
      // 총은 방향키를 떼도 남은 키 기준으로 총구를 다시 잡는다
      if (g.kind === "shoot") this.host.stageMove(this.event(this.spawnPoint(this.heldDir() ?? this.angleDir(g.angle))));
      return;
    }
    if (g.kind === "draw") {
      this.gesture = null;
      this.penLast = g.local;
      this.host.stageUp(this.event(this.toStage(g.local)));
    } else if (g.kind === "pinch") {
      const doll = this.host.doll;
      this.gesture = null;
      this.host.dollUp(this.event({ x: doll.x + g.pull.x, y: doll.y + g.pull.y }));
    } else if (g.kind === "shoot") {
      this.gesture = null;
      this.host.stageUp(this.event({ x: 0, y: 0 }));
    }
  }

  // ── 싸대기 — 왕복 2타: 준비 동작 → 정타 → 방향 전환 → 역타 → 여운 ───────────────
  /**
   * 손 위치는 실제 경과 시간의 함수(프레임 지터와 무관). `in` 구간이 임팩트 지점(머리 중심)을 지나는 프레임에 타격을 보고한다 —
   * 포인터 싸대기와 같은 타격 함수. 세기는 곡선에서 해석적으로: 온전한 준비 동작의 첫 타 = 그 순간 속도(계수 상한 2.0),
   * 나머지(역타·연타) = `swipeChainSpeed`(계수 1.6) — 빈도를 올린 만큼 한 타를 낮춰 포인터 최대 처리량 이하로 묶는다.
   */
  private advanceSwipe(g: Extract<Gesture, { kind: "swipe" }>) {
    const segs: readonly SwipeSeg[] = g.chained ? KEYBOARD_TUNING.swipeChain : KEYBOARD_TUNING.swipeFull;
    const t = performance.now() - g.startedAt;
    const face = this.toStage(this.headCenter());
    const doll = this.host.doll;
    const size = doll.naturalSize * (doll.scale.x || 1); // 구간 위치는 캐릭터 표시 크기에 대한 비율
    let start = 0;
    let along = segs[segs.length - 1].to * size;
    let speed = 0; // px/s, 누른 방향 +
    let passed = 0;
    for (const seg of segs) {
      const end = start + seg.ms;
      if (seg.hit && t >= start + seg.ms * Math.sqrt(-seg.from / (seg.to - seg.from))) passed += 1;
      if (t < end && t >= start) {
        const u = (t - start) / seg.ms;
        const k = seg.ease === "in" ? u * u : 1 - (1 - u) * (1 - u);
        along = (seg.from + (seg.to - seg.from) * k) * size;
        speed = ((seg.to - seg.from) * size * 2 * (seg.ease === "in" ? u : 1 - u) * 1000) / seg.ms;
      }
      start = end;
    }
    this.host.swipePalm(face.x + g.dir.x * along, face.y + g.dir.y * along, g.dir.x * speed, g.dir.y * speed);
    while (g.hits < passed) {
      const seg = segs.filter((x) => x.hit)[g.hits];
      const sign = seg.hit as 1 | -1;
      const impact = (2 * Math.sqrt((seg.to - seg.from) * -seg.from) * size * 1000) / seg.ms; // 0 을 지나는 순간의 속도(px/s)
      const first = !g.chained && g.hits === 0;
      g.hits += 1;
      this.lastSwipeImpactAt = performance.now();
      this.host.swipeHit({
        x: face.x,
        y: face.y,
        speed: first ? Math.abs(impact) : KEYBOARD_TUNING.swipeChainSpeed,
        dirX: g.dir.x * sign,
        dirY: g.dir.y * sign,
        weapon: this.host.weapon(),
      });
    }
    if (t >= start) {
      this.gesture = null;
      this.host.swipePalmHide();
    }
  }

  // ── 잡아던지기 — 살짝 당겼다 가속해서 놓기 ─────────────────────────────────
  /** 위치는 실제 경과 시간의 함수 — 씬이 performance.now() 로 재는 놓는 속도(마지막 80ms)가 프레임 지터와 무관해진다. */
  private advanceGrab(g: Extract<Gesture, { kind: "grab" }>) {
    const { grabWindupPx: back, grabThrowPx: reach } = KEYBOARD_TUNING;
    const w = g.chained ? KEYBOARD_TUNING.grabChainWindupMs : KEYBOARD_TUNING.grabWindupMs;
    const k = g.chained ? KEYBOARD_TUNING.grabChainThrowMs : KEYBOARD_TUNING.grabThrowMs;
    const t = performance.now() - g.startedAt;
    if (t < 16) return; // 첫 이동은 한 프레임 뒤(핸들러의 시간 하한 왜곡 방지)
    let along: number;
    if (t < w) {
      const u = t / w;
      along = -back * (1 - (1 - u) * (1 - u));
    } else {
      const u = (t - w) / k; // 끝점도 자르지 않는다 — 마지막 구간이 가장 빨라야 놓는 속도가 산다
      along = -back + (reach + back) * u * u;
    }
    const e = this.event({ x: g.start.x + g.dir.x * along, y: g.start.y + g.dir.y * along });
    this.host.dollMove(e);
    if (t >= w + k) {
      this.gesture = null;
      this.host.dollUp(e);
    }
  }

  // ── 꼬집기 — 당기는 점을 조종(방향키) 또는 자동으로 이리저리(스페이스), 관성 있는 가속 ────────
  private advancePinch(g: Extract<Gesture, { kind: "pinch" }>, deltaSec: number) {
    const doll = this.host.doll;
    const maxLen = doll.naturalSize * (doll.scale.x || 1) * 0.6;
    const steer = this.heldDir();
    let target: Vec;
    if (steer) {
      target = { x: steer.x * KEYBOARD_TUNING.pinchPullSpeed, y: steer.y * KEYBOARD_TUNING.pinchPullSpeed };
    } else if (this.held.has("space")) {
      g.heading += (this.rng() - 0.5) * 5 * deltaSec;
      const v = KEYBOARD_TUNING.pinchPullSpeed * 0.5 * this.paceFactor(deltaSec);
      target = { x: Math.cos(g.heading) * v, y: Math.sin(g.heading) * v };
    } else {
      return;
    }
    // 목표 속도로 지수 접근 — 정지에서 가속해 붙고, 방향을 바꾸면 관성을 안고 돌아간다.
    const blend = 1 - Math.exp(-KEYBOARD_TUNING.pinchAccel * deltaSec);
    g.vel = { x: g.vel.x + (target.x - g.vel.x) * blend, y: g.vel.y + (target.y - g.vel.y) * blend };
    let next = { x: g.pull.x + g.vel.x * deltaSec, y: g.pull.y + g.vel.y * deltaSec };
    const len = Math.hypot(next.x, next.y);
    if (len > maxLen) {
      // 한계 원에 닿으면 원 위에 묶고 바깥쪽 속도 성분을 버린다(원을 따라 미끄러진다). 자동 움직임은 안쪽으로 튕겨 방향을 바꾼다.
      const n = { x: next.x / len, y: next.y / len };
      next = { x: n.x * maxLen, y: n.y * maxLen };
      const out = g.vel.x * n.x + g.vel.y * n.y;
      if (out > 0) g.vel = { x: g.vel.x - out * n.x, y: g.vel.y - out * n.y };
      if (!steer) {
        const d = this.angleDir(g.heading);
        const dot = d.x * n.x + d.y * n.y;
        g.heading = Math.atan2(d.y - 2 * dot * n.y, d.x - 2 * dot * n.x) + (this.rng() - 0.5) * 0.8;
      }
    }
    g.pull = next;
    this.host.dollMove(this.event({ x: doll.x + next.x, y: doll.y + next.y }));
  }

  // ── 펜 ───────────────────────────────────────────────────────────────
  private advancePen(g: Extract<Gesture, { kind: "draw" }>, deltaSec: number) {
    const doll = this.host.doll;
    const base = (KEYBOARD_TUNING.penSpeed * deltaSec) / (doll.scale.x || 1);
    const steer = this.heldDir();
    let next: Vec | null = null;
    if (steer) {
      // 조종 — 누른 방향(두 키 = 대각선)으로. 가장자리에 막히면 방향을 조금씩 틀어 윤곽을 따라 미끄러지고(누른 쪽 성분이 남는
      // ±80° 안에서), 그래도 막히면 멈춘다 — 실루엣 밖으로는 나가지 않는다.
      const heading = Math.atan2(steer.y, steer.x);
      for (const turn of PEN_SLIDE_TURNS) {
        const c = { x: g.local.x + Math.cos(heading + turn) * base, y: g.local.y + Math.sin(heading + turn) * base };
        if (doll.isInsideBody(c.x, c.y)) {
          next = c;
          break;
        }
      }
    } else if (this.held.has("space")) {
      // 자동 곡선 — 진행 방향을 조금씩 틀며 방랑, 머리 영역을 벗어나려 하면 영역 중심 쪽으로 선회.
      g.heading += (this.rng() - 0.5) * 6 * deltaSec;
      const step = base * this.paceFactor(deltaSec);
      const head = this.headArea();
      for (let i = 0; i < 12; i++) {
        const c = { x: g.local.x + Math.cos(g.heading) * step, y: g.local.y + Math.sin(g.heading) * step };
        if (c.y <= head.y1 && doll.isInsideBody(c.x, c.y)) {
          next = c;
          break;
        }
        const toCenter = Math.atan2(head.cy - g.local.y, head.cx - g.local.x);
        const diff = Math.atan2(Math.sin(toCenter - g.heading), Math.cos(toCenter - g.heading));
        g.heading += Math.sign(diff || 1) * 0.5;
      }
    }
    if (!next) return;
    g.local = next;
    this.host.stageMove(this.event(this.toStage(next)));
  }

  /** 자동 움직임의 속도 배율(0.55~1.45) — 천천히 출렁이는 물결. 손으로 그릴 때처럼 빨라졌다 느려졌다 한다. */
  private paceFactor(deltaSec: number): number {
    this.pace += deltaSec * (2.2 + this.rng() * 2.4);
    return 1 + 0.45 * Math.sin(this.pace);
  }

  /** 머리 영역 = 실루엣 경계 상자의 위쪽 절반(치비 비율). */
  private headArea(): { cx: number; cy: number; y1: number } {
    const b = this.host.doll.getBodyBounds();
    const y1 = b.y0 + (b.y1 - b.y0) * 0.5;
    return { cx: (b.x0 + b.x1) / 2, cy: (b.y0 + y1) / 2, y1 };
  }

  /** 머리 한가운데(bodyWrap local) — 싸대기 임팩트 지점·펜 첫 획의 시작점. 실루엣 밖이면(드문 자산) 머리 쪽 아무 점. */
  private headCenter(): Vec {
    const head = this.headArea();
    return this.host.doll.isInsideBody(head.cx, head.cy) ? { x: head.cx, y: head.cy } : this.sampleBody({ x: 0, y: -1 });
  }

  private penStart(): Vec {
    const doll = this.host.doll;
    const head = this.headArea();
    if (this.penLast && this.penLast.y <= head.y1 && doll.isInsideBody(this.penLast.x, this.penLast.y)) {
      return this.penLast;
    }
    // 첫 획은 머리 한가운데서 — 어느 방향으로 조종해도 갈 자리가 있다(가장자리에서 시작하면 그쪽 방향키가 안 먹는 것처럼 보인다).
    return this.headCenter();
  }

  // ── 방향 ─────────────────────────────────────────────────────────────
  /** 키 묶음 → 단위 방향(8방향). 마주 보는 키가 같이 눌려 상쇄되면 마지막에 누른 방향키. */
  private dirOf(keys: Iterable<AttackKey>): Vec {
    let x = 0;
    let y = 0;
    for (const k of keys) {
      if (k === "space") continue;
      x += DIRS[k].x;
      y += DIRS[k].y;
    }
    if (x === 0 && y === 0) return DIRS[this.lastArrow];
    const len = Math.hypot(x, y);
    return { x: x / len, y: y / len };
  }

  /** 지금 눌린 방향키의 방향 — 방향키가 하나도 없으면 null. */
  private heldDir(): Vec | null {
    for (const k of this.held) if (k !== "space") return this.dirOf(this.held);
    return null;
  }

  private randomDir(): Vec {
    return this.angleDir(this.rng() * Math.PI * 2);
  }

  private angleDir(angle: number): Vec {
    return { x: Math.cos(angle), y: Math.sin(angle) };
  }

  // ── 좌표 ─────────────────────────────────────────────────────────────
  /**
   * 실루엣 안의 한 점(bodyWrap local). dir = 그 방향 부위(경계 상자에서 그쪽 45% 구역 — 대각선은 두 축 모두), null = 아무 데나.
   * 구역 모서리가 실루엣 밖일 수 있어(둥근 머리의 대각선 구석) 실패하면 구역 중심에서 몸 중심 쪽으로 당겨 가며 찾는다.
   */
  private sampleBody(dir: Vec | null): Vec {
    const doll = this.host.doll;
    const b = doll.getBodyBounds();
    const w = b.x1 - b.x0;
    const h = b.y1 - b.y0;
    const area = { ...b };
    if (dir) {
      if (dir.x < -0.3) area.x1 = b.x0 + w * 0.45;
      else if (dir.x > 0.3) area.x0 = b.x1 - w * 0.45;
      if (dir.y < -0.3) area.y1 = b.y0 + h * 0.45;
      else if (dir.y > 0.3) area.y0 = b.y1 - h * 0.45;
    }
    for (let i = 0; i < 24; i++) {
      const p = { x: area.x0 + this.rng() * (area.x1 - area.x0), y: area.y0 + this.rng() * (area.y1 - area.y0) };
      if (doll.isInsideBody(p.x, p.y)) return p;
    }
    const from = { x: (area.x0 + area.x1) / 2, y: (area.y0 + area.y1) / 2 };
    const to = { x: (b.x0 + b.x1) / 2, y: (b.y0 + b.y1) / 2 };
    for (let t = 0; t <= 1; t += 0.125) {
      const p = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      if (doll.isInsideBody(p.x, p.y)) return p;
    }
    return to;
  }

  /** 실루엣 안의 한 점(stage 좌표) — 탭·궁극기 연타의 타격점. */
  private bodyPoint(dir: Vec | null): Vec {
    return this.toStage(this.sampleBody(dir));
  }

  private toStage(local: Vec): Vec {
    const p = this.host.doll.bodyWrap.toGlobal(new Point(local.x, local.y));
    return { x: p.x, y: p.y };
  }

  /**
   * 투척·비비탄 발사 지점 — 캐릭터 중심에서 그 방향으로 피격 가능 범위(`spawnRatio × 표시 크기`, 최대 `spawnMaxPx`)만큼 떨어진 곳.
   * 그쪽에서 날아오므로 그 부위에 먼저 닿는다. 화면 밖이면 가장자리 안쪽으로 당긴다(가까워질 뿐 명중은 유지).
   */
  private spawnPoint(dir: Vec): Vec {
    const doll = this.host.doll;
    const { w, h } = this.host.view();
    const dist = Math.min(KEYBOARD_TUNING.spawnMaxPx, doll.naturalSize * (doll.scale.x || 1) * KEYBOARD_TUNING.spawnRatio);
    const m = KEYBOARD_TUNING.spawnMarginPx;
    return {
      x: Math.min(Math.max(doll.x + dir.x * dist, m), Math.max(m, w - m)),
      y: Math.min(Math.max(doll.y + dir.y * dist, m), Math.max(m, h - m)),
    };
  }

  /** 기존 핸들러가 읽는 필드만 가진 합성 이벤트(테스트 하네스와 같은 모양). */
  private event(global: Vec): FederatedPointerEvent {
    return {
      pointerId: VIRTUAL_POINTER_ID,
      global,
      stopPropagation() {},
    } as unknown as FederatedPointerEvent;
  }
}
