import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("./node-loader.mjs", import.meta.url);

const {
  DrawingLayer,
  MAX_DRAW_SEGMENTS,
  MAX_DRAW_DOTS_PER_SEGMENT,
} = await import("../../game/entities/DrawingLayer.ts");
const { Projectile } = await import("../../game/entities/Projectile.ts");
const { Bodies } = await import("./matter-js-shim.mjs");
const { WEAPONS } = await import("../../lib/weapons.ts");

function weapon(key: string) {
  const found = WEAPONS.find((candidate) => candidate.key === key);
  assert.ok(found, `missing weapon ${key}`);
  return found;
}

test("DrawingLayer batches dots, caps segments deterministically, and clear releases all geometry", () => {
  const transitions: boolean[] = [];
  const layer = new DrawingLayer(
    () => true,
    (hasDrawing) => transitions.push(hasDrawing),
  );
  layer.beginStroke(0, 0);
  layer.extendStroke(100, 0, 0x112233, 3);
  assert.equal(
    layer.children.length,
    1,
    "one pointer sample is one batched Graphics, not one object per dot",
  );
  assert.ok(MAX_DRAW_DOTS_PER_SEGMENT >= 1);
  const first = layer.children[0];

  for (let index = 1; index <= MAX_DRAW_SEGMENTS + 32; index += 1) {
    layer.extendStroke(
      100 + index * 4,
      index % 7,
      0x112233,
      3,
    );
  }
  assert.equal(layer.children.length, MAX_DRAW_SEGMENTS);
  assert.equal(first.destroyed, true, "oldest segment is evicted and destroyed");
  assert.deepEqual(transitions, [true]);

  layer.clear();
  assert.equal(layer.children.length, 0);
  assert.equal(layer.hasDrawing, false);
  assert.deepEqual(transitions, [true, false]);
  layer.destroy();
});

test("long-session drawing work remains bounded by object and per-segment caps", () => {
  const layer = new DrawingLayer(() => true);
  layer.beginStroke(0, 0);
  for (let index = 1; index <= 4_000; index += 1) {
    // Large jumps also exercise MAX_DRAW_DOTS_PER_SEGMENT.
    layer.extendStroke(index * 200, index % 11, 0x000000, 2);
  }
  assert.equal(layer.children.length, MAX_DRAW_SEGMENTS);
  assert.ok(
    layer.children.length * MAX_DRAW_DOTS_PER_SEGMENT <=
      32_768,
    "the worst-case retained dot geometry is finite",
  );
  layer.clear();
  layer.destroy();
});

test("Projectile cleans up beyond all four viewport boundaries including the top", () => {
  const cases = [
    { x: 100, y: -201 },
    { x: 100, y: 801 },
    { x: -201, y: 100 },
    { x: 1_001, y: 100 },
  ];
  for (const position of cases) {
    const body = Bodies.rectangle(position.x, position.y, 10, 10);
    const projectile = new Projectile(body, weapon("book"));
    projectile.syncFromBody(800, 600, 0);
    assert.equal(projectile.isDead, true, JSON.stringify(position));
    projectile.destroy({ children: true });
  }

  const boundaryBody = Bodies.rectangle(100, -200, 10, 10);
  const boundary = new Projectile(boundaryBody, weapon("book"));
  boundary.syncFromBody(800, 600, 0);
  assert.equal(boundary.isDead, false, "exact top boundary is still in range");
  boundary.destroy({ children: true });
});
