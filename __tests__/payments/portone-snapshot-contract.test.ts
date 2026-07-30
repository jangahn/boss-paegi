import assert from "node:assert/strict";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  normalizePortonePayment,
  parsePortonePaymentSnapshot,
} = await import("../../lib/portone.ts");

const PAYMENT_ID = "11111111111141118111111111111111";
const cancellation = {
  status: "SUCCEEDED",
  id: "cancel_1",
  totalAmount: 300,
  taxFreeAmount: 0,
  vatAmount: 27,
  reason: "BP_REFUND:11111111-1111-4111-8111-111111111111",
  requestedAt: "2026-07-29T01:00:00Z",
  cancelledAt: "2026-07-29T01:00:01Z",
  receiptUrl: "https://receipt.portone.io/cancel_1",
} as const;

const paid = {
  status: "PAID",
  id: PAYMENT_ID,
  transactionId: "transaction_1",
  amount: { total: 1000, cancelled: 0 },
  currency: "KRW",
  storeId: "store_boss_paegi",
  channel: { type: "LIVE", key: "channel_live_card" },
  paidAt: "2026-07-29T00:00:00Z",
  receiptUrl: "https://receipt.portone.io/payment_1",
  cancellations: [],
} as const;

test("known money statuses require complete correlated PortOne evidence", () => {
  assert.deepEqual(
    parsePortonePaymentSnapshot(PAYMENT_ID, paid),
    {
      paymentId: PAYMENT_ID,
      status: "PAID",
      totalAmount: 1000,
      cancelledAmount: 0,
      cancellableAmount: 1000,
      cancellations: [],
      channelType: "LIVE",
      channelKey: "channel_live_card",
      currency: "KRW",
      storeId: "store_boss_paegi",
      raw: paid,
    },
  );

  const partial = {
    ...paid,
    status: "PARTIAL_CANCELLED",
    amount: { total: 1000, cancelled: 300 },
    cancellations: [cancellation],
  };
  assert.deepEqual(
    parsePortonePaymentSnapshot(PAYMENT_ID, partial),
    {
      paymentId: PAYMENT_ID,
      status: "PARTIAL_CANCELLED",
      totalAmount: 1000,
      cancelledAmount: 300,
      cancellableAmount: 700,
      cancellations: [
        {
          id: cancellation.id,
          status: cancellation.status,
          totalAmount: cancellation.totalAmount,
          reason: cancellation.reason,
          requestedAt: cancellation.requestedAt,
          cancelledAt: cancellation.cancelledAt,
          receiptUrl: cancellation.receiptUrl,
        },
      ],
      channelType: "LIVE",
      channelKey: "channel_live_card",
      currency: "KRW",
      storeId: "store_boss_paegi",
      raw: partial,
    },
  );
});

test("missing cancelled amount and malformed succeeded amount never become zero", () => {
  const missingAggregate = {
    ...paid,
    status: "PARTIAL_CANCELLED",
    amount: { total: 1000 },
    cancellations: [cancellation],
  };
  const normalized = normalizePortonePayment(
    PAYMENT_ID,
    missingAggregate,
  );
  assert.equal(normalized.cancelledAmount, null);
  assert.equal(normalized.cancellableAmount, null);
  assert.equal(
    parsePortonePaymentSnapshot(PAYMENT_ID, missingAggregate),
    null,
  );

  const missingItemAmount = {
    ...paid,
    status: "PARTIAL_CANCELLED",
    amount: { total: 1000, cancelled: 300 },
    cancellations: [{ ...cancellation, totalAmount: undefined }],
  };
  const normalizedItem = normalizePortonePayment(
    PAYMENT_ID,
    missingItemAmount,
  );
  assert.equal(normalizedItem.cancelledAmount, null);
  assert.equal(normalizedItem.cancellableAmount, null);
  assert.equal(
    parsePortonePaymentSnapshot(PAYMENT_ID, missingItemAmount),
    null,
  );
});

test("all malformed money-moving 2xx projections fail closed", () => {
  const malformed = [
    null,
    [],
    {},
    { ...paid, id: "different" },
    { ...paid, transactionId: "" },
    { ...paid, amount: null },
    { ...paid, amount: { total: 1000 } },
    { ...paid, amount: { total: 1000, cancelled: -1 } },
    { ...paid, amount: { total: 1000, cancelled: 1001 } },
    { ...paid, channel: null },
    { ...paid, channel: { type: "UNKNOWN" } },
    { ...paid, channel: { type: "LIVE" } },
    { ...paid, channel: { type: "LIVE", key: "" } },
    { ...paid, currency: undefined },
    { ...paid, currency: "USD" },
    { ...paid, currency: "krw" },
    { ...paid, storeId: undefined },
    { ...paid, storeId: "" },
    { ...paid, paidAt: "2026-02-30T00:00:00Z" },
    { ...paid, receiptUrl: "http://receipt.portone.io/payment_1" },
    { ...paid, cancellations: null },
    {
      ...paid,
      amount: { total: 1000, cancelled: 300 },
      cancellations: [cancellation],
    },
    {
      ...paid,
      status: "PARTIAL_CANCELLED",
      amount: { total: 1000, cancelled: 300 },
      cancellations: [],
    },
    {
      ...paid,
      status: "PARTIAL_CANCELLED",
      amount: { total: 1000, cancelled: 300 },
      cancellations: [{ ...cancellation, status: "UNKNOWN" }],
    },
    {
      ...paid,
      status: "PARTIAL_CANCELLED",
      amount: { total: 1000, cancelled: 300 },
      cancellations: [{ ...cancellation, id: "" }],
    },
    {
      ...paid,
      status: "PARTIAL_CANCELLED",
      amount: { total: 1000, cancelled: 300 },
      cancellations: [{ ...cancellation, taxFreeAmount: -1 }],
    },
    {
      ...paid,
      status: "PARTIAL_CANCELLED",
      amount: { total: 1000, cancelled: 300 },
      cancellations: [{ ...cancellation, requestedAt: "not-a-date" }],
    },
    {
      ...paid,
      status: "PARTIAL_CANCELLED",
      amount: { total: 1000, cancelled: 300 },
      cancellations: [
        {
          ...cancellation,
          receiptUrl: "https://user:password@receipt.portone.io/cancel_1",
        },
      ],
    },
  ];
  for (const value of malformed) {
    assert.equal(
      parsePortonePaymentSnapshot(PAYMENT_ID, value),
      null,
      JSON.stringify(value),
    );
  }
});

test("unknown future status remains observable but cannot match any mutation branch", () => {
  const future = {
    id: PAYMENT_ID,
    status: "FUTURE_PROVIDER_STATE",
  };
  const parsed = parsePortonePaymentSnapshot(PAYMENT_ID, future);
  assert.equal(parsed?.status, "UNRECOGNIZED");
  assert.equal(parsed?.totalAmount, null);
  assert.equal(parsed?.cancellableAmount, null);
});
