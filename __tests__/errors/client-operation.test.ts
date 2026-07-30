import assert from "node:assert/strict";
import test from "node:test";
import { runBoundedClientOperation } from "../../lib/client-operation.ts";

test("bounded client operation returns one confirmed SDK result", async () => {
  let calls = 0;
  const result = await runBoundedClientOperation(
    async () => {
      calls += 1;
      return { ok: true };
    },
    { deadlineMs: 100, attemptMs: 80 },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(calls, 1);
});

test("bounded client operation preserves a definitive SDK rejection", async () => {
  const expected = new Error("sdk_rejected");
  await assert.rejects(
    runBoundedClientOperation(
      async () => {
        throw expected;
      },
      { deadlineMs: 100, attemptMs: 80 },
    ),
    (error: unknown) => error === expected,
  );
});

test("non-cooperative SDK work has a hard deadline and is never replayed", async () => {
  let calls = 0;
  await assert.rejects(
    runBoundedClientOperation(
      () => {
        calls += 1;
        return new Promise<never>(() => {});
      },
      { deadlineMs: 15, attemptMs: 10 },
    ),
    /client_operation_unconfirmed/,
  );
  assert.equal(calls, 1);
});

test("owner abort stops publication immediately", async () => {
  const controller = new AbortController();
  const expected = new Error("owner_disposed");
  const pending = runBoundedClientOperation(
    () => new Promise<never>(() => {}),
    {
      signal: controller.signal,
      deadlineMs: 1_000,
      attemptMs: 900,
    },
  );
  controller.abort(expected);
  await assert.rejects(
    pending,
    (error: unknown) => error === expected,
  );
});
