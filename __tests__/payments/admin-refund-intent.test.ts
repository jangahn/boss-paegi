import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AdminRefundIntentError,
  beginOrRecoverAdminRefund,
  clearPendingAdminRefundIntent,
  parseAdminRefundBeginAck,
  readPendingAdminRefundIntent,
  recoverPendingAdminRefund,
  type AdminRefundBeginInput,
  type RefundIntentExclusiveRunner,
  type RefundIntentStorage,
} from "../../lib/admin-refund-intent.ts";

const ORDER = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";
const ATTEMPT = "44444444-4444-4444-8444-444444444444";
const input: AdminRefundBeginInput = {
  orderUuid: ORDER,
  userId: USER,
  qty: 2,
  customerRequestedAt: "2026-07-29T00:00:00.000Z",
  reason: "customer requested refund",
};
const ack = {
  ok: true,
  outcome: "prepared",
  request_id: REQUEST,
  attempt_id: ATTEMPT,
  qty: 2,
  amount: 1800,
  rate_bps: 9000,
};

class MemoryStorage implements RefundIntentStorage {
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

const exclusive: RefundIntentExclusiveRunner = async (_name, task) => task();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("refund begin persists the exact intent before network and the attempt receipt before process", async () => {
  const storage = new MemoryStorage();
  let calls = 0;
  const result = await beginOrRecoverAdminRefund(input, {
    storage,
    runExclusive: exclusive,
    mintRequestId: () => REQUEST,
    fetcher: async (_url, init) => {
      calls += 1;
      const pending = readPendingAdminRefundIntent(ORDER, storage);
      assert.ok(pending, "request UUID must be durable before fetch");
      assert.equal(pending.requestId, REQUEST);
      assert.equal(pending.attemptId, null);
      assert.deepEqual(JSON.parse(String(init?.body)), {
        mode: "begin",
        requestId: REQUEST,
        userId: USER,
        orderUuid: ORDER,
        qty: 2,
        customerRequestedAt: input.customerRequestedAt,
        reason: input.reason,
      });
      return jsonResponse(ack);
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.pending.attemptId, ATTEMPT);
  assert.equal(result.ack?.attempt_id, ATTEMPT);
  assert.equal(
    readPendingAdminRefundIntent(ORDER, storage)?.attemptId,
    ATTEMPT,
    "process cannot start before the attempt correlation is durable",
  );
});

test("ambiguous begin outcomes retain one UUID and replay the exact payload", async () => {
  const storage = new MemoryStorage();
  let calls = 0;
  const fetcher = async (): Promise<Response> => {
    calls += 1;
    if (calls === 1) throw new Error("response lost");
    return jsonResponse({
      ...ack,
      outcome: "no_op",
      idempotent: true,
    });
  };
  await assert.rejects(
    beginOrRecoverAdminRefund(input, {
      storage,
      runExclusive: exclusive,
      mintRequestId: () => REQUEST,
      fetcher,
    }),
    (error: unknown) =>
      error instanceof AdminRefundIntentError &&
      error.message === "refund_begin_transport_failed",
  );
  assert.equal(
    readPendingAdminRefundIntent(ORDER, storage)?.requestId,
    REQUEST,
  );
  const recovered = await recoverPendingAdminRefund(ORDER, {
    storage,
    runExclusive: exclusive,
    mintRequestId: () => {
      throw new Error("retry must never mint another id");
    },
    fetcher,
  });
  assert.equal(recovered.kind, "ready");
  assert.equal(
    recovered.kind === "ready" ? recovered.pending.requestId : null,
    REQUEST,
  );
  assert.equal(
    recovered.kind === "ready" ? recovered.pending.attemptId : null,
    ATTEMPT,
  );
  assert.equal(calls, 2);
});

test("malformed/null/error receipts and storage faults never authorize process or a second intent", async () => {
  for (const body of [
    null,
    {},
    { ...ack, ok: false },
    { ...ack, request_id: USER },
    { ...ack, attempt_id: "not-a-uuid" },
    { ...ack, qty: 3 },
    { ...ack, amount: 0 },
    { ...ack, rate_bps: 9500 },
    { ...ack, outcome: "no_op" },
  ]) {
    const storage = new MemoryStorage();
    await assert.rejects(
      beginOrRecoverAdminRefund(input, {
        storage,
        runExclusive: exclusive,
        mintRequestId: () => REQUEST,
        fetcher: async () => jsonResponse(body),
      }),
      (error: unknown) =>
        error instanceof AdminRefundIntentError &&
        error.message === "invalid_refund_begin_ack",
      JSON.stringify(body),
    );
    const pending = readPendingAdminRefundIntent(ORDER, storage);
    assert.equal(pending?.requestId, REQUEST);
    assert.equal(pending?.attemptId, null);
  }

  const rejected = new MemoryStorage();
  await assert.rejects(
    beginOrRecoverAdminRefund(input, {
      storage: rejected,
      runExclusive: exclusive,
      mintRequestId: () => REQUEST,
      fetcher: async () => jsonResponse({ error: "maintenance" }, 503),
    }),
    (error: unknown) =>
      error instanceof AdminRefundIntentError &&
      error.message === "maintenance" &&
      error.status === 503,
  );
  assert.equal(readPendingAdminRefundIntent(ORDER, rejected)?.requestId, REQUEST);

  const unavailable = new MemoryStorage();
  unavailable.failSet = true;
  let networkCalls = 0;
  await assert.rejects(
    beginOrRecoverAdminRefund(input, {
      storage: unavailable,
      runExclusive: exclusive,
      mintRequestId: () => REQUEST,
      fetcher: async () => {
        networkCalls += 1;
        return jsonResponse(ack);
      },
    }),
    (error: unknown) =>
      error instanceof AdminRefundIntentError &&
      error.message === "refund_receipt_storage_unavailable",
  );
  assert.equal(networkCalls, 0, "no durable receipt means no financial call");
});

test("an existing attempt bypasses begin, payload drift is blocked, and clear is correlation-fenced", async () => {
  const storage = new MemoryStorage();
  await beginOrRecoverAdminRefund(input, {
    storage,
    runExclusive: exclusive,
    mintRequestId: () => REQUEST,
    fetcher: async () => jsonResponse(ack),
  });

  let calls = 0;
  const existing = await beginOrRecoverAdminRefund(input, {
    storage,
    runExclusive: exclusive,
    fetcher: async () => {
      calls += 1;
      return jsonResponse(ack);
    },
  });
  assert.equal(existing.pending.attemptId, ATTEMPT);
  assert.equal(existing.ack, null);
  assert.equal(calls, 0);

  await assert.rejects(
    beginOrRecoverAdminRefund(
      { ...input, qty: 3 },
      {
        storage,
        runExclusive: exclusive,
        fetcher: async () => {
          calls += 1;
          return jsonResponse(ack);
        },
      },
    ),
    (error: unknown) =>
      error instanceof AdminRefundIntentError &&
      error.message === "refund_intent_conflict",
  );
  assert.equal(calls, 0);

  assert.throws(
    () => clearPendingAdminRefundIntent(ORDER, USER, storage),
    (error: unknown) =>
      error instanceof AdminRefundIntentError &&
      error.message === "refund_receipt_correlation_mismatch",
  );
  assert.ok(readPendingAdminRefundIntent(ORDER, storage));
  clearPendingAdminRefundIntent(ORDER, ATTEMPT, storage);
  assert.equal(readPendingAdminRefundIntent(ORDER, storage), null);
});

test("begin ack parser and RefundButton keep response-loss retries on the same attempt", () => {
  assert.deepEqual(
    parseAdminRefundBeginAck(ack, { requestId: REQUEST, qty: 2 }),
    ack,
  );
  assert.equal(
    parseAdminRefundBeginAck(
      { ...ack, outcome: "no_op" },
      { requestId: REQUEST, qty: 2 },
    ),
    null,
  );

  const source = readFileSync(
    new URL("../../components/admin/RefundButton.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /beginOrRecoverAdminRefund/);
  assert.match(source, /recoverPendingAdminRefund/);
  assert.match(source, /clearPendingAdminRefundIntent/);
  assert.doesNotMatch(source, /const requestId = crypto\.randomUUID\(\)/);
  assert.match(
    source,
    /parseRefundProcessHttpAck\(\s*body,\s*expected\.attemptId,\s*\)[\s\S]*value: \{ kind: "process", result \}/,
  );
  assert.match(
    source,
    /outcome\.kind !== "confirmed" \|\|\s*outcome\.value\.kind !== "process"[\s\S]*outcome: "outstanding"[\s\S]*attemptId/,
  );
  assert.match(
    source,
    /catch \{[\s\S]*outcome: "outstanding"[\s\S]*attemptId/,
  );
});
