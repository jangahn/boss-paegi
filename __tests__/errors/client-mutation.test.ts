import assert from "node:assert/strict";
import test from "node:test";

import {
  CLIENT_MUTATION_MAX_RESPONSE_BYTES,
  clientMutationResponseNeedsReconciliation,
  readBoundedClientJsonResponse,
  runBoundedClientJsonFetch,
  runClientMutation,
  runReplayedJsonMutation,
  type ClientMutationEvidence,
} from "../../lib/client-mutation.ts";

test("only ambiguous HTTP responses enter reconciliation", () => {
  for (let status = 100; status <= 599; status += 1) {
    assert.equal(
      clientMutationResponseNeedsReconciliation(status, false),
      status === 408 ||
        status === 425 ||
        status === 429 ||
        status >= 500,
      String(status),
    );
  }
  assert.equal(clientMutationResponseNeedsReconciliation(200, true), true);
  assert.equal(clientMutationResponseNeedsReconciliation(409, false), false);
});

test("a never-resolving delivery is bounded and never guessed successful", async () => {
  const startedAt = Date.now();
  const outcome = await runClientMutation({
    attempt: () => new Promise<ClientMutationEvidence<string>>(() => {}),
    deadlineMs: 40,
    attemptMs: 10,
  });
  assert.deepEqual(outcome, { kind: "unconfirmed", reason: "deadline" });
  assert.ok(Date.now() - startedAt < 500);
});

test("response loss reconciles only the original operation ID and payload", async () => {
  const payload = Object.freeze({
    requestId: "318edaf5-c5bd-4ab8-a14b-52e2694d4ee0",
    target: "target-1",
    expectedVersion: 7,
  });
  const delivered: unknown[] = [];
  let committed = false;
  const deliver = async (): Promise<ClientMutationEvidence<number>> => {
    delivered.push(payload);
    if (!committed) {
      committed = true;
      throw new TypeError("simulated_response_loss");
    }
    return { kind: "confirmed", value: payload.expectedVersion + 1 };
  };

  const outcome = await runClientMutation({
    attempt: deliver,
    reconcile: deliver,
    deadlineMs: 100,
    attemptMs: 50,
  });
  assert.deepEqual(outcome, {
    kind: "confirmed",
    value: 8,
    source: "reconciled",
  });
  assert.equal(delivered.length, 2);
  assert.equal(delivered[0], payload);
  assert.equal(delivered[1], payload);
});

test("lifecycle abort wins immediately and never starts reconciliation", async () => {
  const lifecycle = new AbortController();
  let reconcileCalls = 0;
  const pending = runClientMutation({
    attempt: () => new Promise<ClientMutationEvidence<string>>(() => {}),
    reconcile: async () => {
      reconcileCalls += 1;
      return { kind: "confirmed", value: "must-not-run" };
    },
    signal: lifecycle.signal,
    deadlineMs: 1_000,
    attemptMs: 500,
  });
  lifecycle.abort(new Error("component_unmounted"));

  assert.deepEqual(await pending, { kind: "aborted" });
  assert.equal(reconcileCalls, 0);
});

test("a never-resolving reconciliation remains bounded by the total deadline", async () => {
  const outcome = await runClientMutation({
    attempt: async () => {
      throw new TypeError("response_lost");
    },
    reconcile: () =>
      new Promise<ClientMutationEvidence<string>>(() => {}),
    deadlineMs: 40,
    attemptMs: 10,
  });
  assert.deepEqual(outcome, { kind: "unconfirmed", reason: "deadline" });
});

test("a definitive rejection is preserved and is not replayed", async () => {
  const rejection = new Error("state_conflict");
  let reconcileCalls = 0;
  const outcome = await runClientMutation({
    attempt: async () => ({ kind: "rejected", error: rejection }),
    reconcile: async () => {
      reconcileCalls += 1;
      return { kind: "confirmed", value: "wrong" };
    },
    deadlineMs: 100,
    attemptMs: 50,
  });
  assert.deepEqual(outcome, { kind: "rejected", error: rejection });
  assert.equal(reconcileCalls, 0);
});

test("lifecycle abort during reconciliation wins and clears its timer", async () => {
  const lifecycle = new AbortController();
  const reconciliationSignal: { current: AbortSignal | null } = {
    current: null,
  };
  let cancellations = 0;
  let markReconciliationStarted!: () => void;
  const reconciliationStarted = new Promise<void>((resolve) => {
    markReconciliationStarted = resolve;
  });
  const pending = runClientMutation({
    attempt: async () => ({
      kind: "unconfirmed",
      reason: "ambiguous_408",
    }),
    reconcile: (signal) => {
      reconciliationSignal.current = signal;
      markReconciliationStarted();
      return new Promise<ClientMutationEvidence<string>>(() => {});
    },
    signal: lifecycle.signal,
    deadlineMs: 1_000,
    attemptMs: 500,
    schedule: (callback, delayMs) => {
      const timer = setTimeout(callback, delayMs);
      return () => {
        cancellations += 1;
        clearTimeout(timer);
      };
    },
  });
  await reconciliationStarted;
  lifecycle.abort(new Error("unmounted_during_reconciliation"));
  assert.deepEqual(await pending, { kind: "aborted" });
  assert.equal(reconciliationSignal.current?.aborted, true);
  assert.equal(cancellations, 2);
});

test("a synchronously firing scheduler settles without TDZ or late work", async () => {
  let workCalls = 0;
  let cancellations = 0;
  const outcome = await runClientMutation({
    attempt: async () => {
      workCalls += 1;
      return { kind: "confirmed", value: "must-not-run" };
    },
    deadlineMs: 100,
    attemptMs: 50,
    schedule: (callback) => {
      callback();
      return () => {
        cancellations += 1;
      };
    },
  });
  assert.deepEqual(outcome, {
    kind: "unconfirmed",
    reason: "deadline",
  });
  assert.equal(workCalls, 0);
  assert.equal(cancellations, 1);
});

test("a throwing scheduler is a bounded transport failure", async () => {
  const schedulerError = new Error("scheduler_failed");
  let workCalls = 0;
  const outcome = await runClientMutation({
    attempt: async () => {
      workCalls += 1;
      return { kind: "confirmed", value: "must-not-run" };
    },
    deadlineMs: 100,
    attemptMs: 50,
    schedule: () => {
      throw schedulerError;
    },
  });
  assert.deepEqual(outcome, {
    kind: "unconfirmed",
    reason: "transport",
    error: schedulerError,
  });
  assert.equal(workCalls, 0);
});

test("an abort during scheduler setup cannot miss lifecycle cancellation", async () => {
  const lifecycle = new AbortController();
  let workCalls = 0;
  let cancellations = 0;
  const outcome = await runClientMutation({
    attempt: async () => {
      workCalls += 1;
      return { kind: "confirmed", value: "must-not-run" };
    },
    signal: lifecycle.signal,
    deadlineMs: 100,
    attemptMs: 50,
    schedule: () => {
      lifecycle.abort(new Error("abort_during_schedule"));
      return () => {
        cancellations += 1;
      };
    },
  });
  assert.deepEqual(outcome, { kind: "aborted" });
  assert.equal(workCalls, 0);
  assert.equal(cancellations, 1);
});

test("timer cleanup failures cannot prevent mutation settlement", async () => {
  const outcome = await runClientMutation({
    attempt: async () => ({ kind: "confirmed", value: "ok" }),
    deadlineMs: 100,
    attemptMs: 50,
    schedule: () => () => {
      throw new Error("cleanup_failed");
    },
  });
  assert.deepEqual(outcome, {
    kind: "confirmed",
    value: "ok",
    source: "response",
  });
});

test("client mutation JSON receipts enforce size and strict UTF-8", async () => {
  const tooLarge = await readBoundedClientJsonResponse(
    new Response("{}", {
      headers: {
        "content-length": String(
          CLIENT_MUTATION_MAX_RESPONSE_BYTES + 1,
        ),
      },
    }),
  );
  assert.deepEqual(tooLarge, { ok: false, error: "too_large" });

  const invalidUtf8 = await readBoundedClientJsonResponse(
    new Response(new Uint8Array([0xc3, 0x28])),
  );
  assert.deepEqual(invalidUtf8, {
    ok: false,
    error: "invalid_utf8",
  });

  const valid = await readBoundedClientJsonResponse(
    new Response('{"ok":true,"version":7}'),
  );
  assert.deepEqual(valid, {
    ok: true,
    value: { ok: true, version: 7 },
  });
});

test("oversized 2xx acknowledgements replay once and never become success", async () => {
  const bodies: string[] = [];
  const serializedBody = JSON.stringify({
    operationId: "318edaf5-c5bd-4ab8-a14b-52e2694d4ee0",
    expectedVersion: 7,
  });
  const outcome = await runReplayedJsonMutation({
    input: "/api/example",
    init: {
      method: "POST",
      body: serializedBody,
    },
    fetcher: async (_input, init) => {
      bodies.push(String(init?.body));
      return new Response("{}", {
        status: 200,
        headers: {
          "content-length": String(
            CLIENT_MUTATION_MAX_RESPONSE_BYTES + 1,
          ),
        },
      });
    },
    classify: (_response, body) =>
      body === null
        ? {
            kind: "unconfirmed",
            reason: "invalid_ack",
          }
        : { kind: "confirmed", value: "wrong" },
    deadlineMs: 100,
    attemptMs: 40,
  });
  assert.deepEqual(outcome, {
    kind: "unconfirmed",
    reason: "reconciliation_unconfirmed",
    error: undefined,
  });
  assert.deepEqual(bodies, [serializedBody, serializedBody]);
});

test("a response whose JSON body never completes is deadline-bounded", async () => {
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    pull: () => new Promise<void>(() => {}),
    cancel: () => {
      cancelled = true;
    },
  });
  const startedAt = Date.now();
  const outcome = await runBoundedClientJsonFetch({
    input: "/api/never-ending-body",
    init: { method: "POST" },
    fetcher: async () => new Response(body, { status: 200 }),
    deadlineMs: 40,
    attemptMs: 10,
  });
  assert.deepEqual(outcome, {
    kind: "unconfirmed",
    reason: "deadline",
  });
  assert.equal(cancelled, true);
  assert.ok(Date.now() - startedAt < 500);
});
