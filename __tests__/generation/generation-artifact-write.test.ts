import test from "node:test";
import assert from "node:assert/strict";
import {
  claimGenerationArtifactWrite,
  releaseGenerationArtifactWrite,
} from "../../lib/character-gen/generation-artifact-write.ts";

test("artifact write claim requires a claimed outcome and lease token", async () => {
  assert.deepEqual(
    await claimGenerationArtifactWrite(async () => ({
      data: { outcome: "claimed", lease_token: "lease-1" },
      error: null,
    })),
    { ok: true, leaseToken: "lease-1" },
  );
  assert.deepEqual(
    await claimGenerationArtifactWrite(async () => ({
      data: { outcome: "write_busy" },
      error: null,
    })),
    { ok: false, outcome: "write_busy" },
  );
  assert.deepEqual(
    await claimGenerationArtifactWrite(async () => ({
      data: { outcome: "claimed" },
      error: null,
    })),
    { ok: false, outcome: "claimed" },
  );
});

test("artifact write claim exposes resolved and thrown RPC failures", async () => {
  const resolved = new Error("claim resolved failure");
  assert.deepEqual(
    await claimGenerationArtifactWrite(async () => ({
      data: null,
      error: resolved,
    })),
    { ok: false, outcome: "rpc_error", error: resolved },
  );

  const thrown = new Error("claim thrown failure");
  assert.deepEqual(
    await claimGenerationArtifactWrite(async () => {
      throw thrown;
    }),
    { ok: false, outcome: "rpc_throw", error: thrown },
  );
});

test("artifact write release is successful only for matching released outcome", async () => {
  assert.deepEqual(
    await releaseGenerationArtifactWrite(async () => ({
      data: { outcome: "released" },
      error: null,
    })),
    { ok: true },
  );

  const lost = await releaseGenerationArtifactWrite(async () => ({
    data: { outcome: "lease_lost" },
    error: null,
  }));
  assert.equal(lost.ok, false);
  if (!lost.ok) assert.equal(lost.outcome, "lease_lost");

  const resolved = new Error("release failure");
  const failed = await releaseGenerationArtifactWrite(async () => ({
    data: null,
    error: resolved,
  }));
  assert.equal(failed.ok, false);
  if (!failed.ok) assert.equal(failed.error, resolved);
});
