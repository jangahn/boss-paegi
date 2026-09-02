import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import type { FederatedPointerEvent } from "pixi.js";

register("./node-loader.mjs", import.meta.url);

const { Container } = await import("pixi.js");
const { ShootInput } = await import("../../game/input/ShootInput.ts");
const {
  ThrowInput,
  MAX_THROW_LAUNCH_SPEED,
} = await import("../../game/input/ThrowInput.ts");
const { SwipeInput } = await import("../../game/input/SwipeInput.ts");
const { DrawInput } = await import("../../game/input/DrawInput.ts");
const { DrawingLayer } = await import("../../game/entities/DrawingLayer.ts");
const { WEAPONS } = await import("../../lib/weapons.ts");

function weapon(key: string) {
  const found = WEAPONS.find((candidate) => candidate.key === key);
  assert.ok(found, `missing weapon ${key}`);
  return found;
}

function pointer(
  pointerId: number,
  x: number,
  y: number,
): FederatedPointerEvent {
  return {
    pointerId,
    global: { x, y },
    stopPropagation() {},
  } as unknown as FederatedPointerEvent;
}

test("ShootInput honors pointer identity, exact fire intervals, and cancellation", () => {
  const stage = new Container();
  const fires: Array<{ x: number; y: number; key: string }> = [];
  const input = new ShootInput(stage, {
    onFire: ({ x, y, weapon: current }) => {
      fires.push({ x, y, key: current.key });
    },
  });
  const gun = weapon("gun");
  input.setActive(true, gun);

  input.handlePointerDown(pointer(1, 10, 20));
  input.update(0, 100, 100);
  assert.equal(fires.length, 1, "pointerdown primes exactly one immediate shot");
  input.update(0.1, 100, 100);
  input.update(0.079, 100, 100);
  assert.equal(fires.length, 1);
  input.update(0.001, 100, 100);
  assert.equal(fires.length, 2, "180ms boundary fires");

  input.handlePointerUp(pointer(2, 10, 20));
  input.update(0.18, 100, 100);
  assert.equal(fires.length, 3, "another pointer cannot release the hold");
  input.handlePointerUp(pointer(1, 10, 20));
  input.update(1, 100, 100);
  assert.equal(fires.length, 3);

  input.handlePointerDown(pointer(3, 30, 40));
  input.cancel();
  input.update(10, 100, 100);
  assert.equal(fires.length, 3, "cancelled held fire produces zero later shots");
  input.destroy();
});

test("ThrowInput enforces speed boundaries, finite cap, identity, and same-category switch cancellation", (t) => {
  let now = 10;
  t.mock.method(performance, "now", () => now);
  const stage = new Container();
  const launches: Array<{
    vx: number;
    vy: number;
    power: number;
    key: string;
  }> = [];
  const input = new ThrowInput(stage, {
    onLaunch: ({ vx, vy, power, weapon: current }) => {
      launches.push({ vx, vy, power, key: current.key });
    },
  });
  const book = weapon("book");
  const keyboard = weapon("keyboard");
  input.setActive(true, book);

  input.handlePointerDown(pointer(1, 0, 0));
  now = 60;
  input.handlePointerMove(pointer(1, 12, 0)); // 12px / 50ms = 240px/s
  input.handlePointerUp(pointer(1, 12, 0));
  assert.equal(launches.length, 1, "minimum launch speed is inclusive");
  assert.equal(Math.round(Math.hypot(launches[0].vx, launches[0].vy)), 240);

  now = 100;
  input.handlePointerDown(pointer(2, 0, 0));
  now = 150;
  input.handlePointerMove(pointer(2, 11.99, 0));
  input.handlePointerUp(pointer(2, 11.99, 0));
  // 2026-09 규칙: 느린 릴리즈도 항상 던져진다 — power 0·속도 0 의 약한 토스로 넘기고
  // PlayScene 이 캐릭터 방향 조준 보정 + 최소 비행 속도를 준다(놓은 자리에서 떨어지지 않게).
  assert.equal(launches.length, 2, "below-minimum release becomes a weak toss");
  assert.equal(launches[1].power, 0);
  assert.equal(Math.hypot(launches[1].vx, launches[1].vy), 0);

  now = 200;
  input.handlePointerDown(pointer(3, 0, 0));
  now = 201;
  input.handlePointerMove(pointer(3, 100_000, -100_000));
  input.handlePointerUp(pointer(99, 100_000, -100_000));
  assert.equal(launches.length, 2, "wrong pointer cannot launch");
  input.handlePointerUp(pointer(3, 100_000, -100_000));
  assert.equal(launches.length, 3);
  const capped = launches[2];
  assert.equal(Number.isFinite(capped.vx) && Number.isFinite(capped.vy), true);
  assert.ok(
    Math.hypot(capped.vx, capped.vy) <= MAX_THROW_LAUNCH_SPEED + 1e-9,
  );
  assert.equal(capped.power, 1);

  now = 300;
  input.handlePointerDown(pointer(4, 0, 0));
  now = 340;
  input.handlePointerMove(pointer(4, 100, 0));
  input.setActive(true, keyboard);
  input.handlePointerUp(pointer(4, 100, 0));
  assert.equal(
    launches.length,
    3,
    "book down cannot become a keyboard launch after a category-preserving switch",
  );
  input.destroy();
});

test("SwipeInput applies exact speed/cooldown boundaries and pointer identity", (t) => {
  let now = 200;
  t.mock.method(performance, "now", () => now);
  const stage = new Container();
  const hits: number[] = [];
  const input = new SwipeInput(stage, {
    onSwipeHit: ({ speed }) => hits.push(speed),
    isOverDoll: () => true,
  });
  input.setActive(true, weapon("slap"));

  input.handlePointerDown(pointer(1, 0, 0));
  now = 208;
  input.handlePointerMove(pointer(2, 4, 0));
  assert.equal(hits.length, 0, "wrong pointer move is ignored");
  input.handlePointerMove(pointer(1, 4, 0)); // 4 / 8ms = 500px/s
  assert.equal(hits.length, 1, "minimum hit speed is inclusive");
  input.handlePointerUp(pointer(1, 4, 0));

  now = 300;
  input.handlePointerDown(pointer(3, 0, 0));
  now = 308;
  input.handlePointerMove(pointer(3, 4, 0));
  assert.equal(hits.length, 1, "149ms-or-less cooldown blocks another hit");
  input.handlePointerUp(pointer(3, 4, 0));

  now = 350;
  input.handlePointerDown(pointer(4, 0, 0));
  now = 358;
  input.handlePointerMove(pointer(4, 4, 0));
  assert.equal(hits.length, 2, "150ms cooldown boundary permits a hit");
  input.cancel();
  input.destroy();
});

test("DrawInput cancellation ends the active stroke and suppresses later moves", () => {
  const stage = new Container();
  const bodyWrap = new Container();
  stage.addChild(bodyWrap);
  const layer = new DrawingLayer(() => true);
  bodyWrap.addChild(layer);
  const strokes: number[] = [];
  const doll = {
    bodyWrap,
    scale: { x: 1 },
    isInsideBody: () => true,
  };
  const input = new DrawInput(
    stage,
    doll as never,
    layer,
    { onStroke: (length) => strokes.push(length) },
  );
  input.setActive(true, weapon("pen"));
  input.handlePointerDown(pointer(7, 0, 0));
  input.handlePointerMove(pointer(7, 50, 0));
  assert.equal(strokes.length, 1);
  const beforeCancel = layer.children.length;
  input.cancel();
  input.handlePointerMove(pointer(7, 100, 0));
  assert.equal(strokes.length, 1);
  assert.equal(layer.children.length, beforeCancel);
  layer.clear();
  layer.destroy();
  bodyWrap.destroy();
  stage.destroy();
});
