import assert from "node:assert/strict";
import {
  handleObservedCancellation,
  ingestObservedCancellations,
  mapRefundRpcError,
  processAttemptAuto,
  refundAttemptOutcomeIsSystemError,
  sweepOpenPgAttempts,
} from "../../lib/refund-saga.ts";
import { FailClosedReadError } from "../../lib/pay/fail-closed-read.ts";

type ReadOutcome =
  | { data: unknown; error: unknown | null }
  | Error;

class FakeAdmin {
  private readonly reads: Record<string, ReadOutcome[]>;

  constructor(reads: Record<string, ReadOutcome[]>) {
    this.reads = reads;
  }

  from(table: string) {
    const finish = async () => {
      const outcome = this.reads[table]?.shift();
      assert.ok(outcome, `unexpected read: ${table}`);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    };
    const builder = {
      select: () => builder,
      eq: () => builder,
      in: () => builder,
      order: () => builder,
      maybeSingle: finish,
      limit: finish,
    };
    return builder;
  }

  async rpc(): Promise<never> {
    throw new Error("RPC must not run after a failed authoritative read");
  }
}

class FakeCancellationAdmin {
  readonly calls: string[] = [];
  private readonly outcome:
    | { data: unknown; error: unknown | null }
    | Error;

  constructor(outcome: { data: unknown; error: unknown | null } | Error) {
    this.outcome = outcome;
  }

  async rpc(name: string): Promise<{ data: unknown; error: unknown | null }> {
    this.calls.push(name);
    assert.equal(
      name,
      "record_payment_cancellation_observation",
      "failed observation must stop every downstream financial RPC",
    );
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const ORDER_ID = "20000000-0000-4000-8000-000000000002";
const attempt = {
  id: ATTEMPT_ID,
  request_id: "30000000-0000-4000-8000-000000000003",
  order_uuid: ORDER_ID,
  user_id: "40000000-0000-4000-8000-000000000004",
  state: "prepared",
  rail: "portone_cancel",
  qty: 1,
  amount: 1000,
  pg_requested_at: null,
  pg_request_body: null,
  pg_cancel_id: null,
};

const originalFetch = globalThis.fetch;
let externalCalls = 0;
globalThis.fetch = (async () => {
  externalCalls += 1;
  throw new Error("external PG must not be called");
}) as typeof fetch;

try {
  const attemptResolved = await processAttemptAuto(
    new FakeAdmin({
      order_refund_attempts: [
        { data: null, error: { code: "PGRST000", message: "attempt read failed" } },
      ],
    }) as never,
    ATTEMPT_ID,
  );
  assert.equal(attemptResolved.outcome, "blocked");
  assert.equal(attemptResolved.detail, "attempt_lookup_failed");

  const attemptThrown = await processAttemptAuto(
    new FakeAdmin({
      order_refund_attempts: [new Error("attempt transport failed")],
    }) as never,
    ATTEMPT_ID,
  );
  assert.equal(attemptThrown.outcome, "blocked");
  assert.equal(attemptThrown.detail, "attempt_lookup_failed");

  const orderResolved = await processAttemptAuto(
    new FakeAdmin({
      order_refund_attempts: [{ data: attempt, error: null }],
      orders: [
        { data: null, error: { code: "PGRST000", message: "order read failed" } },
      ],
    }) as never,
    ATTEMPT_ID,
  );
  assert.equal(orderResolved.outcome, "blocked");
  assert.equal(orderResolved.detail, "order_lookup_failed");

  const orderThrown = await processAttemptAuto(
    new FakeAdmin({
      order_refund_attempts: [{ data: attempt, error: null }],
      orders: [new Error("order transport failed")],
    }) as never,
    ATTEMPT_ID,
  );
  assert.equal(orderThrown.outcome, "blocked");
  assert.equal(orderThrown.detail, "order_lookup_failed");

  await assert.rejects(
    sweepOpenPgAttempts(
      new FakeAdmin({
        order_refund_attempts: [
          { data: null, error: { code: "PGRST000", message: "sweep read failed" } },
        ],
      }) as never,
      20,
    ),
    (error: unknown) =>
      error instanceof FailClosedReadError
      && error.message === "refund_sweep_lookup_failed",
  );

  const sweepRows = Array.from({ length: 5 }, (_, index) => ({
    id: `50000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
    state: "pg_pending",
  }));
  const outcomes = [
    {
      outcome: "processed" as const,
      attemptId: sweepRows[0]!.id,
      issuesOpened: 2,
    },
    {
      outcome: "blocked" as const,
      attemptId: sweepRows[1]!.id,
      issuesOpened: 1,
    },
    {
      outcome: "outstanding" as const,
      attemptId: sweepRows[2]!.id,
    },
    {
      outcome: "pending" as const,
      attemptId: sweepRows[3]!.id,
    },
  ];
  let outcomeIndex = 0;
  const visibleSweep = await sweepOpenPgAttempts(
    new FakeAdmin({
      order_refund_attempts: [{ data: sweepRows, error: null }],
    }) as never,
    5,
    async () => {
      const current = outcomeIndex++;
      if (current === 4) throw new Error("injected item failure");
      return outcomes[current]!;
    },
  );
  assert.deepEqual(visibleSweep, {
    attemptsChecked: 5,
    transitions: 2,
    issuesOpened: 3,
    retryPending: 3,
    systemErrors: 1,
    boundedBacklogs: 1,
    blocked: 1,
    outstanding: 1,
    pending: 1,
  });

  const emptySweep = await sweepOpenPgAttempts(
    new FakeAdmin({
      order_refund_attempts: [{ data: [], error: null }],
    }) as never,
    5,
    async () => {
      throw new Error("empty sweep must not process an item");
    },
  );
  assert.deepEqual(emptySweep, {
    attemptsChecked: 0,
    transitions: 0,
    issuesOpened: 0,
    retryPending: 0,
    systemErrors: 0,
    boundedBacklogs: 0,
    blocked: 0,
    outstanding: 0,
    pending: 0,
  });
  assert.equal(
    refundAttemptOutcomeIsSystemError({
      outcome: "blocked",
      attemptId: ATTEMPT_ID,
      detail: "attempt_lookup_failed",
    }),
    true,
  );
  assert.equal(
    refundAttemptOutcomeIsSystemError({
      outcome: "outstanding",
      attemptId: ATTEMPT_ID,
      detail: "snapshot_portone_unavailable",
    }),
    true,
  );
  assert.equal(
    refundAttemptOutcomeIsSystemError({
      outcome: "blocked",
      attemptId: ATTEMPT_ID,
      detail: "preflight_status_READY",
    }),
    false,
  );

  await assert.rejects(
    sweepOpenPgAttempts(
      new FakeAdmin({
        order_refund_attempts: [new Error("sweep transport failed")],
      }) as never,
      20,
    ),
    (error: unknown) =>
      error instanceof FailClosedReadError
      && error.message === "refund_sweep_lookup_failed",
  );

  const cancellation = {
    id: "cancel-read-fault",
    status: "SUCCEEDED" as const,
    totalAmount: 1000,
    reason: "external partial cancellation",
    requestedAt: null,
    cancelledAt: null,
    receiptUrl: null,
  };
  const partialSnapshot = {
    paymentId: "payment-read-fault",
    status: "PARTIAL_CANCELLED" as const,
    totalAmount: 3000,
    cancelledAmount: 1000,
    cancellableAmount: 2000,
    cancellations: [cancellation],
    channelType: "LIVE" as const,
    channelKey: "channel_live_card",
    currency: "KRW" as const,
    storeId: "store_boss_paegi",
    raw: {},
  };
  const unmatchedIngest = await ingestObservedCancellations(
    new FakeCancellationAdmin({
      data: {
        ok: true,
        outcome: "recorded",
        self_attributed: false,
      },
      error: null,
    }) as never,
    ORDER_ID,
    partialSnapshot,
  );
  assert.equal(unmatchedIngest.recorded, 1);
  assert.equal(unmatchedIngest.issuesOpened, 1);

  const discrepancyIngest = await ingestObservedCancellations(
    new FakeCancellationAdmin({
      data: {
        ok: true,
        outcome: "discrepancy",
        issue_id: "60000000-0000-4000-8000-000000000006",
      },
      error: null,
    }) as never,
    ORDER_ID,
    partialSnapshot,
  );
  assert.equal(discrepancyIngest.discrepancy, 1);
  assert.equal(discrepancyIngest.issuesOpened, 1);
  const resolvedIngestAdmin = new FakeCancellationAdmin({
    data: null,
    error: { code: "PGRST000", message: "observation write failed" },
  });
  const resolvedIngest = await handleObservedCancellation(
    resolvedIngestAdmin as never,
    {
      order_uuid: ORDER_ID,
      paid_at: "2026-07-29T00:00:00.000Z",
      payment_id: partialSnapshot.paymentId,
      amount: partialSnapshot.totalAmount,
      is_test: false,
      expected_store_id: partialSnapshot.storeId,
      expected_currency: partialSnapshot.currency,
      expected_channel_key: partialSnapshot.channelKey,
    },
    partialSnapshot,
  );
  assert.deepEqual(resolvedIngest, {
    outcome: "error",
    error: "cancellation_ingest_failed",
  });
  assert.deepEqual(resolvedIngestAdmin.calls, [
    "record_payment_cancellation_observation",
  ]);

  const thrownIngestAdmin = new FakeCancellationAdmin(
    new Error("observation transport failed"),
  );
  const thrownIngest = await handleObservedCancellation(
    thrownIngestAdmin as never,
    {
      order_uuid: ORDER_ID,
      paid_at: null,
      payment_id: partialSnapshot.paymentId,
      amount: partialSnapshot.totalAmount,
      is_test: false,
      expected_store_id: partialSnapshot.storeId,
      expected_currency: partialSnapshot.currency,
      expected_channel_key: partialSnapshot.channelKey,
    },
    { ...partialSnapshot, status: "CANCELLED" as const },
  );
  assert.deepEqual(thrownIngest, {
    outcome: "error",
    error: "cancellation_ingest_failed",
  });
  assert.deepEqual(thrownIngestAdmin.calls, [
    "record_payment_cancellation_observation",
  ]);

  assert.deepEqual(mapRefundRpcError("cancellation_amount_mismatch"), {
    code: "cancellation_amount_mismatch",
    http: 409,
    sentryFatal: false,
  });
  assert.deepEqual(mapRefundRpcError("cancellation_ingest_failed"), {
    code: "cancellation_ingest_failed",
    http: 503,
    sentryFatal: false,
  });
assert.deepEqual(mapRefundRpcError("legacy_checkout_refresh_required"), {
  code: "legacy_checkout_refresh_required",
  http: 503,
  sentryFatal: false,
});
assert.deepEqual(mapRefundRpcError("checkout_reuse_ambiguous"), {
  code: "checkout_reuse_ambiguous",
  http: 503,
  sentryFatal: false,
});
assert.deepEqual(mapRefundRpcError("checkout_prior_intent_unresolved"), {
  code: "checkout_prior_intent_unresolved",
  http: 409,
  sentryFatal: false,
});

  assert.equal(externalCalls, 0, "authoritative read failures must precede every external PG call");
  process.stdout.write("refund read fault injection passed\n");
} finally {
  globalThis.fetch = originalFetch;
}
