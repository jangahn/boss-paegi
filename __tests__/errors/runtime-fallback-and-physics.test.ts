import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  MATTER_MAX_STEP_MS,
  PHYSICS_FRAME_CLAMP_MS,
  planPhysicsSteps,
} from "../../lib/physics-clock.ts";

test("route and root runtime fallbacks own a document title and h1", () => {
  const route = readFileSync("app/error.tsx", "utf8");
  const global = readFileSync("app/global-error.tsx", "utf8");

  for (const source of [route, global]) {
    assert.match(source, /document\.title = ERROR_TITLE/);
    assert.match(source, /<title>\{ERROR_TITLE\}<\/title>/);
    assert.match(source, /<h1(?:\s|>)/);
  }
});

test("physics plans every finite render delta without exceeding Matter's limit", () => {
  const boundaryValues = [
    Number.MIN_VALUE,
    0.001,
    1000 / 360,
    1000 / 240,
    1000 / 144,
    1000 / 120,
    MATTER_MAX_STEP_MS,
    MATTER_MAX_STEP_MS + Number.EPSILON,
    17,
    31.999,
    PHYSICS_FRAME_CLAMP_MS,
    33,
    100,
    Number.MAX_VALUE,
  ];

  for (const input of boundaryValues) {
    const plan = planPhysicsSteps(input);
    assert.ok(Number.isSafeInteger(plan.steps) && plan.steps >= 1, String(input));
    assert.ok(plan.stepMs > 0 && plan.stepMs <= MATTER_MAX_STEP_MS, String(input));
    assert.ok(
      plan.steps * plan.stepMs <= PHYSICS_FRAME_CLAMP_MS,
      String(input),
    );
    assert.ok(
      Math.abs(
        plan.steps * plan.stepMs -
          Math.min(input, PHYSICS_FRAME_CLAMP_MS),
      ) <= Number.EPSILON * PHYSICS_FRAME_CLAMP_MS,
      String(input),
    );
  }
});

test("invalid and non-positive physics clocks are no-ops", () => {
  for (const input of [Number.NaN, Number.POSITIVE_INFINITY, -Infinity, -1, -0, 0]) {
    assert.deepEqual(planPhysicsSteps(input), { steps: 0, stepMs: 0 });
  }
});
