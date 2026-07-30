import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { topWeapon } = await import("../../store/gameStore.ts");

test("primary weapon is the highest hit-count weapon with stable first-use ties", () => {
  assert.equal(topWeapon({}), null);
  assert.equal(topWeapon({ fist: 1 }), "fist");
  assert.equal(topWeapon({ fist: 2, hammer: 1 }), "fist");
  assert.equal(topWeapon({ fist: 1, hammer: 2 }), "hammer");
  assert.equal(topWeapon({ fist: 2, hammer: 2 }), "fist");
  assert.equal(topWeapon({ hammer: 2, fist: 2 }), "hammer");
});

test("the game-over submission persists the same primary weapon it displays", () => {
  const modal = readFileSync(
    new URL("../../components/GameOverModal.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    modal,
    /const mainWeapon = topWeapon\(weaponCounts\) \?\? weapon;/,
  );
  assert.match(
    modal,
    /useScoreSubmission\(\{[\s\S]*?weapon: mainWeapon,/,
  );
  assert.match(modal, /<ScoreReport[\s\S]*?mainWeapon=\{mainWeapon\}/);
});
