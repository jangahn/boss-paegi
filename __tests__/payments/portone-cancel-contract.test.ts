import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { classifyPortoneCancelResponse } from "../../lib/pay/portone-cancel-contract.ts";

const ATTEMPT_ID = "11111111-1111-4111-8111-111111111111";
const REASON = `BP_REFUND:${ATTEMPT_ID}`;
const EXPECTED = { amount: 2700, reason: REASON };
const BASE = {
  id: "cancel_123",
  status: "SUCCEEDED",
  totalAmount: 2700,
  taxFreeAmount: 0,
  vatAmount: 270,
  reason: REASON,
  requestedAt: "2026-07-29T12:00:00.000Z",
  cancelledAt: "2026-07-29T12:00:01.000Z",
  receiptUrl: "https://receipt.portone.io/cancel_123",
};

test("PortOne cancel 2xx accepts only a request-correlated succeeded/requested receipt", () => {
  assert.deepEqual(
    classifyPortoneCancelResponse({ cancellation: BASE }, EXPECTED),
    {
      kind: "accepted",
      cancellation: {
        id: "cancel_123",
        status: "SUCCEEDED",
        totalAmount: 2700,
        reason: REASON,
        requestedAt: "2026-07-29T12:00:00.000Z",
        cancelledAt: "2026-07-29T12:00:01.000Z",
        receiptUrl: "https://receipt.portone.io/cancel_123",
      },
    },
  );
  assert.deepEqual(
    classifyPortoneCancelResponse(
      {
        cancellation: {
          ...BASE,
          status: "REQUESTED",
          cancelledAt: undefined,
          receiptUrl: undefined,
        },
      },
      EXPECTED,
    ),
    {
      kind: "accepted",
      cancellation: {
        id: "cancel_123",
        status: "REQUESTED",
        totalAmount: 2700,
        reason: REASON,
        requestedAt: "2026-07-29T12:00:00.000Z",
        cancelledAt: null,
        receiptUrl: null,
      },
    },
  );
});

test("a correlated FAILED cancellation is definitive rejection, never pending", () => {
  assert.deepEqual(
    classifyPortoneCancelResponse(
      {
        cancellation: {
          ...BASE,
          status: "FAILED",
          cancelledAt: undefined,
          receiptUrl: undefined,
        },
      },
      EXPECTED,
    ),
    {
      kind: "failed",
      cancellation: {
        id: "cancel_123",
        status: "FAILED",
        totalAmount: 2700,
        reason: REASON,
        requestedAt: "2026-07-29T12:00:00.000Z",
        cancelledAt: null,
        receiptUrl: null,
      },
    },
  );
});

test("malformed, mismatched, unrecognized, and ambiguous 2xx bodies remain uncertain", () => {
  for (const malformed of [
    null,
    {},
    { cancellation: BASE, error: "late_failure" },
    { cancellation: null },
    { cancellation: { ...BASE, status: "UNRECOGNIZED" } },
    { cancellation: { ...BASE, id: "" } },
    { cancellation: { ...BASE, totalAmount: 2699 } },
    { cancellation: { ...BASE, totalAmount: 2700.5 } },
    { cancellation: { ...BASE, taxFreeAmount: -1 } },
    { cancellation: { ...BASE, vatAmount: Number.NaN } },
    { cancellation: { ...BASE, reason: `${REASON}x` } },
    { cancellation: { ...BASE, requestedAt: "not-a-date" } },
    { cancellation: { ...BASE, cancelledAt: "2026-02-30T00:00:00Z" } },
    {
      cancellation: {
        ...BASE,
        receiptUrl: "http://receipt.portone.io/cancel_123",
      },
    },
  ]) {
    assert.deepEqual(
      classifyPortoneCancelResponse(malformed, EXPECTED),
      { kind: "uncertain" },
    );
  }
});

test("refund adapter maps uncertain 2xx to outstanding and FAILED to hard reject", () => {
  const source = readFileSync(
    new URL("../../lib/portone.ts", import.meta.url),
    "utf8",
  );
  const cancel = source.slice(
    source.indexOf("export async function cancelPortonePaymentPartial"),
    source.indexOf("// ── 웹훅 검증"),
  );
  assert.match(cancel, /classifyPortoneCancelResponse\(/);
  assert.match(
    cancel,
    /classified\.kind === "uncertain"[\s\S]*?kind: "outstanding"/,
  );
  assert.match(
    cancel,
    /classified\.kind === "failed"[\s\S]*?kind: "hard_reject"/,
  );
  assert.match(cancel, /const body = \{\s*storeId: args\.storeId,/);
  assert.doesNotMatch(cancel, /status: \(st === "REQUESTED"/);
});
