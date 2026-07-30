import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isAdminRefundAttemptPostcondition,
  isExternalCancellationResolutionPostcondition,
  isReconciliationIssueResolutionPostcondition,
  isRefundAttemptStatePostcondition,
  isRefundPgRequestedPostcondition,
  parseAdminRefundAttemptResult,
  parseAdminRefundBeginResult,
  parseExternalCancellationResolutionResult,
  parseReconciliationIssueResolutionResult,
  parseRefundCommitResult,
  parseRefundMarkRequestedResult,
  parseRefundRecordResult,
  proveAdminRefundBegin,
} from "../../lib/pay/refund-mutation-result.ts";

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const USER = "33333333-3333-4333-8333-333333333333";
const ORDER = "44444444-4444-4444-8444-444444444444";
const ISSUE = "55555555-5555-4555-8555-555555555555";
const EVIDENCE = "66666666-6666-4666-8666-666666666666";
const CANCELLATION = "cancel-1";
const BODY = {
  amount: 1000,
  reason: `BP_REFUND:${ATTEMPT}`,
  currentCancellableAmount: 3000,
};

test("refund preflight ack and persisted evidence are exact", () => {
  assert.equal(
    parseRefundMarkRequestedResult(
      { ok: true, outcome: "pg_requested", attempt_id: ATTEMPT },
      ATTEMPT,
    ),
    "pg_requested",
  );
  assert.equal(
    parseRefundMarkRequestedResult(
      { ok: true, outcome: "no_op", idempotent: true },
      ATTEMPT,
    ),
    "no_op",
  );
  for (const value of [
    null,
    {},
    { ok: false, outcome: "pg_requested", attempt_id: ATTEMPT },
    { ok: true, outcome: "pg_requested" },
    { ok: true, outcome: "pg_requested", attempt_id: "other" },
    { ok: true, outcome: "no_op" },
  ]) {
    assert.equal(parseRefundMarkRequestedResult(value, ATTEMPT), null);
  }

  const expected = {
    attemptId: ATTEMPT,
    totalBefore: 3000,
    cancelledBefore: 0,
    cancellableBefore: 3000,
    cancellationIdsBefore: ["old-1"],
    requestBody: BODY,
  };
  const row = {
    id: ATTEMPT,
    state: "pg_requested",
    pg_total_before: 3000,
    pg_cancelled_before: 0,
    pg_cancellable_before: 3000,
    pg_cancellation_ids_before: ["old-1"],
    pg_idempotency_key: ATTEMPT,
    pg_requested_at: "2026-07-29T00:00:00Z",
    pg_request_body: BODY,
  };
  assert.equal(isRefundPgRequestedPostcondition(row, expected), true);
  for (const mutation of [
    { state: "prepared" },
    { pg_total_before: null },
    { pg_cancellation_ids_before: [] },
    { pg_idempotency_key: "other" },
    { pg_requested_at: null },
    { pg_request_body: { ...BODY, amount: 999 } },
  ]) {
    assert.equal(
      isRefundPgRequestedPostcondition({ ...row, ...mutation }, expected),
      false,
    );
  }
});

test("refund record and commit outcomes reject every malformed success", () => {
  assert.equal(
    parseRefundRecordResult(
      {
        ok: true,
        outcome: "pg_succeeded",
        cancellation_id: CANCELLATION,
      },
      { kind: "succeeded", cancellationId: CANCELLATION },
    ),
    "recorded",
  );
  assert.equal(
    parseRefundRecordResult(
      { ok: true, outcome: "no_op", idempotent: true },
      { kind: "succeeded", cancellationId: CANCELLATION },
    ),
    "no_op",
  );
  assert.equal(
    parseRefundRecordResult(
      { ok: true, outcome: "pending" },
      { kind: "pending" },
    ),
    "recorded",
  );
  assert.equal(
    parseRefundRecordResult(
      { ok: true, outcome: "manual_review" },
      { kind: "failed" },
    ),
    "recorded",
  );
  for (const value of [
    null,
    {},
    { ok: false, outcome: "pending" },
    { ok: true, outcome: "unknown" },
  ]) {
    assert.equal(
      parseRefundRecordResult(value, { kind: "pending" }),
      null,
    );
  }

  assert.equal(
    parseRefundCommitResult(
      { ok: true, outcome: "committed", attempt_id: ATTEMPT },
      ATTEMPT,
    ),
    "committed",
  );
  assert.equal(
    parseRefundCommitResult(
      { ok: true, outcome: "no_op", idempotent: true },
      ATTEMPT,
    ),
    "no_op",
  );
  for (const value of [
    null,
    {},
    { ok: true, outcome: "committed", attempt_id: "other" },
    { ok: true, outcome: "no_op" },
  ]) {
    assert.equal(parseRefundCommitResult(value, ATTEMPT), null);
  }
  assert.equal(
    isRefundAttemptStatePostcondition(
      { state: "pg_succeeded", pg_cancel_id: CANCELLATION },
      ["pg_succeeded", "committed"],
      CANCELLATION,
    ),
    true,
  );
  assert.equal(
    isRefundAttemptStatePostcondition(
      { state: "pg_succeeded", pg_cancel_id: "other" },
      ["pg_succeeded"],
      CANCELLATION,
    ),
    false,
  );
});

test("refund orchestration proves preflight before PG POST and every terminal ack", () => {
  const source = readFileSync(
    new URL("../../lib/refund-saga.ts", import.meta.url),
    "utf8",
  );
  const mark = source.indexOf(
    "parseRefundMarkRequestedResult(marked.data",
  );
  const proof = source.indexOf("isRefundPgRequestedPostcondition(", mark);
  const post = source.indexOf("return executePgPost(", proof);
  assert.ok(mark >= 0);
  assert.ok(proof > mark);
  assert.ok(post > proof);
  assert.match(source, /parseRefundRecordResult/);
  assert.match(source, /parseRefundCommitResult/);
  assert.match(source, /isRefundAttemptStatePostcondition/);
});

test("admin refund begin rejects null/malformed/cross-request receipts and restores replay attempt_id only from durable proof", () => {
  const prepared = {
    ok: true,
    outcome: "prepared",
    request_id: REQUEST,
    attempt_id: ATTEMPT,
    qty: 2,
    amount: 1800,
    rate_bps: 9000,
  };
  const replay = {
    ok: true,
    outcome: "no_op",
    idempotent: true,
    request_id: REQUEST,
  };
  const requestRow = {
    id: REQUEST,
    user_id: USER,
    origin: "admin_manual",
    requested_qty: 2,
    approved_amount: 1800,
    state: "prepared",
  };
  const attemptRow = {
    id: ATTEMPT,
    request_id: REQUEST,
    sequence: 1,
    order_uuid: ORDER,
    user_id: USER,
    qty: 2,
    amount: 1800,
    rate_bps: 9000,
    state: "prepared",
  };
  const expected = {
    requestId: REQUEST,
    userId: USER,
    orderUuid: ORDER,
    qty: 2,
  };

  const preparedReceipt = parseAdminRefundBeginResult(prepared, {
    requestId: REQUEST,
    qty: 2,
  });
  assert.ok(preparedReceipt);
  assert.deepEqual(
    proveAdminRefundBegin(
      preparedReceipt,
      requestRow,
      attemptRow,
      expected,
    ),
    {
      ok: true,
      outcome: "prepared",
      request_id: REQUEST,
      attempt_id: ATTEMPT,
      qty: 2,
      amount: 1800,
      rate_bps: 9000,
    },
  );

  const replayReceipt = parseAdminRefundBeginResult(replay, {
    requestId: REQUEST,
    qty: 2,
  });
  assert.ok(replayReceipt);
  assert.deepEqual(
    proveAdminRefundBegin(replayReceipt, requestRow, attemptRow, expected),
    {
      ok: true,
      outcome: "no_op",
      idempotent: true,
      request_id: REQUEST,
      attempt_id: ATTEMPT,
      qty: 2,
      amount: 1800,
      rate_bps: 9000,
    },
    "the replay's omitted attempt id comes from the exact request/attempt join",
  );

  for (const value of [
    null,
    {},
    { ...prepared, ok: false },
    { ...prepared, request_id: USER },
    { ...prepared, attempt_id: "not-a-uuid" },
    { ...prepared, qty: 3 },
    { ...prepared, amount: 0 },
    { ...prepared, rate_bps: 9500 },
    { ...replay, idempotent: false },
  ]) {
    assert.equal(
      parseAdminRefundBeginResult(value, {
        requestId: REQUEST,
        qty: 2,
      }),
      null,
      JSON.stringify(value),
    );
  }
  for (const [requestMutation, attemptMutation] of [
    [{ state: "building" }, {}],
    [{ id: USER }, {}],
    [{ approved_amount: 1801 }, {}],
    [{}, { id: USER }],
    [{}, { request_id: USER }],
    [{}, { order_uuid: USER }],
    [{}, { amount: 1801 }],
    [{}, { rate_bps: 9500 }],
  ]) {
    assert.equal(
      proveAdminRefundBegin(
        preparedReceipt,
        { ...requestRow, ...requestMutation },
        { ...attemptRow, ...attemptMutation },
        expected,
      ),
      null,
    );
  }
});

test("every manual refund action requires an exact receipt and durable action-specific postcondition", () => {
  const cases: Array<{
    action:
      | "release"
      | "commit_manual"
      | "switch_to_manual"
      | "replan_pre_pg"
      | "replan_after_pg";
    ack: Record<string, unknown>;
    row: Record<string, unknown>;
    expected: Parameters<typeof isAdminRefundAttemptPostcondition>[1];
    wrong: Record<string, unknown>;
  }> = [
    {
      action: "release" as const,
      ack: {
        ok: true,
        outcome: "released",
        attempt_id: ATTEMPT,
      },
      row: {
        id: ATTEMPT,
        state: "released",
        release_reason: "admin_cancelled_before_pg",
      },
      expected: {
        action: "release",
        attemptId: ATTEMPT,
      },
      wrong: { release_reason: "replanned_before_pg" },
    },
    {
      action: "commit_manual" as const,
      ack: {
        ok: true,
        outcome: "committed",
        attempt_id: ATTEMPT,
      },
      row: {
        id: ATTEMPT,
        state: "committed",
        rail: "manual_transfer",
        external_payout_ref: "payout-1",
        payout_evidence: {
          method: "bank_transfer",
          evidence_object_id: EVIDENCE,
        },
      },
      expected: {
        action: "commit_manual",
        attemptId: ATTEMPT,
        externalPayoutRef: "payout-1",
        evidenceObjectId: EVIDENCE,
      },
      wrong: { external_payout_ref: "payout-2" },
    },
    {
      action: "switch_to_manual" as const,
      ack: {
        ok: true,
        outcome: "manual_pending",
        attempt_id: ATTEMPT,
      },
      row: {
        id: ATTEMPT,
        state: "manual_pending",
        rail: "manual_transfer",
        reconciliation_result: "no_movement",
        observed_cancelled_amount: 0,
        observed_cancellation_ids: ["a", "b"],
        verification_source: "admin_reconcile",
      },
      expected: {
        action: "switch_to_manual",
        attemptId: ATTEMPT,
        observedCancelledAmount: 0,
        observedCancellationIds: ["a", "b"],
      },
      wrong: { observed_cancellation_ids: ["b", "a"] },
    },
    {
      action: "replan_pre_pg" as const,
      ack: {
        ok: true,
        outcome: "released",
        release_reason: "replanned_before_pg",
      },
      row: {
        id: ATTEMPT,
        state: "released",
        release_reason: "replanned_before_pg",
      },
      expected: {
        action: "replan_pre_pg",
        attemptId: ATTEMPT,
      },
      wrong: { state: "prepared" },
    },
    {
      action: "replan_after_pg" as const,
      ack: {
        ok: true,
        outcome: "released",
        release_reason: "replanned_after_pg_reconciliation",
      },
      row: {
        id: ATTEMPT,
        state: "released",
        release_reason: "replanned_after_pg_reconciliation",
        reconciliation_result: "no_movement",
        observed_cancelled_amount: 0,
        observed_cancellation_ids: ["a"],
        verification_source: "admin_reconcile",
      },
      expected: {
        action: "replan_after_pg",
        attemptId: ATTEMPT,
        observedCancelledAmount: 0,
        observedCancellationIds: ["a"],
      },
      wrong: { verification_source: "resolver" },
    },
  ];

  for (const entry of cases) {
    assert.equal(
      parseAdminRefundAttemptResult(entry.ack, {
        action: entry.action,
        attemptId: ATTEMPT,
      }),
      "applied",
      entry.action,
    );
    assert.equal(
      parseAdminRefundAttemptResult(
        { ok: true, outcome: "no_op", idempotent: true },
        { action: entry.action, attemptId: ATTEMPT },
      ),
      "no_op",
      entry.action,
    );
    assert.equal(
      isAdminRefundAttemptPostcondition(entry.row, entry.expected),
      true,
      entry.action,
    );
    assert.equal(
      isAdminRefundAttemptPostcondition(
        { ...entry.row, ...entry.wrong },
        entry.expected,
      ),
      false,
      entry.action,
    );
    const malformedValues: unknown[] = [
      null,
      {},
      { ...entry.ack, ok: false },
      { ok: true, outcome: "no_op" },
    ];
    if (
      entry.action === "replan_pre_pg" ||
      entry.action === "replan_after_pg"
    ) {
      malformedValues.push({
        ...entry.ack,
        release_reason: "wrong_release_reason",
      });
    } else {
      malformedValues.push({ ...entry.ack, attempt_id: USER });
    }
    for (const malformed of malformedValues) {
      assert.equal(
        parseAdminRefundAttemptResult(malformed, {
          action: entry.action,
          attemptId: ATTEMPT,
        }),
        null,
        `${entry.action}:${JSON.stringify(malformed)}`,
      );
    }
  }
});

test("external cancellation and issue resolution receipts cannot outrun their exact DB postconditions", () => {
  const resolved = {
    ok: true,
    outcome: "resolved",
    result: {
      economic_qty: 3,
      immediate: 2,
      shortfall: 1,
      live_recovered: 2,
    },
  };
  assert.deepEqual(
    parseExternalCancellationResolutionResult(resolved, 3),
    {
      kind: "resolved",
      result: resolved.result,
    },
  );
  assert.deepEqual(
    parseExternalCancellationResolutionResult(
      { ok: true, outcome: "no_op", idempotent: true },
      null,
    ),
    { kind: "no_op" },
  );
  for (const value of [
    null,
    {},
    { ...resolved, ok: false },
    { ...resolved, result: { ...resolved.result, economic_qty: 4 } },
    { ...resolved, result: { ...resolved.result, shortfall: 2 } },
    { ...resolved, result: { ...resolved.result, live_recovered: 3 } },
    { ok: true, outcome: "no_op" },
  ]) {
    assert.equal(
      parseExternalCancellationResolutionResult(value, 3),
      null,
      JSON.stringify(value),
    );
  }
  const cancellationProof = {
    cancellation_id: CANCELLATION,
    resolution_state: "resolved",
    resolved_economic_qty: 3,
    resolved_at: "2026-07-29T00:00:00Z",
  };
  assert.equal(
    isExternalCancellationResolutionPostcondition(cancellationProof, {
      cancellationId: CANCELLATION,
      economicQty: 3,
    }),
    true,
  );
  for (const mutation of [
    { cancellation_id: "other" },
    { resolution_state: "unmatched" },
    { resolved_economic_qty: 4 },
    { resolved_at: null },
  ]) {
    assert.equal(
      isExternalCancellationResolutionPostcondition(
        { ...cancellationProof, ...mutation },
        { cancellationId: CANCELLATION, economicQty: 3 },
      ),
      false,
    );
  }

  for (const state of ["resolved", "ignored"] as const) {
    assert.equal(
      parseReconciliationIssueResolutionResult(
        { ok: true, outcome: state },
        state,
      ),
      "applied",
    );
    assert.equal(
      parseReconciliationIssueResolutionResult(
        { ok: true, outcome: "no_op", idempotent: true },
        state,
      ),
      "no_op",
    );
    assert.equal(
      parseReconciliationIssueResolutionResult(
        { ok: true, outcome: state === "resolved" ? "ignored" : "resolved" },
        state,
      ),
      null,
    );
    assert.equal(
      isReconciliationIssueResolutionPostcondition(
        {
          id: ISSUE,
          state,
          resolved_at: "2026-07-29T00:00:00Z",
          resolution_source: "admin",
        },
        { issueId: ISSUE, state },
      ),
      true,
    );
    assert.equal(
      isReconciliationIssueResolutionPostcondition(
        {
          id: ISSUE,
          state: state === "resolved" ? "ignored" : "resolved",
          resolved_at: "2026-07-29T00:00:00Z",
          resolution_source: "admin",
        },
        { issueId: ISSUE, state },
      ),
      false,
    );
  }
});

test("admin refund routes wire every success through strict receipt, pagination, and postcondition proof", () => {
  const refundRoute = readFileSync(
    new URL("../../app/api/admin/refund-credits/route.ts", import.meta.url),
    "utf8",
  );
  const issueRoute = readFileSync(
    new URL("../../app/api/admin/resolve-issue/route.ts", import.meta.url),
    "utf8",
  );
  const cancellationRoute = readFileSync(
    new URL(
      "../../app/api/admin/resolve-cancellation/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const expandMigration = readFileSync(
    new URL(
      "../../supabase/migrations/008899_server_read_surface_rollout_gate.sql",
      import.meta.url,
    ),
    "utf8",
  );

  for (const source of [refundRoute, issueRoute, cancellationRoute]) {
    assert.doesNotMatch(source, /data\s*\?\?\s*\{\s*ok:\s*true\s*\}/);
    assert.match(source, /action_unconfirmed/);
    assert.match(source, /status:\s*503/);
  }
  assert.match(refundRoute, /parseAdminRefundBeginResult/);
  assert.match(refundRoute, /proveAdminRefundBegin/);
  assert.match(refundRoute, /parseAdminRefundAttemptResult/);
  assert.match(refundRoute, /isAdminRefundAttemptPostcondition/);
  assert.match(refundRoute, /readSupabaseRowsPaginated/);
  assert.match(refundRoute, /\.range\(offset, offset \+ limit - 1\)/);
  assert.match(issueRoute, /parseReconciliationIssueResolutionResult/);
  assert.match(issueRoute, /isReconciliationIssueResolutionPostcondition/);
  assert.match(
    cancellationRoute,
    /parseExternalCancellationResolutionResult/,
  );
  assert.match(
    cancellationRoute,
    /isExternalCancellationResolutionPostcondition/,
  );
  assert.match(cancellationRoute, /requireSupabaseExactCount/);
  assert.match(
    expandMigration,
    /if p_economic_qty is null[\s\S]*ev\.resolved_economic_qty = p_economic_qty/,
  );
  assert.match(
    expandMigration,
    /create or replace function public\.bp_0084_resolve_external_cancellation_impl/,
  );
  assert.doesNotMatch(
    expandMigration,
    /create or replace function public\.resolve_external_cancellation\(/,
    "0087 must preserve 0084's canonical object→user lock wrapper",
  );
  for (const name of [
    "bp_0084_admin_refund_release_impl",
    "bp_0084_admin_refund_replan_pre_pg_impl",
    "bp_0084_admin_refund_replan_after_pg_impl",
  ]) {
    assert.match(
      expandMigration,
      new RegExp(
        `create or replace function public\\.${name}[\\s\\S]*raise exception 'request_conflict'`,
      ),
    );
  }
  assert.match(
    expandMigration,
    /if i\.state <> 'open'[\s\S]*if i\.state = p_resolution[\s\S]*raise exception 'request_conflict'/,
  );
  assert.match(
    expandMigration,
    /create or replace function public\.bp_0084_admin_resolve_reconciliation_issue_impl/,
  );
  assert.doesNotMatch(
    expandMigration,
    /create or replace function public\.admin_resolve_reconciliation_issue\(/,
  );
});
