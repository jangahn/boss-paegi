import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseCheckoutHttpResponse,
  parseOrderStatusHttpResponse,
} from "../../lib/pay/http-contract.ts";

const ORDER = "11111111-1111-4111-8111-111111111111";
const checkout = {
  orderUuid: ORDER,
  paymentId: ORDER.replaceAll("-", ""),
  orderName: "생성권 3개",
  totalAmount: 1000,
  storeId: "store_boss_paegi",
  currency: "KRW",
  channelKey: "channel-key",
  payMethod: "CARD",
} as const;

test("checkout HTTP contract correlates the payment id and rejects every malformed financial field", () => {
  assert.deepEqual(parseCheckoutHttpResponse(checkout), checkout);
  for (const malformed of [
    null,
    {},
    { ...checkout, orderUuid: "not-a-uuid" },
    { ...checkout, paymentId: "different" },
    { ...checkout, orderName: "" },
    { ...checkout, orderName: " padded " },
    { ...checkout, orderName: "bad\nname" },
    { ...checkout, totalAmount: 0 },
    { ...checkout, totalAmount: 1.5 },
    { ...checkout, storeId: "" },
    { ...checkout, storeId: " padded " },
    { ...checkout, storeId: `store${"\u0000"}id` },
    { ...checkout, currency: "USD" },
    { ...checkout, channelKey: "" },
    { ...checkout, channelKey: "x".repeat(257) },
    { ...checkout, channelKey: "bad\nkey" },
    { ...checkout, payMethod: "TRANSFER" },
  ]) {
    assert.equal(parseCheckoutHttpResponse(malformed), null);
  }
});

test("order-status HTTP contract accepts only complete bounded order snapshots", () => {
  const valid = {
    status: "paid",
    credits: 3,
    amount: 1000,
    productId: "credits_3",
  } as const;
  assert.deepEqual(parseOrderStatusHttpResponse(valid), valid);
  assert.deepEqual(
    parseOrderStatusHttpResponse({ ...valid, status: "paid_review" }),
    { ...valid, status: "paid_review" },
  );
  for (const malformed of [
    null,
    {},
    { ...valid, status: "refunded" },
    { ...valid, status: "manual_review" },
    { ...valid, credits: 0 },
    { ...valid, credits: 1.5 },
    { ...valid, amount: -1 },
    { ...valid, productId: "" },
    { ...valid, productId: " padded " },
  ]) {
    assert.equal(parseOrderStatusHttpResponse(malformed), null);
  }
});

test("payment API and clients share the same strict response parsers", () => {
  const checkoutRoute = readFileSync(
    new URL("../../app/api/pay/checkout/route.ts", import.meta.url),
    "utf8",
  );
  const statusRoute = readFileSync(
    new URL("../../app/api/pay/order-status/route.ts", import.meta.url),
    "utf8",
  );
  const creditsClient = readFileSync(
    new URL("../../app/credits/CreditsClient.tsx", import.meta.url),
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
  assert.match(checkoutRoute, /parseCheckoutHttpResponse\(\{/);
  assert.match(creditsClient, /parseCheckoutHttpResponse\(/);
  assert.match(creditsClient, /storeId,\s*channelKey,\s*paymentId/);
  assert.doesNotMatch(creditsClient, /PUBLIC_ENV\.PORTONE_STORE_ID/);
  assert.doesNotMatch(creditsClient, /if \(!orderUuid \|\| !paymentId/);
  assert.match(statusRoute, /parseOrderStatusHttpResponse\(\{/);
  assert.match(donePage, /pollClientOrderStatus\(order/);
  assert.match(clientPoll, /parseOrderStatusHttpResponse\(/);
  assert.doesNotMatch(donePage, /as \{ status: string; credits: number \}/);
});
