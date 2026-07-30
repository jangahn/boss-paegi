import assert from "node:assert/strict";
import test from "node:test";
import {
  CreditAdjustmentConcurrencyError,
  CreditAdjustmentHttpError,
  CreditAdjustmentStorageError,
  parseCreditAdjustmentResult,
  readPendingCreditAdjustment,
  recoverCreditAdjustment,
  submitCreditAdjustment,
  type CreditAdjustmentExclusiveRunner,
} from "../../lib/admin-credit-adjust.ts";

class MemoryStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const TARGET = "00000000-0000-4000-8000-000000000001";
const REQUEST = "00000000-0000-4000-8000-000000000011";
const INPUT = { targetUserId: TARGET, delta: 3, reason: "manual test grant" };
const RESULT = {
  ok: true as const,
  before: 2,
  after: 5,
  applied: 3,
  requested: 3,
  idempotent: false,
};
const IMMEDIATE_EXCLUSIVE: CreditAdjustmentExclusiveRunner = async (
  _name,
  task,
) => task();

test("durable request id is written before fetch and reused after response loss", async () => {
  const storage = new MemoryStorage();
  const firstBodies: Array<Record<string, unknown>> = [];
  await assert.rejects(
    submitCreditAdjustment(INPUT, {
      storage,
      runExclusive: IMMEDIATE_EXCLUSIVE,
      mintRequestId: () => REQUEST,
      fetcher: async (_input, init) => {
        firstBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        assert.equal(readPendingCreditAdjustment(TARGET, storage)?.requestId, REQUEST);
        throw new Error("response lost");
      },
    }),
    /response lost/,
  );
  assert.equal(firstBodies[0]?.requestId, REQUEST);
  assert.equal(readPendingCreditAdjustment(TARGET, storage)?.requestId, REQUEST);

  const retryBodies: Array<Record<string, unknown>> = [];
  const result = await submitCreditAdjustment(INPUT, {
    storage,
    runExclusive: IMMEDIATE_EXCLUSIVE,
    mintRequestId: () => {
      throw new Error("must reuse durable request id");
    },
    fetcher: async (_input, init) => {
      retryBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({ ...RESULT, idempotent: true });
    },
  });
  assert.equal(retryBodies[0]?.requestId, REQUEST);
  assert.equal(result.idempotent, true);
  assert.equal(readPendingCreditAdjustment(TARGET, storage), null);
});

test("same-target submit/recover races are rejected before a second network mutation", async () => {
  const storage = new MemoryStorage();
  const held = new Set<string>();
  const lockNames: string[] = [];
  const failClosedExclusive: CreditAdjustmentExclusiveRunner = async (
    name,
    task,
  ) => {
    lockNames.push(name);
    if (held.has(name)) throw new CreditAdjustmentConcurrencyError();
    held.add(name);
    try {
      return await task();
    } finally {
      held.delete(name);
    }
  };
  let fetchCalls = 0;
  let signalStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let releaseFetch: (() => void) | undefined;
  const release = new Promise<void>((resolve) => {
    releaseFetch = resolve;
  });

  const first = submitCreditAdjustment(INPUT, {
    storage,
    runExclusive: failClosedExclusive,
    mintRequestId: () => REQUEST,
    fetcher: async () => {
      fetchCalls += 1;
      signalStarted?.();
      await release;
      return Response.json(RESULT);
    },
  });
  await started;

  await assert.rejects(
    submitCreditAdjustment(INPUT, {
      storage,
      runExclusive: failClosedExclusive,
      mintRequestId: () => {
        throw new Error("must not mint while another tab owns the lock");
      },
      fetcher: async () => {
        fetchCalls += 1;
        return Response.json(RESULT);
      },
    }),
    (error: unknown) => error instanceof CreditAdjustmentConcurrencyError,
  );
  await assert.rejects(
    recoverCreditAdjustment(TARGET, {
      storage,
      runExclusive: failClosedExclusive,
      fetcher: async () => {
        fetchCalls += 1;
        return Response.json({ found: false, aborted: true });
      },
    }),
    (error: unknown) => error instanceof CreditAdjustmentConcurrencyError,
  );
  assert.equal(fetchCalls, 1);
  assert.equal(readPendingCreditAdjustment(TARGET, storage)?.requestId, REQUEST);

  releaseFetch?.();
  await first;
  assert.equal(fetchCalls, 1);
  assert.equal(readPendingCreditAdjustment(TARGET, storage), null);
  assert.deepEqual(
    new Set(lockNames),
    new Set([`boss-paegi:admin-credit-adjust:${TARGET}`]),
  );
});

test("HTTP and malformed 2xx outcomes retain durable uncertainty", async () => {
  for (const response of [
    Response.json({ error: "adjustment_unavailable" }, { status: 503 }),
    Response.json({ ok: true, before: 2, after: 5 }),
    Response.json({ ...RESULT, after: 6 }),
    Response.json({ ...RESULT, requested: 4 }),
  ]) {
    const storage = new MemoryStorage();
    await assert.rejects(
      submitCreditAdjustment(INPUT, {
        storage,
        runExclusive: IMMEDIATE_EXCLUSIVE,
        mintRequestId: () => REQUEST,
        fetcher: async () => response.clone(),
      }),
    );
    assert.equal(readPendingCreditAdjustment(TARGET, storage)?.requestId, REQUEST);
  }
});

test("explicit aborted acknowledgement is the only failed apply that clears pending state", async () => {
  const storage = new MemoryStorage();
  await assert.rejects(
    submitCreditAdjustment(INPUT, {
      storage,
      runExclusive: IMMEDIATE_EXCLUSIVE,
      mintRequestId: () => REQUEST,
      fetcher: async () =>
        Response.json({ error: "request_aborted" }, { status: 409 }),
    }),
    (error: unknown) =>
      error instanceof CreditAdjustmentHttpError &&
      error.status === 409 &&
      error.code === "request_aborted",
  );
  assert.equal(readPendingCreditAdjustment(TARGET, storage), null);
});

test("recovery distinguishes completed, aborted, unavailable, and no pending request", async () => {
  const completedStorage = new MemoryStorage();
  completedStorage.setItem(
    `boss-paegi:admin-credit-adjust:${TARGET}`,
    JSON.stringify({ requestId: REQUEST, targetUserId: TARGET }),
  );
  const recoveryBodies: Array<Record<string, unknown>> = [];
  const completed = await recoverCreditAdjustment(TARGET, {
    storage: completedStorage,
    runExclusive: IMMEDIATE_EXCLUSIVE,
    fetcher: async (_input, init) => {
      recoveryBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return Response.json({
        found: true,
        aborted: false,
        result: { ...RESULT, idempotent: true },
      });
    },
  });
  assert.equal(recoveryBodies[0]?.action, "recover");
  assert.equal(recoveryBodies[0]?.requestId, REQUEST);
  assert.equal(recoveryBodies[0]?.targetUserId, TARGET);
  assert.deepEqual(completed, {
    kind: "completed",
    result: { ...RESULT, idempotent: true },
  });
  assert.equal(readPendingCreditAdjustment(TARGET, completedStorage), null);

  const abortedStorage = new MemoryStorage();
  abortedStorage.setItem(
    `boss-paegi:admin-credit-adjust:${TARGET}`,
    JSON.stringify({ requestId: REQUEST, targetUserId: TARGET }),
  );
  assert.deepEqual(
    await recoverCreditAdjustment(TARGET, {
      storage: abortedStorage,
      runExclusive: IMMEDIATE_EXCLUSIVE,
      fetcher: async () => Response.json({ found: false, aborted: true }),
    }),
    { kind: "aborted" },
  );
  assert.equal(readPendingCreditAdjustment(TARGET, abortedStorage), null);

  const unavailableStorage = new MemoryStorage();
  unavailableStorage.setItem(
    `boss-paegi:admin-credit-adjust:${TARGET}`,
    JSON.stringify({ requestId: REQUEST, targetUserId: TARGET }),
  );
  await assert.rejects(
    recoverCreditAdjustment(TARGET, {
      storage: unavailableStorage,
      runExclusive: IMMEDIATE_EXCLUSIVE,
      fetcher: async () =>
        Response.json({ error: "adjustment_unavailable" }, { status: 503 }),
    }),
    (error: unknown) =>
      error instanceof CreditAdjustmentHttpError && error.status === 503,
  );
  assert.equal(readPendingCreditAdjustment(TARGET, unavailableStorage)?.requestId, REQUEST);

  assert.deepEqual(
    await recoverCreditAdjustment(TARGET, {
      storage: new MemoryStorage(),
      runExclusive: IMMEDIATE_EXCLUSIVE,
    }),
    { kind: "none" },
  );
});

test("result parser rejects every arithmetic/type/range contradiction", () => {
  assert.deepEqual(parseCreditAdjustmentResult(RESULT), RESULT);
  for (const malformed of [
    null,
    {},
    { ...RESULT, ok: false },
    { ...RESULT, before: -1 },
    {
      ...RESULT,
      before: Number.MAX_SAFE_INTEGER + 1,
      after: Number.MAX_SAFE_INTEGER + 4,
    },
    { ...RESULT, after: 4 },
    { ...RESULT, applied: 2 },
    { ...RESULT, requested: 0 },
    { ...RESULT, requested: 101 },
    { ...RESULT, idempotent: "false" },
    {
      ok: true,
      before: 2,
      after: 0,
      applied: -2,
      requested: -3,
      idempotent: false,
    },
  ]) {
    // The final case is valid clamping and is asserted separately below.
    if (
      malformed &&
      typeof malformed === "object" &&
      (malformed as { requested?: unknown }).requested === -3
    ) {
      continue;
    }
    assert.equal(parseCreditAdjustmentResult(malformed), null);
  }
  assert.deepEqual(
    parseCreditAdjustmentResult({
      ok: true,
      before: 2,
      after: 0,
      applied: -2,
      requested: -3,
      idempotent: false,
    }),
    {
      ok: true,
      before: 2,
      after: 0,
      applied: -2,
      requested: -3,
      idempotent: false,
    },
  );
});

test("corrupt or cross-target local records are discarded without a network replay", async () => {
  for (const raw of [
    "{",
    JSON.stringify({ requestId: "not-a-uuid", targetUserId: TARGET }),
    JSON.stringify({
      requestId: REQUEST,
      targetUserId: "00000000-0000-4000-8000-000000000002",
    }),
  ]) {
    const storage = new MemoryStorage();
    storage.setItem(`boss-paegi:admin-credit-adjust:${TARGET}`, raw);
    assert.equal(readPendingCreditAdjustment(TARGET, storage), null);
    assert.deepEqual(
      await recoverCreditAdjustment(TARGET, {
        storage,
        runExclusive: IMMEDIATE_EXCLUSIVE,
      }),
      { kind: "none" },
    );
  }
});

test("storage failures fail closed before apply or recovery can create a second request", async () => {
  let fetchCalls = 0;
  const unreadable = {
    getItem(): string | null {
      throw new Error("storage denied");
    },
    setItem(): void {
      throw new Error("storage denied");
    },
    removeItem(): void {
      throw new Error("storage denied");
    },
  };
  await assert.rejects(
    submitCreditAdjustment(INPUT, {
      storage: unreadable,
      runExclusive: IMMEDIATE_EXCLUSIVE,
      mintRequestId: () => REQUEST,
      fetcher: async () => {
        fetchCalls += 1;
        return Response.json(RESULT);
      },
    }),
    (error: unknown) => error instanceof CreditAdjustmentStorageError,
  );
  await assert.rejects(
    recoverCreditAdjustment(TARGET, {
      storage: unreadable,
      runExclusive: IMMEDIATE_EXCLUSIVE,
      fetcher: async () => {
        fetchCalls += 1;
        return Response.json({ found: false, aborted: true });
      },
    }),
    (error: unknown) => error instanceof CreditAdjustmentStorageError,
  );
  assert.equal(fetchCalls, 0);

  let removeFails = true;
  const uncertainStorage = new MemoryStorage();
  uncertainStorage.setItem(
    `boss-paegi:admin-credit-adjust:${TARGET}`,
    JSON.stringify({ requestId: REQUEST, targetUserId: TARGET }),
  );
  const flakyRemoval = {
    getItem: uncertainStorage.getItem.bind(uncertainStorage),
    setItem: uncertainStorage.setItem.bind(uncertainStorage),
    removeItem(key: string): void {
      if (removeFails) throw new Error("remove denied");
      uncertainStorage.removeItem(key);
    },
  };
  await assert.rejects(
    recoverCreditAdjustment(TARGET, {
      storage: flakyRemoval,
      runExclusive: IMMEDIATE_EXCLUSIVE,
      fetcher: async () =>
        Response.json({
          found: true,
          aborted: false,
          result: { ...RESULT, idempotent: true },
        }),
    }),
    (error: unknown) => error instanceof CreditAdjustmentStorageError,
  );
  assert.equal(readPendingCreditAdjustment(TARGET, uncertainStorage)?.requestId, REQUEST);
  removeFails = false;
  assert.equal(
    (
      await recoverCreditAdjustment(TARGET, {
        storage: flakyRemoval,
        runExclusive: IMMEDIATE_EXCLUSIVE,
        fetcher: async () =>
          Response.json({
            found: true,
            aborted: false,
            result: { ...RESULT, idempotent: true },
          }),
      })
    ).kind,
    "completed",
  );
  assert.equal(readPendingCreditAdjustment(TARGET, uncertainStorage), null);
});
