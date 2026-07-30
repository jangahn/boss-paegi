import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyPortoneEvidenceForRollout,
  classifyPortoneNonMoneyEvidence,
  exactPortoneEvidenceFailure,
  portoneEvidenceMismatch,
} from "../../lib/pay/payment-evidence.ts";
import type { PortonePaymentSnapshot } from "../../lib/portone.ts";

const paymentId = "11111111111141118111111111111111";
const snapshot: PortonePaymentSnapshot = {
  paymentId,
  status: "PAID",
  totalAmount: 3000,
  cancelledAmount: 0,
  cancellableAmount: 3000,
  cancellations: [],
  channelType: "LIVE",
  channelKey: "channel_live_card",
  currency: "KRW",
  storeId: "store_boss_paegi",
  raw: {},
};
const order = {
  payment_id: paymentId,
  amount: 3000,
  is_test: false,
  expected_store_id: "store_boss_paegi",
  expected_currency: "KRW",
  expected_channel_key: "channel_live_card",
} as const;

test("PortOne automatic money evidence matches only the exact checkout snapshot", () => {
  assert.equal(portoneEvidenceMismatch(snapshot, order), null);

  const mutations = [
    [{ paymentId: "other" }, "payment_id"],
    [{ totalAmount: 3001 }, "amount"],
    [{ storeId: "other" }, "store_id"],
    [{ channelKey: "other" }, "channel_key"],
    [{ channelType: "TEST" }, "channel_mode"],
  ] as const;
  for (const [mutation, expected] of mutations) {
    assert.equal(
      portoneEvidenceMismatch({ ...snapshot, ...mutation }, order),
      expected,
    );
  }
  assert.equal(
    portoneEvidenceMismatch(snapshot, {
      ...order,
      expected_currency: "USD",
    }),
    "currency",
  );
});

test("missing legacy order evidence always fails closed", () => {
  for (const field of [
    "payment_id",
    "expected_store_id",
    "expected_currency",
    "expected_channel_key",
  ] as const) {
    assert.notEqual(
      portoneEvidenceMismatch(snapshot, { ...order, [field]: null }),
      null,
    );
  }
});

test("only a complete legacy NULL tuple is identified for fail-closed expand deferral", () => {
  const legacyOrder = {
    ...order,
    expected_store_id: null,
    expected_currency: null,
    expected_channel_key: null,
  };
  assert.deepEqual(
    classifyPortoneEvidenceForRollout(snapshot, legacyOrder),
    { kind: "legacy_deferred" },
  );

  for (const field of [
    "expected_store_id",
    "expected_currency",
    "expected_channel_key",
  ] as const) {
    assert.equal(
      classifyPortoneEvidenceForRollout(snapshot, {
        ...order,
        [field]: null,
      }).kind,
      "mismatch",
    );
  }

  const baseMutations = [
    [{ paymentId: "other" }, "payment_id"],
    [{ totalAmount: 3001 }, "amount"],
    [{ currency: null }, "currency"],
    [{ channelType: "TEST" }, "channel_mode"],
  ] as const;
  for (const [mutation, reason] of baseMutations) {
    assert.deepEqual(
      classifyPortoneEvidenceForRollout(
        { ...snapshot, ...mutation },
        legacyOrder,
      ),
      { kind: "mismatch", reason },
    );
  }
});

test("refund and cancellation boundaries require exact evidence even during expand", () => {
  assert.equal(exactPortoneEvidenceFailure(snapshot, order), null);
  assert.equal(
    exactPortoneEvidenceFailure(snapshot, {
      ...order,
      expected_store_id: null,
      expected_currency: null,
      expected_channel_key: null,
    }),
    "legacy_snapshot",
  );
  assert.equal(
    exactPortoneEvidenceFailure(
      { ...snapshot, channelKey: "other" },
      order,
    ),
    "channel_key",
  );
});

test("non-money status transitions require exact store identity and verify optional channel evidence", () => {
  const failed = { ...snapshot, status: "FAILED" as const };
  assert.deepEqual(classifyPortoneNonMoneyEvidence(failed, order), {
    kind: "exact",
  });
  assert.deepEqual(
    classifyPortoneNonMoneyEvidence(
      { ...failed, channelKey: null, channelType: null },
      order,
    ),
    { kind: "exact" },
  );
  assert.deepEqual(
    classifyPortoneNonMoneyEvidence({ ...failed, storeId: "other" }, order),
    { kind: "mismatch", reason: "store_id" },
  );
  assert.deepEqual(
    classifyPortoneNonMoneyEvidence({ ...failed, channelKey: "other" }, order),
    { kind: "mismatch", reason: "channel_key" },
  );
  assert.deepEqual(
    classifyPortoneNonMoneyEvidence({ ...failed, storeId: null }, order),
    { kind: "incomplete" },
  );
  assert.deepEqual(
    classifyPortoneNonMoneyEvidence(failed, {
      ...order,
      expected_store_id: null,
      expected_currency: null,
      expected_channel_key: null,
    }),
    { kind: "legacy_deferred" },
  );
});

test("cancellation and refund app paths prove exact evidence before ingest or PG mutation", () => {
  const sagaSource = readFileSync(
    new URL("../../lib/refund-saga.ts", import.meta.url),
    "utf8",
  );
  const cancelRoute = readFileSync(
    new URL("../../app/api/admin/cancel/route.ts", import.meta.url),
    "utf8",
  );
  const refundRoute = readFileSync(
    new URL("../../app/api/admin/refund-credits/route.ts", import.meta.url),
    "utf8",
  );

  const observedStart = sagaSource.indexOf(
    "export async function handleObservedCancellation(",
  );
  const observedEnd = sagaSource.indexOf(
    "\nasync function loadAttempt(",
    observedStart,
  );
  const observed = sagaSource.slice(observedStart, observedEnd);
  assert.ok(observedStart >= 0 && observedEnd > observedStart);
  const observedEvidence = observed.indexOf("exactPortoneEvidenceFailure(");
  const observedIngest = observed.indexOf("ingestObservedCancellations(");
  assert.ok(observedEvidence >= 0);
  assert.ok(observedIngest > observedEvidence);

  const autoStart = sagaSource.indexOf(
    "export async function processAttemptAuto(",
  );
  const autoEnd = sagaSource.indexOf(
    "\nasync function executePgPost(",
    autoStart,
  );
  const auto = sagaSource.slice(autoStart, autoEnd);
  assert.ok(autoStart >= 0 && autoEnd > autoStart);
  const refundEvidence = auto.indexOf("exactPortoneEvidenceFailure(");
  const refundIngest = auto.indexOf("ingestObservedCancellations(");
  const refundMark = auto.indexOf('"admin_refund_mark_pg_requested"');
  const refundPost = auto.indexOf("executePgPost(");
  assert.ok(refundEvidence >= 0);
  assert.ok(refundIngest > refundEvidence);
  assert.ok(refundMark > refundEvidence);
  assert.ok(refundPost > refundEvidence);

  const cancelSnapshot = cancelRoute.indexOf(
    "const snapshot = snapRes.snapshot;",
  );
  const cancelEvidence = cancelRoute.indexOf(
    "exactPortoneEvidenceFailure(",
    cancelSnapshot,
  );
  const cancelSwitch = cancelRoute.indexOf(
    "switch (snapshot.status)",
    cancelSnapshot,
  );
  const cancelGrant = cancelRoute.indexOf(
    "finalizeGrant(admin, order, snapshot)",
    cancelSnapshot,
  );
  assert.ok(cancelSnapshot >= 0);
  assert.ok(cancelEvidence > cancelSnapshot);
  assert.ok(cancelSwitch > cancelEvidence);
  assert.ok(cancelGrant > cancelEvidence);
  assert.match(
    cancelRoute,
    /evidenceFailure === "legacy_snapshot"[\s\S]*payment_evidence_incomplete[\s\S]*payment_evidence_mismatch[\s\S]*evidenceFailure === "legacy_snapshot" \? 503 : 409/,
  );
  assert.match(
    cancelRoute,
    /handleObservedCancellation\([\s\S]*expected_store_id: order\.expected_store_id[\s\S]*expected_currency: order\.expected_currency[\s\S]*expected_channel_key: order\.expected_channel_key/,
  );
  assert.match(
    cancelRoute,
    /admin\.rpc\("mark_paid_and_grant"[\s\S]*p_raw: snapshot\.raw/,
  );
  assert.match(refundRoute, /processAttemptAuto\(admin, attemptId\)/);
  assert.match(
    refundRoute,
    /exactPortoneEvidenceFailure\([\s\S]*return \{ snapshot: snapRes\.snapshot \}/,
  );
});

test("all-NULL legacy evidence cannot reach any app money-grant RPC", () => {
  const webhook = readFileSync(
    new URL("../../app/api/pay/webhook/route.ts", import.meta.url),
    "utf8",
  );
  const orderStatus = readFileSync(
    new URL("../../app/api/pay/order-status/route.ts", import.meta.url),
    "utf8",
  );
  const reconcile = readFileSync(
    new URL("../../app/api/ops/reconcile/route.ts", import.meta.url),
    "utf8",
  );
  const settle = readFileSync(
    new URL("../../app/api/admin/settle/route.ts", import.meta.url),
    "utf8",
  );

  for (const [name, source, guard, rpc] of [
    [
      "webhook",
      webhook,
      'if (evidence.kind === "legacy_deferred")',
      'admin.rpc("mark_paid_and_grant"',
    ],
    [
      "order-status",
      orderStatus,
      'if (evidence?.kind === "legacy_deferred")',
      'admin.rpc("mark_paid_and_grant"',
    ],
    [
      "settle",
      settle,
      'if (evidence.kind === "legacy_deferred")',
      'admin.rpc("admin_settle_stuck_order_verified"',
    ],
  ] as const) {
    const guardIndex = source.indexOf(guard);
    const rpcIndex = source.indexOf(rpc, guardIndex);
    assert.ok(guardIndex >= 0, `${name}: missing legacy guard`);
    assert.ok(rpcIndex > guardIndex, `${name}: missing downstream grant RPC`);
    const guardedPrefix = source.slice(guardIndex, rpcIndex);
    assert.match(guardedPrefix, /payment_evidence_incomplete/);
    assert.match(guardedPrefix, /return NextResponse\.json\(/);
    assert.match(guardedPrefix, /status: 503/);
  }

  const reconcileGuard = reconcile.indexOf(
    'if (evidence?.kind === "legacy_deferred")',
  );
  const reconcileGrantMatch =
    /admin\s*\.rpc\("mark_paid_and_grant"/g.exec(
      reconcile.slice(reconcileGuard),
    );
  const reconcileGrant =
    reconcileGrantMatch === null
      ? -1
      : reconcileGuard + reconcileGrantMatch.index;
  assert.ok(reconcileGuard >= 0);
  assert.ok(reconcileGrant > reconcileGuard);
  const reconcilePrefix = reconcile.slice(reconcileGuard, reconcileGrant);
  assert.match(reconcilePrefix, /unresolved\.push\(row\.order_uuid\)/);
  assert.match(reconcilePrefix, /continue;/);
});
