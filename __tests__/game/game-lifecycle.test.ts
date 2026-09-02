import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";
import type { FederatedPointerEvent } from "pixi.js";

register("./node-loader.mjs", import.meta.url);

const { PlayScene } = await import("../../game/scenes/PlayScene.ts");
const {
  bindGamePointerCancellation,
  bindGameVisibilityLifecycle,
} = await import("../../game/BossPaegiGame.ts");
const { useGameStore } = await import("../../store/gameStore.ts");
const { WEAPONS } = await import("../../lib/weapons.ts");

function weapon(key: string) {
  const found = WEAPONS.find((candidate) => candidate.key === key);
  assert.ok(found, `missing weapon ${key}`);
  return found;
}

function pointer(
  pointerId: number,
  x = 20,
  y = 20,
): FederatedPointerEvent {
  return {
    pointerId,
    global: { x, y },
    stopPropagation() {},
  } as unknown as FederatedPointerEvent;
}

function privateValue<T>(target: object, key: string): T {
  return Reflect.get(target, key) as T;
}

function privateCall<T>(
  target: object,
  key: string,
  ...args: unknown[]
): T {
  const callable = Reflect.get(target, key) as (...values: unknown[]) => T;
  return Reflect.apply(callable, target, args);
}

test("game store accepts start-hit, freezes both hit modes after end, and reopens only on restart", (t) => {
  let now = 0;
  t.mock.method(performance, "now", () => now);
  const store = useGameStore.getState();
  store.reset();
  const before = useGameStore.getState();
  assert.equal(before.hit(12, "fist"), 0);
  assert.equal(before.hit(20, "fist", false), 0);
  assert.equal(useGameStore.getState().score, 0);

  now = 10;
  useGameStore.getState().start();
  now = 20;
  const firstGain = useGameStore.getState().hit(12, "fist");
  assert.ok(firstGain > 0);
  const endedScore = useGameStore.getState().score;
  useGameStore.getState().end();
  now = 30;
  assert.equal(useGameStore.getState().hit(12, "fist"), 0);
  assert.equal(useGameStore.getState().hit(20, "fist", false), 0);
  assert.equal(useGameStore.getState().score, endedScore);
  assert.equal(useGameStore.getState().hitCount, 1);

  now = 40;
  useGameStore.getState().start();
  now = 50;
  assert.ok(useGameStore.getState().hit(12, "fist") > 0);
  assert.equal(useGameStore.getState().hitCount, 1);
  useGameStore.getState().reset();
});

test("visibility lifecycle composes blur and hidden reasons and removes every listener", () => {
  const win = new EventTarget();
  const doc = new EventTarget();
  let visibility: DocumentVisibilityState = "visible";
  const transitions: string[] = [];
  const unbind = bindGameVisibilityLifecycle(
    {
      pause: () => transitions.push("pause"),
      resume: () => transitions.push("resume"),
    },
    win,
    doc,
    () => visibility,
  );
  assert.deepEqual(transitions, ["resume"]);

  win.dispatchEvent(new Event("blur"));
  visibility = "hidden";
  doc.dispatchEvent(new Event("visibilitychange"));
  win.dispatchEvent(new Event("focus"));
  assert.deepEqual(transitions.slice(-3), ["pause", "pause", "pause"]);
  visibility = "visible";
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(transitions.at(-1), "resume");

  const beforeCleanup = transitions.length;
  unbind();
  win.dispatchEvent(new Event("blur"));
  doc.dispatchEvent(new Event("visibilitychange"));
  assert.equal(transitions.length, beforeCleanup);
});

test("native pointercancel reaches the scene exactly until listener cleanup", () => {
  const canvas = new EventTarget();
  let cancellations = 0;
  const unbind = bindGamePointerCancellation(
    { cancelActivePointers: () => { cancellations += 1; } } as never,
    canvas,
  );
  canvas.dispatchEvent(new Event("pointercancel"));
  assert.equal(cancellations, 1);
  unbind();
  canvas.dispatchEvent(new Event("pointercancel"));
  assert.equal(cancellations, 1);
});

test("PlayScene maps all 9 weapons to 7 categories and cancels every held state on blur/hidden", () => {
  const scene = new PlayScene({ app: {} as never });
  scene.layout(800, 600);
  const categories = new Set<string>();
  for (const current of WEAPONS) {
    scene.setWeapon(current);
    categories.add(privateValue(scene, "mode"));
    assert.equal(privateValue(scene, "mode"), current.category);
  }
  assert.deepEqual(
    [...categories].sort(),
    ["draw", "grab", "pinch", "shoot", "swipe", "tap", "throw"],
  );

  const win = new EventTarget();
  const doc = new EventTarget();
  let visibility: DocumentVisibilityState = "visible";
  const unbind = bindGameVisibilityLifecycle(
    scene,
    win,
    doc,
    () => visibility,
  );

  const cases = [
    ["book", "throwInput"],
    ["slap", "swipeInput"],
    ["gun", "shootInput"],
    ["pen", "drawInput"],
  ] as const;
  let pointerId = 10;
  for (const [key, inputKey] of cases) {
    scene.start();
    scene.setWeapon(weapon(key));
    const input = privateValue<{
      handlePointerDown: (event: FederatedPointerEvent) => void;
      pointerId: number | null;
    }>(scene, inputKey);
    input.handlePointerDown(pointer(pointerId));
    assert.equal(privateValue(input, "pointerId"), pointerId);
    win.dispatchEvent(new Event("blur"));
    assert.equal(privateValue(input, "pointerId"), null, `${key}: blur`);
    win.dispatchEvent(new Event("focus"));

    pointerId += 1;
    input.handlePointerDown(pointer(pointerId));
    assert.equal(privateValue(input, "pointerId"), pointerId);
    visibility = "hidden";
    doc.dispatchEvent(new Event("visibilitychange"));
    assert.equal(privateValue(input, "pointerId"), null, `${key}: hidden`);
    visibility = "visible";
    doc.dispatchEvent(new Event("visibilitychange"));
    pointerId += 1;
  }

  scene.start();
  scene.setWeapon(weapon("grab"));
  privateCall(scene, "handleDollPointerDown", pointer(pointerId));
  assert.equal(privateValue(scene, "dollPointerId"), pointerId);
  win.dispatchEvent(new Event("blur"));
  assert.equal(privateValue(scene, "dollPointerId"), null);
  win.dispatchEvent(new Event("focus"));

  unbind();
  scene.destroy();
});

test("actual Pixi pointerupoutside routing closes the held pointer sequence", () => {
  const scene = new PlayScene({ app: {} as never });
  scene.layout(800, 600);
  scene.setWeapon(weapon("gun"));
  const shoot = privateValue<{ pointerId: number | null }>(
    scene,
    "shootInput",
  );
  scene.emit("pointerdown", pointer(77, 10, 10));
  assert.equal(shoot.pointerId, 77);
  scene.emit("pointerupoutside", pointer(77, 20, 20));
  assert.equal(shoot.pointerId, null);
  scene.destroy();
});

test("held fire, in-flight pellets, and throw collisions cannot score after end; restart reactivates", () => {
  const hits: string[] = [];
  const scene = new PlayScene({
    app: {} as never,
    onHit: ({ weapon: key, strength }) => {
      hits.push(key);
      return strength;
    },
  });
  scene.layout(800, 600);

  scene.setWeapon(weapon("gun"));
  const shoot = privateValue<{
    handlePointerDown: (event: FederatedPointerEvent) => void;
  }>(scene, "shootInput");
  shoot.handlePointerDown(pointer(1, 20, 20));
  scene.update(0);
  assert.equal(privateValue<unknown[]>(scene, "pellets").length, 1);
  scene.end();
  scene.update(1);
  assert.equal(privateValue<unknown[]>(scene, "pellets").length, 0);
  assert.equal(hits.length, 0, "held fire end produces zero post-end hits");

  scene.start();
  scene.setWeapon(weapon("book"));
  privateCall(scene, "handleThrowLaunch", {
    x: 400,
    y: 100,
    vx: 0,
    vy: 800,
    power: 0.5,
    weapon: weapon("book"),
  });
  const firstProjectile = privateValue<Array<{ body: object }>>(
    scene,
    "projectiles",
  )[0];
  const dollBody = privateValue<object>(scene, "dollBody");
  privateCall(scene, "handleCollision", firstProjectile.body, dollBody);
  privateCall(scene, "handleCollision", firstProjectile.body, dollBody);
  assert.equal(hits.length, 1, "a projectile collision scores at most once");
  scene.update(0.2);
  assert.equal(privateValue<unknown[]>(scene, "projectiles").length, 0);

  privateCall(scene, "handleThrowLaunch", {
    x: 400,
    y: 100,
    vx: 0,
    vy: 800,
    power: 0.5,
    weapon: weapon("book"),
  });
  const lateBody = privateValue<Array<{ body: object }>>(
    scene,
    "projectiles",
  )[0].body;
  scene.end();
  privateCall(scene, "handleCollision", lateBody, dollBody);
  privateCall(scene, "reportHit", 400, 300, 999, "book");
  assert.equal(hits.length, 1, "post-end callbacks are fenced");

  scene.start();
  const restartGain = privateCall<number>(
    scene,
    "reportHit",
    400,
    300,
    16,
    "book",
  );
  assert.equal(restartGain, 16);
  assert.equal(hits.length, 2);
  scene.destroy();
});

test("pause freezes delta updates, ultimate stop/retrigger is fenced, and end blocks retrigger", () => {
  let hits = 0;
  const scene = new PlayScene({
    app: {} as never,
    onHit: ({ strength }) => {
      hits += 1;
      return strength;
    },
  });
  scene.layout(800, 600);
  scene.triggerUltimate();
  assert.equal(privateValue(scene, "ultActive"), true);
  scene.update(0);
  assert.equal(hits, 0);
  scene.pause();
  scene.update(0.1);
  assert.equal(hits, 0, "100ms while paused is fully frozen");
  scene.resume();
  // 궁극기 인트로 슬로모(ULT_INTRO_SEC 0.35s 실시간) 동안은 난타가 시작되지 않는다 —
  // resume 이후 시간이 실제로 흐르는지는 인트로를 지나 확인.
  for (let i = 0; i < 6; i++) scene.update(0.1);
  assert.ok(hits > 0);

  scene.stopUltimate();
  assert.equal(privateValue(scene, "ultActive"), false);
  scene.triggerUltimate();
  assert.equal(privateValue(scene, "ultActive"), true, "running scene retriggers");
  scene.end();
  assert.equal(privateValue(scene, "ultActive"), false);
  scene.triggerUltimate();
  assert.equal(privateValue(scene, "ultActive"), false, "ended scene stays fenced");
  scene.destroy();
});

test("zero-size layout is a no-op, positive resize remains finite, and destroy clears restore timers", () => {
  const scene = new PlayScene({ app: {} as never });
  scene.layout(0, 0);
  assert.equal(privateValue(scene, "viewW"), 0);
  scene.layout(800, 600);
  assert.equal(privateValue(scene, "viewW"), 800);
  const body = privateValue<{
    position: { x: number; y: number };
    mass: number;
  }>(scene, "dollBody");
  assert.equal(Number.isFinite(body.position.x) && Number.isFinite(body.mass), true);
  scene.layout(0, 0);
  scene.layout(800, 600);
  assert.equal(Number.isFinite(body.position.x) && Number.isFinite(body.mass), true);

  const timer = setTimeout(() => {
    throw new Error("restore timer leaked past destroy");
  }, 1_000);
  Reflect.set(scene, "springRestoreTimer", timer);
  scene.destroy();
  assert.equal(privateValue(scene, "springRestoreTimer"), null);
});
