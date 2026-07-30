import test from "node:test";
import assert from "node:assert/strict";
import {
  runFencedStorageCleanup,
  type FencedStorageLease,
} from "../../lib/fenced-storage-cleanup.ts";

const LEASE: FencedStorageLease = {
  jobId: "job",
  bucket: "avatars",
  path: "user/avatar.png",
  leaseToken: "token",
  leaseVersion: 3,
  attemptCount: 2,
};

test("Storage success followed by finish failure remains retryable", async () => {
  let removes = 0;
  const outcome = await runFencedStorageCleanup(LEASE, {
    remove: async () => {
      removes += 1;
      return { data: [{ name: LEASE.path }], error: null };
    },
    exists: async () => ({ data: false, error: null }),
    finish: async () => {
      throw new Error("injected DB finish failure");
    },
  });
  assert.equal(removes, 1);
  assert.deepEqual(outcome, {
    kind: "pending",
    jobId: "job",
    attemptCount: 2,
    failure: "cleanup_finish_failed",
    retryRecorded: false,
  });
});

test("resolved Storage error is recorded pending with the exact lease fence", async () => {
  const finishes: unknown[][] = [];
  const outcome = await runFencedStorageCleanup(LEASE, {
    remove: async () => ({
      data: null,
      error: new TypeError("resolved failure"),
    }),
    exists: async () => ({ data: false, error: null }),
    finish: async (...args) => {
      finishes.push(args);
      return "pending";
    },
  });
  assert.equal(outcome.kind, "pending");
  assert.deepEqual(finishes, [[LEASE, false, "TypeError"]]);
});

test("only terminal finish is reported completed", async () => {
  const pending = await runFencedStorageCleanup(LEASE, {
    remove: async () => ({ data: [{ name: LEASE.path }], error: null }),
    exists: async () => ({ data: false, error: null }),
    finish: async () => "pending",
  });
  assert.equal(pending.kind, "pending");

  const completed = await runFencedStorageCleanup(LEASE, {
    remove: async () => ({ data: [{ name: LEASE.path }], error: null }),
    exists: async () => ({ data: false, error: null }),
    finish: async () => "cleaned",
  });
  assert.equal(completed.kind, "completed");
});
