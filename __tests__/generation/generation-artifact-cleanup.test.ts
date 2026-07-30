import test from "node:test";
import assert from "node:assert/strict";
import { completeGenerationArtifactCleanup } from "../../lib/character-gen/generation-artifact-cleanup.ts";

test("cleanup marker runs only after candidate and face cleanup", async () => {
  const calls: string[] = [];
  const result = await completeGenerationArtifactCleanup({
    beginCleanup: async () => {
      calls.push("begin");
      return { data: { outcome: "ready" }, error: null };
    },
    cleanupCandidates: async () => {
      calls.push("candidates");
    },
    cleanupFace: async () => {
      calls.push("face");
    },
    markComplete: async () => {
      calls.push("marker");
      return { data: { outcome: "cleaned" }, error: null };
    },
  });
  assert.deepEqual(result, { ok: true, outcome: "cleaned" });
  assert.deepEqual(calls, ["begin", "candidates", "face", "marker"]);
});

test("active write lease blocks physical cleanup and marker", async () => {
  const calls: string[] = [];
  const result = await completeGenerationArtifactCleanup({
    beginCleanup: async () => ({
      data: { outcome: "write_busy" },
      error: null,
    }),
    cleanupCandidates: async () => {
      calls.push("candidates");
    },
    cleanupFace: async () => {
      calls.push("face");
    },
    markComplete: async () => {
      calls.push("marker");
      return { data: { outcome: "cleaned" }, error: null };
    },
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.stage, "cleanup_begin");
    assert.equal(result.outcome, "write_busy");
  }
  assert.deepEqual(calls, []);
});

test("already-cleaned begin is idempotent without touching Storage", async () => {
  const calls: string[] = [];
  const result = await completeGenerationArtifactCleanup({
    beginCleanup: async () => ({
      data: { outcome: "already_cleaned" },
      error: null,
    }),
    cleanupCandidates: async () => {
      calls.push("candidates");
    },
    cleanupFace: async () => {
      calls.push("face");
    },
    markComplete: async () => {
      calls.push("marker");
      return { data: { outcome: "cleaned" }, error: null };
    },
  });
  assert.deepEqual(result, { ok: true, outcome: "already_cleaned" });
  assert.deepEqual(calls, []);
});

test("candidate/face failures prohibit cleanup marker", async () => {
  for (const failStage of ["candidates", "face"] as const) {
    const calls: string[] = [];
    const result = await completeGenerationArtifactCleanup({
      cleanupCandidates: async () => {
        calls.push("candidates");
        if (failStage === "candidates") throw new Error("candidate failure");
      },
      cleanupFace: async () => {
        calls.push("face");
        if (failStage === "face") throw new Error("face failure");
      },
      markComplete: async () => {
        calls.push("marker");
        return { data: { outcome: "cleaned" }, error: null };
      },
    });
    assert.equal(result.ok, false);
    assert.equal(calls.includes("marker"), false);
  }
});

test("resolved marker errors and unexpected outcomes remain retryable", async () => {
  const resolved = new Error("rpc failed");
  const errorResult = await completeGenerationArtifactCleanup({
    cleanupCandidates: async () => {},
    cleanupFace: async () => {},
    markComplete: async () => ({ data: null, error: resolved }),
  });
  assert.deepEqual(errorResult, {
    ok: false,
    stage: "cleanup_marker",
    error: resolved,
    outcome: undefined,
  });

  const conflictResult = await completeGenerationArtifactCleanup({
    cleanupCandidates: async () => {},
    cleanupFace: async () => {},
    markComplete: async () => ({
      data: { outcome: "conflict" },
      error: null,
    }),
  });
  assert.equal(conflictResult.ok, false);
  if (!conflictResult.ok) assert.equal(conflictResult.outcome, "conflict");
});
