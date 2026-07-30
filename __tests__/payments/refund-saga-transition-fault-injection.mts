import assert from "node:assert/strict";
import {
  handleObservedCancellation,
  ingestObservedCancellations,
  processAttemptAuto,
} from "../../lib/refund-saga.ts";
import { refundCorrelationMarker } from "../../lib/portone.ts";

type Outcome = { data: unknown; error: unknown | null } | Error;
type FetchOutcome =
  | { status?: number; body: Record<string, unknown> }
  | Error;

const ATTEMPT_ID = "10000000-0000-4000-8000-000000000001";
const REQUEST_ID = "20000000-0000-4000-8000-000000000002";
const ORDER_ID = "30000000-0000-4000-8000-000000000003";
const USER_ID = "40000000-0000-4000-8000-000000000004";
const BATCH_ID = "50000000-0000-4000-8000-000000000005";
const PAYMENT_ID = "30000000000040008000000000000003";
const CANCELLATION_ID = "cancel-transition-fixture";
const NOW = "2026-07-29T00:00:00.000Z";

const requestBody = {
  amount: 1000,
  reason: refundCorrelationMarker(ATTEMPT_ID),
  currentCancellableAmount: 3000,
};

function attempt(
  state: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: ATTEMPT_ID,
    request_id: REQUEST_ID,
    order_uuid: ORDER_ID,
    user_id: USER_ID,
    state,
    rail: "portone_cancel",
    qty: 1,
    amount: 1000,
    pg_requested_at:
      state === "prepared" ? null : new Date(Date.now() - 60_000).toISOString(),
    pg_request_body: state === "prepared" ? null : requestBody,
    pg_cancel_id: null,
    ...overrides,
  };
}

const paidSnapshotBody = {
  id: PAYMENT_ID,
  status: "PAID",
  transactionId: "transaction-transition-fixture",
  amount: { total: 3000, cancelled: 0 },
  cancellations: [],
  currency: "KRW",
  storeId: "store_boss_paegi",
  channel: { type: "TEST", key: "channel_test_card" },
  paidAt: NOW,
};
const paidOrderEvidence = {
  order_uuid: ORDER_ID,
  payment_id: PAYMENT_ID,
  amount: 3000,
  is_test: true,
  expected_store_id: "store_boss_paegi",
  expected_currency: "KRW",
  expected_channel_key: "channel_test_card",
};

const succeededPostBody = {
  cancellation: {
    id: CANCELLATION_ID,
    status: "SUCCEEDED",
    totalAmount: 1000,
    taxFreeAmount: 0,
    vatAmount: 0,
    reason: refundCorrelationMarker(ATTEMPT_ID),
    requestedAt: NOW,
    cancelledAt: NOW,
    receiptUrl: "https://example.invalid/refund",
  },
};

const requestedPostBody = {
  cancellation: {
    id: CANCELLATION_ID,
    status: "REQUESTED",
    totalAmount: 1000,
    taxFreeAmount: 0,
    vatAmount: 0,
    reason: refundCorrelationMarker(ATTEMPT_ID),
    requestedAt: NOW,
  },
};

const preflightPostcondition = {
  id: ATTEMPT_ID,
  state: "pg_requested",
  pg_total_before: 3000,
  pg_cancelled_before: 0,
  pg_cancellable_before: 3000,
  pg_cancellation_ids_before: [],
  pg_idempotency_key: ATTEMPT_ID,
  pg_requested_at: NOW,
  pg_request_body: requestBody,
};

const markAck = {
  ok: true,
  outcome: "pg_requested",
  attempt_id: ATTEMPT_ID,
};
const succeededAck = {
  ok: true,
  outcome: "pg_succeeded",
  cancellation_id: CANCELLATION_ID,
};
const pendingAck = { ok: true, outcome: "pending" };
const failedAck = { ok: true, outcome: "manual_review" };
const commitAck = {
  ok: true,
  outcome: "committed",
  attempt_id: ATTEMPT_ID,
};

class ScriptedAdmin {
  readonly calls: Array<{ name: string; args: unknown }> = [];
  readonly reads: Record<string, Outcome[]>;
  readonly rpcs: Record<string, Outcome[]>;

  constructor(options: {
    reads?: Record<string, Outcome[]>;
    rpcs?: Record<string, Outcome[]>;
  }) {
    this.reads = options.reads ?? {};
    this.rpcs = options.rpcs ?? {};
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

  async rpc(name: string, args: unknown): Promise<{
    data: unknown;
    error: unknown | null;
  }> {
    this.calls.push({ name, args });
    const outcome = this.rpcs[name]?.shift();
    assert.ok(outcome, `unexpected RPC: ${name}`);
    if (outcome instanceof Error) throw outcome;
    return outcome;
  }
}

let fetchOutcomes: FetchOutcome[] = [];
let fetchCalls: Array<{ url: string; method: string }> = [];
const originalFetch = globalThis.fetch;

globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  fetchCalls.push({
    url:
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
    method: init?.method ?? "GET",
  });
  const outcome = fetchOutcomes.shift();
  assert.ok(outcome, "unexpected external PG request");
  if (outcome instanceof Error) throw outcome;
  return new Response(JSON.stringify(outcome.body), {
    status: outcome.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}) as typeof fetch;

function setFetch(...outcomes: FetchOutcome[]): void {
  fetchOutcomes = [...outcomes];
  fetchCalls = [];
}

function preparedAdmin(options: {
  order?: Outcome;
  mark?: Outcome;
  preflight?: Outcome;
  record?: Outcome;
  recordPostcondition?: Outcome;
  commit?: Outcome;
  commitPostcondition?: Outcome;
} = {}): ScriptedAdmin {
  return new ScriptedAdmin({
    reads: {
      order_refund_attempts: [
        { data: attempt("prepared"), error: null },
        options.preflight ?? { data: preflightPostcondition, error: null },
        options.recordPostcondition ?? {
          data: { state: "pg_succeeded", pg_cancel_id: CANCELLATION_ID },
          error: null,
        },
        options.commitPostcondition ?? {
          data: { state: "committed" },
          error: null,
        },
      ],
      orders: [
        options.order ?? { data: paidOrderEvidence, error: null },
      ],
    },
    rpcs: {
      admin_refund_mark_pg_requested: [
        options.mark ?? { data: markAck, error: null },
      ],
      admin_refund_record_pg_result: [
        options.record ?? { data: succeededAck, error: null },
      ],
      admin_refund_commit: [
        options.commit ?? { data: commitAck, error: null },
      ],
    },
  });
}

function rpcNames(admin: ScriptedAdmin): string[] {
  return admin.calls.map((call) => call.name);
}

try {
  // prepared → preflight proof → PG POST → record proof → commit proof.
  setFetch(
    { body: paidSnapshotBody },
    { body: succeededPostBody },
  );
  const successAdmin = preparedAdmin();
  assert.deepEqual(
    await processAttemptAuto(successAdmin as never, ATTEMPT_ID),
    {
      outcome: "processed",
      attemptId: ATTEMPT_ID,
      cancellationId: CANCELLATION_ID,
    },
  );
  assert.deepEqual(fetchCalls.map((call) => call.method), ["GET", "POST"]);
  assert.deepEqual(rpcNames(successAdmin), [
    "admin_refund_mark_pg_requested",
    "admin_refund_record_pg_result",
    "admin_refund_commit",
  ]);

  // Provider identity must be exact before cancellation observation or POST.
  setFetch({
    body: {
      ...paidSnapshotBody,
      channel: { type: "TEST", key: "wrong-channel" },
    },
  });
  const mismatchedEvidenceAdmin = preparedAdmin();
  assert.deepEqual(
    await processAttemptAuto(mismatchedEvidenceAdmin as never, ATTEMPT_ID),
    {
      outcome: "blocked",
      attemptId: ATTEMPT_ID,
      detail: "payment_evidence_mismatch",
    },
  );
  assert.deepEqual(fetchCalls.map((call) => call.method), ["GET"]);
  assert.deepEqual(rpcNames(mismatchedEvidenceAdmin), []);

  setFetch({ body: paidSnapshotBody });
  const legacyEvidenceAdmin = preparedAdmin({
    order: {
      data: {
        ...paidOrderEvidence,
        expected_store_id: null,
        expected_currency: null,
        expected_channel_key: null,
      },
      error: null,
    },
  });
  assert.deepEqual(
    await processAttemptAuto(legacyEvidenceAdmin as never, ATTEMPT_ID),
    {
      outcome: "blocked",
      attemptId: ATTEMPT_ID,
      detail: "payment_evidence_incomplete",
    },
  );
  assert.deepEqual(fetchCalls.map((call) => call.method), ["GET"]);
  assert.deepEqual(rpcNames(legacyEvidenceAdmin), []);

  // Preflight acknowledgement must be exact, and its durable proof must precede POST.
  for (const [label, mark, expectedDetail] of [
    ["null", { data: null, error: null }, "preflight_result_invalid"],
    [
      "malformed",
      { data: { ok: true, outcome: "pg_requested" }, error: null },
      "preflight_result_invalid",
    ],
    ["throw", new Error("mark transport failed"), "rpc_unavailable"],
  ] satisfies Array<[string, Outcome, string]>) {
    setFetch({ body: paidSnapshotBody });
    const admin = preparedAdmin({ mark });
    const result = await processAttemptAuto(admin as never, ATTEMPT_ID);
    assert.equal(result.outcome, "blocked", label);
    assert.equal(result.detail, expectedDetail, label);
    assert.deepEqual(fetchCalls.map((call) => call.method), ["GET"], label);
    assert.deepEqual(rpcNames(admin), ["admin_refund_mark_pg_requested"], label);
  }

  for (const [label, preflight] of [
    ["mismatch", { data: { ...preflightPostcondition, state: "prepared" }, error: null }],
    ["null", { data: null, error: null }],
    [
      "resolved error",
      { data: null, error: { code: "PGRST000", message: "proof failed" } },
    ],
    ["throw", new Error("proof transport failed")],
  ] satisfies Array<[string, Outcome]>) {
    setFetch({ body: paidSnapshotBody });
    const admin = preparedAdmin({ preflight });
    const result = await processAttemptAuto(admin as never, ATTEMPT_ID);
    assert.equal(result.outcome, "blocked", label);
    assert.equal(result.detail, "preflight_result_unproven", label);
    assert.deepEqual(fetchCalls.map((call) => call.method), ["GET"], label);
    assert.deepEqual(rpcNames(admin), ["admin_refund_mark_pg_requested"], label);
  }

  // A successful PG cancellation is not exposed as processed until record and commit
  // acknowledgements and both durable postconditions are proven.
  for (const [label, record, expectedDetail] of [
    ["null", { data: null, error: null }, "record_result_invalid"],
    [
      "malformed",
      { data: { ok: true, outcome: "pg_succeeded" }, error: null },
      "record_result_invalid",
    ],
    ["throw", new Error("record transport failed"), "rpc_unavailable"],
  ] satisfies Array<[string, Outcome, string]>) {
    setFetch({ body: paidSnapshotBody }, { body: succeededPostBody });
    const admin = preparedAdmin({ record });
    const result = await processAttemptAuto(admin as never, ATTEMPT_ID);
    assert.equal(result.outcome, "blocked", label);
    assert.equal(result.detail, expectedDetail, label);
    assert.deepEqual(rpcNames(admin), [
      "admin_refund_mark_pg_requested",
      "admin_refund_record_pg_result",
    ], label);
  }

  for (const [label, recordPostcondition] of [
    ["mismatch", { data: { state: "pg_requested", pg_cancel_id: null }, error: null }],
    ["null", { data: null, error: null }],
    [
      "resolved error",
      { data: null, error: { code: "PGRST000", message: "record proof failed" } },
    ],
    ["throw", new Error("record proof transport failed")],
  ] satisfies Array<[string, Outcome]>) {
    setFetch({ body: paidSnapshotBody }, { body: succeededPostBody });
    const admin = preparedAdmin({ recordPostcondition });
    const result = await processAttemptAuto(admin as never, ATTEMPT_ID);
    assert.equal(result.outcome, "blocked", label);
    assert.equal(result.detail, "record_result_unproven", label);
    assert.deepEqual(rpcNames(admin), [
      "admin_refund_mark_pg_requested",
      "admin_refund_record_pg_result",
    ], label);
  }

  for (const [label, commit, expectedDetail] of [
    ["null", { data: null, error: null }, "commit_result_invalid"],
    [
      "malformed",
      { data: { ok: true, outcome: "committed" }, error: null },
      "commit_result_invalid",
    ],
    ["throw", new Error("commit transport failed"), "rpc_unavailable"],
  ] satisfies Array<[string, Outcome, string]>) {
    setFetch({ body: paidSnapshotBody }, { body: succeededPostBody });
    const admin = preparedAdmin({ commit });
    const result = await processAttemptAuto(admin as never, ATTEMPT_ID);
    assert.equal(result.outcome, "blocked", label);
    assert.equal(result.detail, expectedDetail, label);
  }

  for (const [label, commitPostcondition] of [
    ["mismatch", { data: { state: "pg_succeeded" }, error: null }],
    ["null", { data: null, error: null }],
    [
      "resolved error",
      { data: null, error: { code: "PGRST000", message: "commit proof failed" } },
    ],
    ["throw", new Error("commit proof transport failed")],
  ] satisfies Array<[string, Outcome]>) {
    setFetch({ body: paidSnapshotBody }, { body: succeededPostBody });
    const admin = preparedAdmin({ commitPostcondition });
    const result = await processAttemptAuto(admin as never, ATTEMPT_ID);
    assert.equal(result.outcome, "blocked", label);
    assert.equal(result.detail, "commit_result_unproven", label);
  }

  // REQUESTED is pending only after the record acknowledgement and state proof.
  setFetch({ body: paidSnapshotBody }, { body: requestedPostBody });
  const pendingAdmin = preparedAdmin({
    record: { data: pendingAck, error: null },
    recordPostcondition: { data: { state: "pg_pending" }, error: null },
  });
  assert.deepEqual(
    await processAttemptAuto(pendingAdmin as never, ATTEMPT_ID),
    { outcome: "pending", attemptId: ATTEMPT_ID },
  );

  for (const [label, record, postcondition, expectedDetail] of [
    [
      "null ack",
      { data: null, error: null },
      { data: { state: "pg_pending" }, error: null },
      "record_result_invalid",
    ],
    [
      "malformed ack",
      { data: { ok: true, outcome: "unknown" }, error: null },
      { data: { state: "pg_pending" }, error: null },
      "record_result_invalid",
    ],
    [
      "throw",
      new Error("pending record transport failed"),
      { data: { state: "pg_pending" }, error: null },
      "rpc_unavailable",
    ],
    [
      "postcondition mismatch",
      { data: pendingAck, error: null },
      { data: { state: "pg_requested" }, error: null },
      "record_result_unproven",
    ],
  ] satisfies Array<[string, Outcome, Outcome, string]>) {
    setFetch({ body: paidSnapshotBody }, { body: requestedPostBody });
    const admin = preparedAdmin({
      record,
      recordPostcondition: postcondition,
    });
    const result = await processAttemptAuto(admin as never, ATTEMPT_ID);
    assert.equal(result.outcome, "blocked", label);
    assert.equal(result.detail, expectedDetail, label);
  }

  // A stale pg_requested attempt transitions to manual review only with exact ack + proof.
  const staleAttempt = attempt("pg_requested", {
    pg_requested_at: new Date(Date.now() - 4 * 60 * 60 * 1000).toISOString(),
  });
  async function runStale(
    record: Outcome,
    recordPostcondition: Outcome,
  ) {
    setFetch({ body: paidSnapshotBody });
    const admin = new ScriptedAdmin({
      reads: {
        order_refund_attempts: [
          { data: staleAttempt, error: null },
          recordPostcondition,
        ],
        orders: [{ data: paidOrderEvidence, error: null }],
      },
      rpcs: { admin_refund_record_pg_result: [record] },
    });
    return {
      result: await processAttemptAuto(admin as never, ATTEMPT_ID),
      admin,
    };
  }

  assert.deepEqual(
    (await runStale(
      { data: failedAck, error: null },
      { data: { state: "manual_review" }, error: null },
    )).result,
    {
      outcome: "manual_review",
      attemptId: ATTEMPT_ID,
      detail: "retry_cutoff_elapsed",
    },
  );
  for (const [label, record, postcondition, expectedDetail] of [
    [
      "null ack",
      { data: null, error: null },
      { data: { state: "manual_review" }, error: null },
      "record_result_invalid",
    ],
    [
      "malformed ack",
      { data: { ok: true, outcome: "failed" }, error: null },
      { data: { state: "manual_review" }, error: null },
      "record_result_invalid",
    ],
    [
      "throw",
      new Error("failed record transport failed"),
      { data: { state: "manual_review" }, error: null },
      "rpc_unavailable",
    ],
    [
      "postcondition mismatch",
      { data: failedAck, error: null },
      { data: { state: "pg_requested" }, error: null },
      "record_result_unproven",
    ],
  ] satisfies Array<[string, Outcome, Outcome, string]>) {
    const { result } = await runStale(record, postcondition);
    assert.equal(result.outcome, "blocked", label);
    assert.equal(result.detail, expectedDetail, label);
  }

  // pg_succeeded recovery has the same strict commit protocol without a new POST.
  async function runCommitRecovery(
    commit: Outcome,
    postcondition: Outcome,
  ) {
    setFetch({ body: paidSnapshotBody });
    const admin = new ScriptedAdmin({
      reads: {
        order_refund_attempts: [
          { data: attempt("pg_succeeded"), error: null },
          postcondition,
        ],
        orders: [{ data: paidOrderEvidence, error: null }],
      },
      rpcs: { admin_refund_commit: [commit] },
    });
    return processAttemptAuto(admin as never, ATTEMPT_ID);
  }
  assert.deepEqual(
    await runCommitRecovery(
      { data: commitAck, error: null },
      { data: { state: "committed" }, error: null },
    ),
    { outcome: "processed", attemptId: ATTEMPT_ID },
  );
  for (const [label, commit, postcondition, expectedDetail] of [
    [
      "null ack",
      { data: null, error: null },
      { data: { state: "committed" }, error: null },
      "commit_result_invalid",
    ],
    [
      "malformed ack",
      { data: { ok: true }, error: null },
      { data: { state: "committed" }, error: null },
      "commit_result_invalid",
    ],
    [
      "throw",
      new Error("commit recovery transport failed"),
      { data: { state: "committed" }, error: null },
      "rpc_unavailable",
    ],
    [
      "postcondition mismatch",
      { data: commitAck, error: null },
      { data: { state: "pg_succeeded" }, error: null },
      "commit_result_unproven",
    ],
  ] satisfies Array<[string, Outcome, Outcome, string]>) {
    const result = await runCommitRecovery(commit, postcondition);
    assert.equal(result.outcome, "blocked", label);
    assert.equal(result.detail, expectedDetail, label);
  }

  // External cancellation ingestion and local terminal transitions also fail closed.
  const terminalCancellation = {
    id: CANCELLATION_ID,
    status: "SUCCEEDED" as const,
    totalAmount: 3000,
    reason: "external cancellation",
    requestedAt: NOW,
    cancelledAt: NOW,
    receiptUrl: null,
  };
  const canceledSnapshot = {
    paymentId: PAYMENT_ID,
    status: "CANCELLED" as const,
    totalAmount: 3000,
    cancelledAmount: 3000,
    cancellableAmount: 0,
    cancellations: [],
    channelType: "TEST" as const,
    channelKey: "channel_test_card",
    currency: "KRW" as const,
    storeId: "store_boss_paegi",
    raw: {},
  };

  const rejectedCancellationAdmin = new ScriptedAdmin({});
  assert.deepEqual(
    await handleObservedCancellation(
      rejectedCancellationAdmin as never,
      {
        order_uuid: ORDER_ID,
        paid_at: NOW,
        payment_id: canceledSnapshot.paymentId,
        amount: canceledSnapshot.totalAmount,
        is_test: true,
        expected_store_id: canceledSnapshot.storeId,
        expected_currency: canceledSnapshot.currency,
        expected_channel_key: "wrong-channel",
      },
      canceledSnapshot,
    ),
    { outcome: "error", error: "payment_evidence_mismatch" },
  );
  assert.deepEqual(rejectedCancellationAdmin.calls, []);

  const legacyCancellationAdmin = new ScriptedAdmin({});
  assert.deepEqual(
    await handleObservedCancellation(
      legacyCancellationAdmin as never,
      {
        order_uuid: ORDER_ID,
        paid_at: NOW,
        payment_id: canceledSnapshot.paymentId,
        amount: canceledSnapshot.totalAmount,
        is_test: true,
        expected_store_id: null,
        expected_currency: null,
        expected_channel_key: null,
      },
      canceledSnapshot,
    ),
    { outcome: "error", error: "payment_evidence_incomplete" },
  );
  assert.deepEqual(legacyCancellationAdmin.calls, []);

  async function runCanceledUnpaid(
    transition: Outcome,
    postcondition: Outcome,
  ) {
    const admin = new ScriptedAdmin({
      reads: { orders: [postcondition] },
      rpcs: { mark_order_canceled_unpaid: [transition] },
    });
    return handleObservedCancellation(
      admin as never,
      {
        order_uuid: ORDER_ID,
        paid_at: null,
        payment_id: canceledSnapshot.paymentId,
        amount: canceledSnapshot.totalAmount,
        is_test: true,
        expected_store_id: canceledSnapshot.storeId,
        expected_currency: canceledSnapshot.currency,
        expected_channel_key: canceledSnapshot.channelKey,
      },
      canceledSnapshot,
    );
  }
  assert.deepEqual(
    await runCanceledUnpaid(
      { data: { ok: true, outcome: "canceled" }, error: null },
      {
        data: { status: "canceled", canceled_at: NOW, paid_at: null },
        error: null,
      },
    ),
    { outcome: "canceled_unpaid" },
  );
  for (const [label, transition, postcondition, expectedError] of [
    [
      "null ack",
      { data: null, error: null },
      { data: null, error: null },
      "cancellation_transition_invalid",
    ],
    [
      "malformed ack",
      { data: { ok: true, outcome: "unknown" }, error: null },
      { data: null, error: null },
      "cancellation_transition_invalid",
    ],
    [
      "throw",
      new Error("cancel transition transport failed"),
      { data: null, error: null },
      "rpc_unavailable",
    ],
    [
      "postcondition mismatch",
      { data: { ok: true, outcome: "canceled" }, error: null },
      { data: { status: "pending", canceled_at: null, paid_at: null }, error: null },
      "cancellation_transition_incomplete",
    ],
  ] satisfies Array<[string, Outcome, Outcome, string]>) {
    const result = await runCanceledUnpaid(transition, postcondition);
    assert.deepEqual(
      result,
      { outcome: "error", error: expectedError },
      label,
    );
  }

  async function runAutoFull(
    resolution: Outcome,
    postcondition?: Outcome,
  ) {
    const admin = new ScriptedAdmin({
      reads: postcondition ? { orders: [postcondition] } : {},
      rpcs: { resolve_external_cancellation_auto_full: [resolution] },
    });
    return handleObservedCancellation(
      admin as never,
      {
        order_uuid: ORDER_ID,
        paid_at: NOW,
        payment_id: canceledSnapshot.paymentId,
        amount: canceledSnapshot.totalAmount,
        is_test: true,
        expected_store_id: canceledSnapshot.storeId,
        expected_currency: canceledSnapshot.currency,
        expected_channel_key: canceledSnapshot.channelKey,
      },
      canceledSnapshot,
    );
  }
  assert.deepEqual(
    await runAutoFull(
      {
        data: {
          ok: true,
          outcome: "resolved_full",
          batch_id: BATCH_ID,
          events: 1,
        },
        error: null,
      },
      {
        data: {
          status: "canceled",
          canceled_at: NOW,
          paid_at: NOW,
          amount: 3000,
          credits: 10,
          refunded_amount: 3000,
          refunded_credits: 10,
        },
        error: null,
      },
    ),
    { outcome: "resolved_full", batchId: BATCH_ID },
  );
  assert.deepEqual(
    await runAutoFull({
      data: { ok: true, outcome: "ineligible" },
      error: null,
    }),
    { outcome: "ineligible" },
  );
  for (const [label, resolution, postcondition, expectedError] of [
    [
      "null ack",
      { data: null, error: null },
      undefined,
      "cancellation_resolution_invalid",
    ],
    [
      "malformed ack",
      { data: { ok: true, outcome: "resolved_full" }, error: null },
      undefined,
      "cancellation_resolution_invalid",
    ],
    [
      "throw",
      new Error("auto full transport failed"),
      undefined,
      "rpc_unavailable",
    ],
    [
      "postcondition mismatch",
      {
        data: {
          ok: true,
          outcome: "resolved_full",
          batch_id: BATCH_ID,
          events: 1,
        },
        error: null,
      },
      {
        data: {
          status: "paid",
          canceled_at: null,
          paid_at: NOW,
          amount: 3000,
          credits: 10,
          refunded_amount: 0,
          refunded_credits: 0,
        },
        error: null,
      },
      "cancellation_resolution_incomplete",
    ],
  ] satisfies Array<[string, Outcome, Outcome | undefined, string]>) {
    const result = await runAutoFull(resolution, postcondition);
    assert.deepEqual(
      result,
      { outcome: "error", error: expectedError },
      label,
    );
  }

  for (const [label, observation, expected] of [
    [
      "recorded",
      { data: { outcome: "recorded" }, error: null },
      { recorded: 1, noop: 0, discrepancy: 0, issuesOpened: 0, skipped: 0, failed: 0 },
    ],
    [
      "no_op",
      { data: { outcome: "no_op" }, error: null },
      { recorded: 0, noop: 1, discrepancy: 0, issuesOpened: 0, skipped: 0, failed: 0 },
    ],
    [
      "discrepancy",
      { data: { outcome: "discrepancy" }, error: null },
      { recorded: 0, noop: 0, discrepancy: 1, issuesOpened: 1, skipped: 0, failed: 0 },
    ],
    [
      "null",
      { data: null, error: null },
      { recorded: 0, noop: 0, discrepancy: 0, issuesOpened: 0, skipped: 0, failed: 1 },
    ],
    [
      "malformed",
      { data: { outcome: "unknown" }, error: null },
      { recorded: 0, noop: 0, discrepancy: 0, issuesOpened: 0, skipped: 0, failed: 1 },
    ],
    [
      "throw",
      new Error("observation transport failed"),
      { recorded: 0, noop: 0, discrepancy: 0, issuesOpened: 0, skipped: 0, failed: 1 },
    ],
  ] satisfies Array<[string, Outcome, Record<string, number>]>) {
    const admin = new ScriptedAdmin({
      rpcs: { record_payment_cancellation_observation: [observation] },
    });
    const result = await ingestObservedCancellations(
      admin as never,
      ORDER_ID,
      { ...canceledSnapshot, cancellations: [terminalCancellation] },
    );
    assert.deepEqual(result, expected, label);
  }

  const skipped = await ingestObservedCancellations(
    new ScriptedAdmin({}) as never,
    ORDER_ID,
    {
      ...canceledSnapshot,
      cancellations: [
        { ...terminalCancellation, id: "" },
        { ...terminalCancellation, status: "REQUESTED" as const },
        { ...terminalCancellation, totalAmount: null },
      ],
    },
  );
  assert.deepEqual(skipped, {
    recorded: 0,
    noop: 0,
    discrepancy: 0,
    issuesOpened: 0,
    skipped: 3,
    failed: 0,
  });

  assert.equal(fetchOutcomes.length, 0, "every scripted PG response must be consumed");
  process.stdout.write("refund saga transition fault injection passed\n");
} finally {
  globalThis.fetch = originalFetch;
}
