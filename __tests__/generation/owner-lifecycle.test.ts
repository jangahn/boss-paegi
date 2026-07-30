import test from "node:test";
import assert from "node:assert/strict";
import {
  ownerStateFromProfileRead,
  runOwnerGuardedCopy,
  type GenerationOwnerState,
} from "../../lib/character-gen/owner-lifecycle.ts";

test("profile lifecycle read fails closed", () => {
  assert.equal(
    ownerStateFromProfileRead({ data: { deleted_at: null }, error: null }),
    "active",
  );
  assert.equal(
    ownerStateFromProfileRead({
      data: { deleted_at: "2026-07-29T00:00:00Z" },
      error: null,
    }),
    "deleted",
  );
  assert.equal(ownerStateFromProfileRead({ data: null, error: null }), "unavailable");
  assert.equal(
    ownerStateFromProfileRead({ data: null, error: new Error("db down") }),
    "unavailable",
  );
});

test("deleted/unavailable owner before copy performs no external copy", async () => {
  for (const state of ["deleted", "unavailable"] as const) {
    let copied = false;
    const result = await runOwnerGuardedCopy({
      readOwnerState: async () => state,
      copy: async () => {
        copied = true;
        return ["candidate"];
      },
      cleanupCopied: async () => {},
    });
    assert.equal(copied, false);
    assert.deepEqual(result, { kind: "blocked", ownerState: state });
  }
});

test("deletion race after copy compensates copied candidates", async () => {
  const states: GenerationOwnerState[] = ["active", "deleted"];
  let cleaned = false;
  const result = await runOwnerGuardedCopy({
    readOwnerState: async () => states.shift() ?? "unavailable",
    copy: async () => ["candidate"],
    cleanupCopied: async () => {
      cleaned = true;
    },
  });
  assert.equal(cleaned, true);
  assert.deepEqual(result, { kind: "blocked", ownerState: "deleted" });
});

test("post-copy DB outage fails closed without deleting concurrent canonical paths", async () => {
  const states: GenerationOwnerState[] = ["active", "unavailable"];
  let cleaned = false;
  const result = await runOwnerGuardedCopy({
    readOwnerState: async () => states.shift() ?? "unavailable",
    copy: async () => ["candidate"],
    cleanupCopied: async () => {
      cleaned = true;
    },
  });
  assert.equal(cleaned, false);
  assert.deepEqual(result, { kind: "blocked", ownerState: "unavailable" });
});

test("copy-race cleanup failure is surfaced for durable retry", async () => {
  const states: GenerationOwnerState[] = ["active", "deleted"];
  const cleanupError = new Error("remove failed");
  const result = await runOwnerGuardedCopy({
    readOwnerState: async () => states.shift() ?? "unavailable",
    copy: async () => ["candidate"],
    cleanupCopied: async () => {
      throw cleanupError;
    },
  });
  assert.deepEqual(result, {
    kind: "blocked",
    ownerState: "deleted",
    cleanupError,
  });
});
