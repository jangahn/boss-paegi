import assert from "node:assert/strict";
import test from "node:test";
import { loadClientAssetWithDeadline } from "../../lib/client-asset-load.ts";

test("client asset loading returns the single confirmed value", async () => {
  let attempts = 0;
  const value = await loadClientAssetWithDeadline(
    async () => {
      attempts += 1;
      return { texture: "ready" };
    },
    { deadlineMs: 20, attemptMs: 10 },
  );
  assert.deepEqual(value, { texture: "ready" });
  assert.equal(attempts, 1);
});

test("a non-cooperative asset loader is deadline-bounded and never replayed", async () => {
  let attempts = 0;
  const startedAt = performance.now();
  await assert.rejects(
    loadClientAssetWithDeadline(
      async () => {
        attempts += 1;
        return new Promise<never>(() => {});
      },
      { deadlineMs: 30, attemptMs: 10 },
    ),
    /client_asset_load_unconfirmed/,
  );
  assert.equal(attempts, 1);
  assert.ok(performance.now() - startedAt < 500);
});

test("asset loading stops publishing when its owning lifecycle aborts", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const pending = loadClientAssetWithDeadline(
    async () => {
      attempts += 1;
      return new Promise<never>(() => {});
    },
    {
      signal: controller.signal,
      deadlineMs: 1_000,
      attemptMs: 500,
    },
  );
  controller.abort(new Error("effect_cleanup"));
  await assert.rejects(pending, /effect_cleanup/);
  assert.equal(attempts, 1);
});
