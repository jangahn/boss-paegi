import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseAdminRefundAttemptHttpAck,
  parseExternalCancellationHttpAck,
  parseReconciliationIssueHttpAck,
  parseRefundPreviewHttpAck,
  parseRefundProcessHttpAck,
} from "../../lib/pay/refund-http-contract.ts";

const ATTEMPT = "11111111-1111-4111-8111-111111111111";
const ISSUE = "22222222-2222-4222-8222-222222222222";

test("refund preview validates exact financial and time boundaries", () => {
  const value = {
    ok: true,
    plan: {
      qty: 2,
      amount: 1800,
      rateBps: 9000,
      lotAvailable: 3,
      orderRemainingQty: 3,
      remainingCash: 2700,
      paidAt: "2026-07-01T00:00:00Z",
      deadline: "2031-07-01T00:00:00Z",
    },
  };
  assert.deepEqual(parseRefundPreviewHttpAck(value, 2), value.plan);
  for (const malformed of [
    null,
    { ...value, error: "late_failure" },
    { ...value, plan: { ...value.plan, qty: 3 } },
    { ...value, plan: { ...value.plan, amount: 0 } },
    { ...value, plan: { ...value.plan, rateBps: 9500 } },
    { ...value, plan: { ...value.plan, lotAvailable: 1 } },
    { ...value, plan: { ...value.plan, remainingCash: 1799 } },
    { ...value, plan: { ...value.plan, deadline: value.plan.paidAt } },
  ]) {
    assert.equal(parseRefundPreviewHttpAck(malformed, 2), null);
  }
});

test("auto process response is attempt-bound with a closed outcome set", () => {
  const value = {
    ok: true,
    outcome: "processed",
    attemptId: ATTEMPT,
    cancellationId: "portone-cancel-1",
    issuesOpened: 0,
  } as const;
  assert.deepEqual(parseRefundProcessHttpAck(value, ATTEMPT), value);
  for (const malformed of [
    null,
    { ...value, attemptId: ISSUE },
    { ...value, outcome: "success" },
    { ...value, issuesOpened: -1 },
    { ...value, error: "late_failure" },
  ]) {
    assert.equal(parseRefundProcessHttpAck(malformed, ATTEMPT), null);
  }
});

test("manual, issue, and cancellation actions require target-bound receipts", () => {
  assert.equal(
    parseAdminRefundAttemptHttpAck(
      { ok: true, outcome: "released", attempt_id: ATTEMPT },
      { action: "release", attemptId: ATTEMPT },
    ),
    "applied",
  );
  assert.equal(
    parseAdminRefundAttemptHttpAck(
      {
        ok: true,
        outcome: "no_op",
        idempotent: true,
        attempt_id: ATTEMPT,
      },
      { action: "release", attemptId: ATTEMPT },
    ),
    "no_op",
  );
  assert.equal(
    parseAdminRefundAttemptHttpAck(
      { ok: true, outcome: "released", attempt_id: ISSUE },
      { action: "release", attemptId: ATTEMPT },
    ),
    null,
  );

  assert.equal(
    parseReconciliationIssueHttpAck(
      { ok: true, outcome: "resolved", issue_id: ISSUE },
      { issueId: ISSUE, state: "resolved" },
    ),
    "applied",
  );
  assert.equal(
    parseReconciliationIssueHttpAck(
      { ok: true, outcome: "resolved", issue_id: ATTEMPT },
      { issueId: ISSUE, state: "resolved" },
    ),
    null,
  );

  const cancellation = {
    ok: true,
    outcome: "resolved",
    result: {
      economic_qty: 3,
      immediate: 2,
      shortfall: 1,
      live_recovered: 2,
    },
    cancellation_id: "portone-cancel-1",
  };
  assert.equal(
    parseExternalCancellationHttpAck(cancellation, {
      cancellationId: "portone-cancel-1",
      economicQty: 3,
    }),
    "resolved",
  );
  assert.equal(
    parseExternalCancellationHttpAck(
      { ...cancellation, cancellation_id: "other" },
      { cancellationId: "portone-cancel-1", economicQty: 3 },
    ),
    null,
  );
});

test("both refund operator clients validate every successful HTTP body", () => {
  const button = readFileSync(
    new URL("../../components/admin/RefundButton.tsx", import.meta.url),
    "utf8",
  );
  const queue = readFileSync(
    new URL(
      "../../components/admin/RefundQueueActions.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(button, /parseRefundPreviewHttpAck\(/);
  assert.match(button, /parseRefundProcessHttpAck\(/);
  assert.doesNotMatch(button, /if \(ok && body\.plan\)/);
  for (const parser of [
    "parseRefundProcessHttpAck",
    "parseAdminRefundAttemptHttpAck",
    "parseReconciliationIssueHttpAck",
    "parseExternalCancellationHttpAck",
  ]) {
    assert.match(queue, new RegExp(`${parser}\\(`));
  }
  assert.match(
    queue,
    /if \(valid\) \{\s*return \{\s*kind: "confirmed",\s*value: \{ autoOutcome \},/,
  );
  const confirmation = queue.indexOf(
    'if (outcome.kind !== "confirmed")',
  );
  assert.ok(confirmation >= 0);
  assert.ok(queue.indexOf("reset();", confirmation) > confirmation);
});
