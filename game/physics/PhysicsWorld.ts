import {
  Engine,
  World,
  Bodies,
  Body,
  Composite,
  Constraint,
  Events,
  type IEventCollision,
} from "matter-js";

export type CollisionListener = (
  bodyA: Body,
  bodyB: Body,
  e: IEventCollision<Engine>
) => void;

/**
 * PixiJS 와 좌표계 공유 (y 가 아래로 +). matter.js 기본도 동일.
 * 별도 Render 사용 안 함 — PixiJS Sprite 가 body.position 따라가게 매 프레임 sync.
 */
export class PhysicsWorld {
  readonly engine: Engine;
  readonly world: World;
  private collisionListeners: CollisionListener[] = [];

  constructor() {
    this.engine = Engine.create({
      gravity: { x: 0, y: 1.6, scale: 0.001 },
    });
    this.world = this.engine.world;
    Events.on(this.engine, "collisionStart", this.handleCollision);
  }

  private handleCollision = (e: IEventCollision<Engine>) => {
    for (const pair of e.pairs) {
      for (const fn of this.collisionListeners) {
        fn(pair.bodyA, pair.bodyB, e);
      }
    }
  };

  onCollision(fn: CollisionListener) {
    this.collisionListeners.push(fn);
    return () => {
      this.collisionListeners = this.collisionListeners.filter((f) => f !== fn);
    };
  }

  add(body: Body | Constraint) {
    Composite.add(this.world, body);
  }

  remove(body: Body | Constraint) {
    Composite.remove(this.world, body);
  }

  step(deltaMs: number) {
    // 모바일에서 큰 dt 안전 처리: cap + sub-step
    const capped = Math.min(deltaMs, 32);
    Engine.update(this.engine, capped);
  }

  destroy() {
    Events.off(this.engine, "collisionStart", this.handleCollision);
    this.collisionListeners = [];
    World.clear(this.world, false);
    Engine.clear(this.engine);
  }

  // ── factory helpers ────────────────────────────────────────────────
  createDollAnchor(x: number, y: number, radius: number): Body {
    // 인형 body — dynamic 이지만 spring 으로 anchor 에 묶여 복귀.
    // walls 와 충돌하려면 mask 에 0x0008 (wall category) 포함.
    return Bodies.circle(x, y, radius, {
      mass: 6,
      frictionAir: 0.14,
      label: "doll",
      restitution: 0.5,
      collisionFilter: { category: 0x0002, mask: 0x0001 | 0x0008 },
    });
  }

  /** anchor 의 (x,y) 위치로 spring constraint 로 doll 을 묶음. */
  createDollSpring(dollBody: Body, anchorX: number, anchorY: number): Constraint {
    return Constraint.create({
      bodyA: dollBody,
      pointB: { x: anchorX, y: anchorY },
      stiffness: 0.06,
      damping: 0.12,
      length: 0,
    });
  }

  /**
   * 화면 4벽 — 인형 던질 때 튕김. category 0x0008, doll(0x0002)만 충돌.
   * 두께 400: 고속 fling 이 한 step 에 벽을 관통(tunneling)하거나 침투가
   * 깊어 분리 임펄스가 바깥쪽으로 향해 탈출하는 것 방지.
   *
   * @param overhang 벽 안쪽 면을 화면 밖으로 후퇴시키는 거리(px).
   *   인형 body 가 화면 폭 대비 클 때 (좁은 모바일) 벽 사이에 끼어
   *   수평 이동이 불가능해지는 것 방지 — 인형이 화면 밖으로 일부
   *   나갔다 튕겨 돌아오는 연출도 자연스러움.
   */
  createWalls(width: number, height: number, overhang = 0): Body[] {
    const thick = 400;
    const opts = {
      isStatic: true,
      restitution: 0.7,
      label: "wall",
      collisionFilter: { category: 0x0008, mask: 0x0002 },
    };
    const o = overhang;
    const spanW = width + o * 2 + thick * 2;
    const spanH = height + o * 2 + thick * 2;
    return [
      Bodies.rectangle(width / 2, -o - thick / 2, spanW, thick, opts), // top
      Bodies.rectangle(width / 2, height + o + thick / 2, spanW, thick, opts), // bottom
      Bodies.rectangle(-o - thick / 2, height / 2, thick, spanH, opts), // left
      Bodies.rectangle(width + o + thick / 2, height / 2, thick, spanH, opts), // right
    ];
  }

  createProjectile(
    x: number,
    y: number,
    size: number,
    mass: number,
    vx: number,
    vy: number
  ): Body {
    const body = Bodies.rectangle(x, y, size, size, {
      mass,
      frictionAir: 0.005,
      restitution: 0.3,
      label: "projectile",
      angle: Math.random() * Math.PI,
      collisionFilter: { category: 0x0001, mask: 0x0002 | 0x0004 },
    });
    Body.setVelocity(body, { x: vx, y: vy });
    Body.setAngularVelocity(body, (Math.random() - 0.5) * 0.4);
    return body;
  }

  createGround(x: number, y: number, width: number): Body {
    return Bodies.rectangle(x, y, width, 40, {
      isStatic: true,
      label: "ground",
      collisionFilter: { category: 0x0004, mask: 0x0001 },
    });
  }
}
