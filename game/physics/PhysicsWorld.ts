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

  /** 화면 4벽 — 인형 던질 때 튕김. category 0x0008, doll(0x0002)만 충돌. */
  createWalls(width: number, height: number): Body[] {
    const thick = 60;
    const opts = {
      isStatic: true,
      restitution: 0.7,
      label: "wall",
      collisionFilter: { category: 0x0008, mask: 0x0002 },
    };
    return [
      Bodies.rectangle(width / 2, -thick / 2, width + thick * 2, thick, opts), // top
      Bodies.rectangle(width / 2, height + thick / 2, width + thick * 2, thick, opts), // bottom
      Bodies.rectangle(-thick / 2, height / 2, thick, height + thick * 2, opts), // left
      Bodies.rectangle(width + thick / 2, height / 2, thick, height + thick * 2, opts), // right
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
