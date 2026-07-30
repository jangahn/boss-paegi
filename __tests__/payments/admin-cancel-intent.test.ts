import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AdminCancelIntentError,
  parseAdminCancelIntentOutcome,
  readPendingAdminCancelIntent,
  submitAdminCancelIntent,
  type AdminCancelIntentInput,
  type AdminCancelIntentStorage,
  type CancelIntentExclusiveRunner,
} from "../../lib/admin-cancel-intent.ts";

const ORDER = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";
const BATCH = "44444444-4444-4444-8444-444444444444";
const input: AdminCancelIntentInput = {
  orderUuid: ORDER,
  reason: "customer requested cancellation",
  customerRequestedAt: "2026-07-29T00:00:00.123Z",
};

class MemoryStorage implements AdminCancelIntentStorage {
  readonly values = new Map<string, string>();
  failGet = false;
  failSet = false;
  failRemove = false;

  getItem(key: string): string | null {
    if (this.failGet) throw new Error("get failed");
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    if (this.failSet) throw new Error("set failed");
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    if (this.failRemove) throw new Error("remove failed");
    this.values.delete(key);
  }
}

const exclusive: CancelIntentExclusiveRunner = async (_name, task) => task();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("cancel persists the exact intent before network and clears only after a valid receipt", async () => {
  const storage = new MemoryStorage();
  let pendingCallback: AdminCancelIntentInput | null = null;
  const outcome = await submitAdminCancelIntent(input, {
    storage,
    runExclusive: exclusive,
    onPending: (pending) => {
      pendingCallback = pending;
    },
    fetcher: async (_url, init) => {
      assert.deepEqual(readPendingAdminCancelIntent(ORDER, storage), input);
      assert.deepEqual(JSON.parse(String(init?.body)), input);
      return jsonResponse({ ok: true, outcome: "canceled" });
    },
  });
  assert.deepEqual(pendingCallback, input);
  assert.deepEqual(outcome, { ok: true, outcome: "canceled" });
  assert.equal(readPendingAdminCancelIntent(ORDER, storage), null);
});

test("response loss retains the exact timestamp and retry cannot create a different intent", async () => {
  const storage = new MemoryStorage();
  const requestBodies: unknown[] = [];
  let calls = 0;
  const fetcher = async (_url: string | URL | Request, init?: RequestInit) => {
    requestBodies.push(JSON.parse(String(init?.body)));
    calls += 1;
    if (calls === 1) throw new Error("response lost");
    return jsonResponse({ ok: true, outcome: "already_canceled" });
  };

  await assert.rejects(
    submitAdminCancelIntent(input, {
      storage,
      runExclusive: exclusive,
      fetcher,
    }),
    (error: unknown) =>
      error instanceof AdminCancelIntentError &&
      error.message === "cancel_transport_failed",
  );
  assert.deepEqual(readPendingAdminCancelIntent(ORDER, storage), input);

  await assert.rejects(
    submitAdminCancelIntent(
      { ...input, customerRequestedAt: "2026-07-29T00:00:00.000Z" },
      { storage, runExclusive: exclusive, fetcher },
    ),
    (error: unknown) =>
      error instanceof AdminCancelIntentError &&
      error.message === "cancel_intent_conflict",
  );
  assert.equal(calls, 1);

  const replay = await submitAdminCancelIntent(input, {
    storage,
    runExclusive: exclusive,
    fetcher,
  });
  assert.equal(replay.outcome, "already_canceled");
  assert.equal(calls, 2);
  assert.deepEqual(requestBodies, [input, input]);
  assert.equal(readPendingAdminCancelIntent(ORDER, storage), null);
});

test("malformed, error, and storage-fault paths retain or block the intent without another network call", async () => {
  for (const body of [
    null,
    {},
    { ok: false, outcome: "canceled" },
    { ok: true, outcome: "unknown" },
    { ok: true, outcome: "refund_prepared" },
    {
      ok: true,
      outcome: "refund_prepared",
      requestId: REQUEST,
      attemptId: ATTEMPT,
      qty: 0,
      amount: 100,
    },
    { ok: true, outcome: "resolved_full", batchId: null },
  ]) {
    const storage = new MemoryStorage();
    await assert.rejects(
      submitAdminCancelIntent(input, {
        storage,
        runExclusive: exclusive,
        fetcher: async () => jsonResponse(body),
      }),
      (error: unknown) =>
        error instanceof AdminCancelIntentError &&
        error.message === "invalid_cancel_ack",
      JSON.stringify(body),
    );
    assert.deepEqual(readPendingAdminCancelIntent(ORDER, storage), input);
  }

  const rejected = new MemoryStorage();
  await assert.rejects(
    submitAdminCancelIntent(input, {
      storage: rejected,
      runExclusive: exclusive,
      fetcher: async () => jsonResponse({ error: "pg_unreachable" }, 502),
    }),
    (error: unknown) =>
      error instanceof AdminCancelIntentError &&
      error.message === "pg_unreachable" &&
      error.status === 502,
  );
  assert.deepEqual(readPendingAdminCancelIntent(ORDER, rejected), input);

  const unavailable = new MemoryStorage();
  unavailable.failSet = true;
  let calls = 0;
  await assert.rejects(
    submitAdminCancelIntent(input, {
      storage: unavailable,
      runExclusive: exclusive,
      fetcher: async () => {
        calls += 1;
        return jsonResponse({ ok: true, outcome: "canceled" });
      },
    }),
    (error: unknown) =>
      error instanceof AdminCancelIntentError &&
      error.message === "cancel_receipt_storage_unavailable",
  );
  assert.equal(calls, 0);

  const corrupt = new MemoryStorage();
  corrupt.values.set(`boss-paegi:admin-cancel-intent:${ORDER}`, "{");
  await assert.rejects(
    submitAdminCancelIntent(input, {
      storage: corrupt,
      runExclusive: exclusive,
      fetcher: async () => {
        calls += 1;
        return jsonResponse({ ok: true, outcome: "canceled" });
      },
    }),
    (error: unknown) =>
      error instanceof AdminCancelIntentError &&
      error.message === "invalid_cancel_intent",
  );
  assert.equal(calls, 0);
});

test("valid terminal and refund receipts are parsed exactly", () => {
  for (const outcome of [
    "canceled",
    "already_canceled",
    "ineligible",
    "canceled_unpaid",
    "observed",
  ]) {
    assert.deepEqual(parseAdminCancelIntentOutcome({ ok: true, outcome }), {
      ok: true,
      outcome,
    });
  }
  assert.deepEqual(
    parseAdminCancelIntentOutcome({
      ok: true,
      outcome: "refund_prepared",
      requestId: REQUEST,
      attemptId: ATTEMPT,
      qty: 3,
      amount: 2700,
    }),
    {
      ok: true,
      outcome: "refund_prepared",
      requestId: REQUEST,
      attemptId: ATTEMPT,
      qty: 3,
      amount: 2700,
    },
  );
  assert.deepEqual(
    parseAdminCancelIntentOutcome({
      ok: true,
      outcome: "resolved_full",
      batchId: BATCH,
    }),
    { ok: true, outcome: "resolved_full", batchId: BATCH },
  );
});

test("StalePendingTable recovers durable cancellation input and never posts directly", () => {
  const source = readFileSync(
    new URL("../../components/admin/StalePendingTable.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /readPendingAdminCancelIntent/);
  assert.match(source, /submitAdminCancelIntent/);
  assert.match(source, /pendingCancel \?\?/);
  assert.match(source, /disabled=\{pendingCancel !== null\}/);
  assert.match(source, /parseAdminSettlementMutationResult\(body\)/);
  assert.match(
    source,
    /runScopedOperation\(\(signal\) =>\s*submitAdminCancelIntent\(input, \{[\s\S]*signal,/,
  );
  assert.doesNotMatch(source, /res\.ok && !out\.manual/);
  assert.doesNotMatch(source, /fetch\("\/api\/admin\/cancel"/);
});
