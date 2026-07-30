import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  isCancelIntentPostcondition,
  isCancelIntentResolvePostcondition,
  isCanceledUnpaidPostcondition,
  isResolvedFullCancellationPostcondition,
  parseAdminCancelOrderResult,
  parseAutoFullCancellationResult,
  parseCancelIntentBeginResult,
  parseCancelIntentResolveResult,
  parseMarkOrderCanceledUnpaidResult,
  parseMarkOrderFailedResult,
  parseMarkPaidAndGrantResult,
  parsePaidOrderPostcondition,
  paidOrderHttpStatus,
} from "../../lib/pay/order-mutation-result.ts";

const ORDER = "11111111-1111-4111-8111-111111111111";
const REQUEST = "22222222-2222-4222-8222-222222222222";
const ATTEMPT = "33333333-3333-4333-8333-333333333333";

test("grant acknowledgement accepts exactly the two boolean values", () => {
  assert.equal(parseMarkPaidAndGrantResult(true), true);
  assert.equal(parseMarkPaidAndGrantResult(false), false);
  for (const value of [
    null,
    undefined,
    0,
    1,
    "",
    "true",
    {},
    [],
    { granted: true },
  ]) {
    assert.equal(parseMarkPaidAndGrantResult(value), null);
  }
});

test("paid postcondition requires durable paid status and an exact timestamp", () => {
  assert.deepEqual(
    parsePaidOrderPostcondition({
      status: "paid",
      paid_at: "2026-07-29T10:20:30.123456+09:00",
      error_message: null,
    }),
    {
      status: "paid",
      paidAt: "2026-07-29T10:20:30.123456+09:00",
      errorMessage: null,
    },
  );
  assert.deepEqual(
    parsePaidOrderPostcondition({
      status: "paid",
      paid_at: "2026-07-29T01:20:30Z",
      error_message: "account_deleted_no_grant",
    }),
    {
      status: "paid",
      paidAt: "2026-07-29T01:20:30Z",
      errorMessage: "account_deleted_no_grant",
    },
  );

  for (const value of [
    null,
    {},
    { status: "pending", paid_at: "2026-07-29T01:20:30Z", error_message: null },
    { status: "paid", paid_at: null, error_message: null },
    { status: "paid", paid_at: "2026-07-29 01:20:30", error_message: null },
    { status: "paid", paid_at: "invalid", error_message: null },
    { status: "paid", paid_at: "2026-07-29T01:20:30Z" },
    { status: "paid", paid_at: "2026-07-29T01:20:30Z", error_message: "" },
    { status: "paid", paid_at: "2026-07-29T01:20:30Z", error_message: 1 },
  ]) {
    assert.equal(parsePaidOrderPostcondition(value), null);
  }
});

test("paid HTTP status claims grant only for an error-free paid postcondition", () => {
  const paidAt = "2026-07-29T01:20:30Z";
  assert.equal(
    paidOrderHttpStatus({
      status: "paid",
      paidAt,
      errorMessage: null,
    }),
    "paid",
  );

  // These are the three deliberate zero-live-credit financial branches. An
  // unknown future marker must fail closed to the same review state.
  for (const errorMessage of [
    "account_deleted_no_grant",
    "late_paid_no_grant",
    "cancel_intent_no_grant",
    "future_paid_marker",
  ]) {
    assert.equal(
      paidOrderHttpStatus({
        status: "paid",
        paidAt,
        errorMessage,
      }),
      "paid_review",
    );
  }
});

test("failed-order acknowledgement accepts only the three complete outcomes", () => {
  assert.deepEqual(
    parseMarkOrderFailedResult({ ok: true, outcome: "failed" }),
    { outcome: "failed" },
  );
  assert.deepEqual(
    parseMarkOrderFailedResult({
      ok: true,
      outcome: "no_op",
      idempotent: true,
    }),
    { outcome: "no_op" },
  );
  assert.deepEqual(
    parseMarkOrderFailedResult({
      ok: true,
      outcome: "skipped",
      status: "paid",
    }),
    { outcome: "skipped", status: "paid" },
  );

  for (const value of [
    null,
    {},
    { ok: false, outcome: "failed" },
    { ok: true },
    { ok: true, outcome: "no_op" },
    { ok: true, outcome: "no_op", idempotent: false },
    { ok: true, outcome: "skipped" },
    { ok: true, outcome: "skipped", status: "refunded" },
    { ok: true, outcome: "unknown" },
  ]) {
    assert.equal(parseMarkOrderFailedResult(value), null);
  }
});

test("cancellation acknowledgements and terminal states are exact", () => {
  assert.deepEqual(
    parseMarkOrderCanceledUnpaidResult({ ok: true, outcome: "canceled" }),
    { outcome: "canceled" },
  );
  assert.deepEqual(
    parseMarkOrderCanceledUnpaidResult({
      ok: true,
      outcome: "no_op",
      idempotent: true,
    }),
    { outcome: "no_op" },
  );
  assert.deepEqual(
    parseMarkOrderCanceledUnpaidResult({
      ok: true,
      outcome: "skipped",
      status: "paid",
    }),
    { outcome: "skipped", status: "paid" },
  );
  for (const value of [
    null,
    {},
    { ok: true, outcome: "no_op" },
    { ok: true, outcome: "skipped" },
    { ok: true, outcome: "skipped", status: "unknown" },
  ]) {
    assert.equal(parseMarkOrderCanceledUnpaidResult(value), null);
  }

  assert.equal(
    isCanceledUnpaidPostcondition({
      status: "canceled",
      canceled_at: "2026-07-29T01:20:30Z",
      paid_at: null,
    }),
    true,
  );
  for (const value of [
    null,
    { status: "pending", canceled_at: "2026-07-29T01:20:30Z", paid_at: null },
    { status: "canceled", canceled_at: null, paid_at: null },
    {
      status: "canceled",
      canceled_at: "2026-07-29T01:20:30Z",
      paid_at: "2026-07-29T01:00:00Z",
    },
  ]) {
    assert.equal(isCanceledUnpaidPostcondition(value), false);
  }
});

test("admin cancel intent requires exact receipts, replay payload, and durable request/attempt correlation", () => {
  assert.equal(
    parseCancelIntentBeginResult({
      ok: true,
      outcome: "intent_recorded",
      order_version: 2,
    }),
    "intent_recorded",
  );
  assert.equal(
    parseCancelIntentBeginResult({
      ok: true,
      outcome: "no_op",
      idempotent: true,
      order_version: 2,
    }),
    "no_op",
  );
  for (const value of [
    null,
    {},
    { ok: true, outcome: "intent_recorded" },
    { ok: true, outcome: "intent_recorded", order_version: 0 },
    { ok: true, outcome: "no_op", order_version: 2 },
  ]) {
    assert.equal(parseCancelIntentBeginResult(value), null);
  }

  const intentRow = {
    order_uuid: ORDER,
    cancel_requested_at: "2026-07-29T00:00:00.000Z",
    cancel_intent_created_at: "2026-07-29T00:00:01.000Z",
    cancel_intent_reason: "customer requested cancellation",
  };
  const intentExpected = {
    orderUuid: ORDER,
    customerRequestedAt: "2026-07-29T09:00:00.000+09:00",
    reason: "customer requested cancellation",
  };
  assert.equal(
    isCancelIntentPostcondition(intentRow, intentExpected),
    true,
  );
  for (const mutation of [
    { order_uuid: REQUEST },
    { cancel_requested_at: "2026-07-29T00:00:01.000Z" },
    { cancel_intent_created_at: null },
    { cancel_intent_reason: "different reason" },
  ]) {
    assert.equal(
      isCancelIntentPostcondition(
        { ...intentRow, ...mutation },
        intentExpected,
      ),
      false,
    );
  }

  const prepared = {
    ok: true,
    outcome: "prepared",
    request_id: REQUEST,
    attempt_id: ATTEMPT,
    qty: 3,
    amount: 2700,
  };
  const replay = {
    ...prepared,
    outcome: "no_op",
    idempotent: true,
  };
  assert.deepEqual(parseCancelIntentResolveResult(prepared, 3), {
    outcome: "prepared",
    requestId: REQUEST,
    attemptId: ATTEMPT,
    qty: 3,
    amount: 2700,
  });
  assert.deepEqual(parseCancelIntentResolveResult(replay, 3), {
    outcome: "no_op",
    requestId: REQUEST,
    attemptId: ATTEMPT,
    qty: 3,
    amount: 2700,
  });
  for (const value of [
    null,
    {},
    { ...prepared, request_id: "invalid" },
    { ...prepared, attempt_id: "invalid" },
    { ...prepared, qty: 2 },
    { ...prepared, amount: 0 },
    { ...replay, idempotent: false },
  ]) {
    assert.equal(parseCancelIntentResolveResult(value, 3), null);
  }

  const requestRow = {
    id: REQUEST,
    origin: "cancel_intent",
    scope_order_uuid: ORDER,
    requested_qty: 3,
    approved_amount: 2700,
    state: "prepared",
  };
  const attemptRow = {
    id: ATTEMPT,
    request_id: REQUEST,
    order_uuid: ORDER,
    sequence: 1,
    qty: 3,
    amount: 2700,
    state: "prepared",
  };
  const proofExpected = {
    orderUuid: ORDER,
    requestId: REQUEST,
    attemptId: ATTEMPT,
    qty: 3,
    amount: 2700,
  };
  assert.equal(
    isCancelIntentResolvePostcondition(
      requestRow,
      attemptRow,
      proofExpected,
    ),
    true,
  );
  for (const [requestMutation, attemptMutation] of [
    [{ state: "building" }, {}],
    [{ origin: "admin_manual" }, {}],
    [{ approved_amount: 2600 }, {}],
    [{}, { id: REQUEST }],
    [{}, { request_id: ATTEMPT }],
    [{}, { amount: 2600 }],
  ]) {
    assert.equal(
      isCancelIntentResolvePostcondition(
        { ...requestRow, ...requestMutation },
        { ...attemptRow, ...attemptMutation },
        proofExpected,
      ),
      false,
    );
  }

  assert.equal(
    parseAdminCancelOrderResult({
      ok: true,
      clawback: 0,
      shortfall: 0,
      before: 10,
      after: 10,
    }),
    true,
  );
  for (const value of [
    null,
    {},
    { ok: true, clawback: 1, shortfall: 0, before: 10, after: 9 },
    { ok: true, clawback: 0, shortfall: 0, before: null, after: null },
    { ok: true, clawback: 0, shortfall: 0, before: 10, after: 9 },
  ]) {
    assert.equal(parseAdminCancelOrderResult(value), false);
  }
});

test("auto-full cancellation distinguishes proven ineligibility from proven resolution", () => {
  const batchId = "33333333-3333-4333-8333-333333333333";
  assert.deepEqual(
    parseAutoFullCancellationResult({ ok: true, outcome: "ineligible" }),
    { outcome: "ineligible" },
  );
  assert.deepEqual(
    parseAutoFullCancellationResult({
      ok: true,
      outcome: "resolved_full",
      batch_id: batchId,
      events: 2,
    }),
    { outcome: "resolved_full", batchId, events: 2 },
  );
  for (const value of [
    null,
    {},
    { ok: false, outcome: "ineligible" },
    { ok: true, outcome: "resolved_full" },
    { ok: true, outcome: "resolved_full", batch_id: batchId, events: 0 },
    { ok: true, outcome: "unknown" },
  ]) {
    assert.equal(parseAutoFullCancellationResult(value), null);
  }

  assert.equal(
    isResolvedFullCancellationPostcondition({
      status: "canceled",
      canceled_at: "2026-07-29T01:20:30Z",
      paid_at: "2026-07-29T01:00:00Z",
      amount: 3000,
      credits: 30,
      refunded_amount: 3000,
      refunded_credits: 30,
    }),
    true,
  );
  for (const value of [
    null,
    {
      status: "paid",
      canceled_at: "2026-07-29T01:20:30Z",
      paid_at: "2026-07-29T01:00:00Z",
      amount: 3000,
      credits: 30,
      refunded_amount: 3000,
      refunded_credits: 30,
    },
    {
      status: "canceled",
      canceled_at: "2026-07-29T01:20:30Z",
      paid_at: "2026-07-29T01:00:00Z",
      amount: 3000,
      credits: 30,
      refunded_amount: 2999,
      refunded_credits: 30,
    },
  ]) {
    assert.equal(isResolvedFullCancellationPostcondition(value), false);
  }
});

test("every payment finalizer validates the RPC ack and durable postcondition", () => {
  const sources = [
    "../../app/api/pay/webhook/route.ts",
    "../../app/api/pay/order-status/route.ts",
    "../../app/api/ops/reconcile/route.ts",
  ].map((relative) => readFileSync(new URL(relative, import.meta.url), "utf8"));

  for (const source of sources) {
    assert.match(source, /parseMarkPaidAndGrantResult/);
    assert.match(source, /parsePaidOrderPostcondition/);
    assert.match(source, /select\("status, paid_at, error_message"\)/);
    assert.match(source, /parseMarkOrderFailedResult/);
    assert.doesNotMatch(source, /\bgranted !== false\b/);
    assert.doesNotMatch(source, /\bok === false\b/);
  }
});

test("polling and reconciliation never report a quarantined paid row as granted", () => {
  const orderStatus = readFileSync(
    new URL("../../app/api/pay/order-status/route.ts", import.meta.url),
    "utf8",
  );
  const donePage = readFileSync(
    new URL("../../app/credits/done/page.tsx", import.meta.url),
    "utf8",
  );
  const clientPoll = readFileSync(
    new URL("../../lib/pay/client-order-status-poll.ts", import.meta.url),
    "utf8",
  );
  const reconcile = readFileSync(
    new URL("../../app/api/ops/reconcile/route.ts", import.meta.url),
    "utf8",
  );

  assert.match(
    orderStatus,
    /payment_id, paid_at, error_message, is_test/,
  );
  assert.match(orderStatus, /paidOrderHttpStatus\(paidState\)/);
  assert.match(donePage, /pollClientOrderStatus\(order/);
  assert.match(clientPoll, /result\.value\.status === "paid_review"/);
  assert.match(clientPoll, /return \{ status: "review" \}/);
  assert.match(donePage, /setState\("review"\)/);
  assert.match(donePage, /중복 결제하지 말고/);

  const reviewBranch = reconcile.indexOf(
    "paidState.errorMessage !== null",
  );
  const grantIncrement = reconcile.indexOf("granted += 1", reviewBranch);
  assert.ok(reviewBranch >= 0);
  assert.ok(grantIncrement > reviewBranch);
  assert.match(
    reconcile.slice(reviewBranch, grantIncrement),
    /manualReview \+= 1/,
  );
  assert.doesNotMatch(
    reconcile.slice(reviewBranch, grantIncrement),
    /granted \+= 1/,
  );
  assert.match(
    reconcile,
    /opsMaintenanceStatus\(\{[\s\S]*operatorPending: openIssues,[\s\S]*\}\)/,
  );
});

test("cancellation orchestrator rejects malformed RPC success and re-proves terminal writes", () => {
  const source = readFileSync(
    new URL("../../lib/refund-saga.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /parseMarkOrderCanceledUnpaidResult\(transition\.data\)/,
  );
  assert.match(source, /canceledResult\.outcome === "skipped"/);
  assert.match(source, /isCanceledUnpaidPostcondition\(current\)/);
  assert.match(source, /parseAutoFullCancellationResult\(resolution\.data\)/);
  assert.match(source, /isResolvedFullCancellationPostcondition\(current\)/);
  assert.doesNotMatch(
    source,
    /res\?\.outcome === "resolved_full"[\s\S]*: \{ outcome: "ineligible" \}/,
  );
});

test("admin cancellation route and expand migration recover every ambiguous mutation behind canonical locks", () => {
  const route = readFileSync(
    new URL("../../app/api/admin/cancel/route.ts", import.meta.url),
    "utf8",
  );
  for (const symbol of [
    "parseCancelIntentBeginResult",
    "isCancelIntentPostcondition",
    "parseCancelIntentResolveResult",
    "isCancelIntentResolvePostcondition",
    "parseAdminCancelOrderResult",
    "isCanceledUnpaidPostcondition",
    "parseMarkPaidAndGrantResult",
    "parsePaidOrderPostcondition",
  ]) {
    assert.match(route, new RegExp(symbol));
  }
  assert.match(route, /action_unconfirmed/);
  assert.match(route, /status:\s*503/);
  assert.match(route, /p_raw:\s*snapshot\.raw/);
  assert.doesNotMatch(
    route,
    /p_raw:\s*\{\s*source:\s*"admin_cancel"/,
  );
  assert.doesNotMatch(route, /const res = data as/);

  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/008899_server_read_surface_rollout_gate.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const name of ["cancel_intent_begin", "cancel_intent_resolve"]) {
    const start = migration.indexOf(
      `create or replace function public.${name}`,
    );
    assert.ok(start >= 0);
    const body = migration.slice(
      start,
      migration.indexOf("$$;", start) + 3,
    );
    const objectLock = body.indexOf("public.bp_mutation_object_lock");
    const userLock = body.indexOf("public.bp_user_mutation_lock");
    const core = body.indexOf(`public.bp_0084_${name}_impl`);
    assert.ok(objectLock >= 0);
    assert.ok(userLock > objectLock);
    assert.ok(core > userLock);
    assert.match(body, /request_conflict/);
  }
  assert.match(
    migration,
    /'outcome', 'no_op'[\s\S]*'request_id', v_request_id[\s\S]*'attempt_id', v_attempt_id/,
  );
});
