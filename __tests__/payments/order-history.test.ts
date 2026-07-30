import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveOrderHistoryRead } from "../../lib/pay/order-history.ts";

const ORDER_ID = "00000000-0000-4000-8000-000000000001";

const row = {
  order_uuid: ORDER_ID,
  product_id: "credits-3",
  amount: 1000,
  credits: 3,
  status: "paid",
  paid_at: "2026-07-30T00:00:00.000Z",
  error_message: null,
  refunded_credits: 0,
  refunded_amount: 0,
  receipt_url: "https://example.test/receipt",
  created_at: "2026-07-29T23:59:00.000Z",
  pay_channel: "card",
  is_test: false,
};

test("payment history preserves every paid no-grant marker", () => {
  assert.deepEqual(resolveOrderHistoryRead({ data: [row], error: null }), [row]);
  for (const marker of [
    "account_deleted_no_grant",
    "late_paid_no_grant",
    "cancel_intent_no_grant",
    "future_no_grant_marker",
  ]) {
    const marked = { ...row, error_message: marker };
    assert.deepEqual(
      resolveOrderHistoryRead({ data: [marked], error: null }),
      [marked],
    );
  }
  for (const error_message of [undefined, "", 3, "x".repeat(501)]) {
    assert.throws(
      () =>
        resolveOrderHistoryRead({
          data: [{ ...row, error_message }],
          error: null,
        }),
      /payments\.orders/,
    );
  }
});

test("payment history UI never describes a quarantined order as granted", () => {
  const page = readFileSync(
    new URL("../../app/account/payments/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(page, /paid_at, error_message, refunded_credits/);
  assert.match(
    page,
    /o\.status === "paid" && o\.error_message !== null[\s\S]*return "지급검토"/,
  );
  assert.match(
    page,
    /label === "지급검토"[\s\S]*크레딧 요청 \$\{r\.credits\}개 · 지급 검토 중/,
  );
});
