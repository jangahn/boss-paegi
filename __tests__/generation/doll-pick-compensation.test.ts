import test from "node:test";
import assert from "node:assert/strict";
import {
  runDollPickCompensation,
  type DollPickCompensationStep,
} from "../../lib/character-gen/doll-pick-compensation.ts";

test("successful compensation deletes the doll row before its Storage object", async () => {
  const calls: string[] = [];
  const failures = await runDollPickCompensation([
    {
      stage: "doll_delete",
      run: async () => {
        calls.push("doll_delete");
        return { error: null };
      },
    },
    {
      stage: "storage_remove",
      run: async () => {
        calls.push("storage_remove");
        return { error: null };
      },
    },
  ]);
  assert.deepEqual(failures, []);
  assert.deepEqual(calls, ["doll_delete", "storage_remove"]);
});

test("resolved doll delete error is reported and blocks unsafe Storage deletion", async () => {
  const calls: string[] = [];
  const dbError = new Error("delete failed");
  const steps: DollPickCompensationStep[] = [
    {
      stage: "doll_delete",
      run: async () => {
        calls.push("doll_delete");
        return { error: dbError };
      },
    },
    {
      stage: "storage_remove",
      run: async () => {
        calls.push("storage_remove");
        return { error: null };
      },
    },
  ];
  assert.deepEqual(await runDollPickCompensation(steps), [
    { stage: "doll_delete", error: dbError },
  ]);
  assert.deepEqual(calls, ["doll_delete"]);
});

test("resolved Storage remove error is reported after a successful doll delete", async () => {
  const storageError = new Error("remove failed");
  const failures = await runDollPickCompensation([
    { stage: "doll_delete", run: async () => ({ error: null }) },
    { stage: "storage_remove", run: async () => ({ error: storageError }) },
  ]);
  assert.deepEqual(failures, [{ stage: "storage_remove", error: storageError }]);
});

test("thrown compensation failures are normalized and returned", async () => {
  const thrown = new Error("network down");
  const failures = await runDollPickCompensation([
    {
      stage: "storage_remove",
      run: async () => {
        throw thrown;
      },
    },
  ]);
  assert.deepEqual(failures, [{ stage: "storage_remove", error: thrown }]);
});
