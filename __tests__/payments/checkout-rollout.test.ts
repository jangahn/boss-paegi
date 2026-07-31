import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  checkoutProductSnapshotMatches,
  checkoutPayModeMatches,
} from "../../lib/pay/checkout-rollout.ts";

test("checkout mode fence accepts only the exact TEST/LIVE mode rendered to the user", () => {
  assert.equal(checkoutPayModeMatches("test", "test"), true);
  assert.equal(checkoutPayModeMatches("live", "live"), true);
  for (const [actual, expected] of [
    ["test", "live"],
    ["live", "test"],
    ["live", undefined],
    ["live", null],
    ["live", ""],
    ["live", "LIVE"],
    ["live", true],
  ] as const) {
    assert.equal(checkoutPayModeMatches(actual, expected), false);
  }
});

test("checkout product fence requires every rendered economic field to match", () => {
  const product = {
    productId: "credits_10",
    goodname: "캐릭터 생성권 10개",
    price: 3000,
    credits: 10,
  };
  assert.equal(checkoutProductSnapshotMatches(product, { ...product }), true);
  for (const expected of [
    undefined,
    null,
    [],
    {},
    { ...product, productId: "credits_20" },
    { ...product, goodname: "캐릭터 생성권 20개" },
    { ...product, price: 5500 },
    { ...product, credits: 20 },
    { ...product, price: "3000" },
  ]) {
    assert.equal(checkoutProductSnapshotMatches(product, expected), false);
  }
});

test("checkout reads fresh strict growth config and binds all rendered state before selecting a channel", () => {
  const route = readFileSync(
    new URL("../../app/api/pay/checkout/route.ts", import.meta.url),
    "utf8",
  );
  const handler = route.indexOf("export async function POST");
  const strictRead = route.indexOf("getGrowthLeversStrict()", handler);
  const reviewer = route.indexOf("getReviewerStatus(", strictRead);
  const mode = route.indexOf("const mode = payModeFor", reviewer);
  const modeFence = route.indexOf("checkoutPayModeMatches(mode", mode);
  const productFence = route.indexOf(
    "checkoutProductSnapshotMatches(product",
    modeFence,
  );
  const channels = route.indexOf("paymentChannels(mode)", productFence);
  const mutation = route.indexOf('"create_or_reuse_pending_order"', channels);

  assert.ok(strictRead > handler);
  assert.ok(reviewer > strictRead);
  assert.ok(mode > reviewer);
  assert.ok(modeFence > mode);
  assert.ok(productFence > modeFence);
  assert.ok(channels > productFence);
  assert.ok(mutation > channels);
  assert.match(
    route.slice(strictRead, reviewer),
    /pay\.growth_config_read_fail[\s\S]*payment_unavailable[\s\S]*status: 503/,
  );
  assert.match(
    route.slice(modeFence, channels),
    /checkout_state_changed[\s\S]*status: 409/,
  );
  assert.doesNotMatch(route, /\bgetGrowthLevers\(\)/);

  const client = readFileSync(
    new URL("../../app/credits/CreditsClient.tsx", import.meta.url),
    "utf8",
  );
  assert.match(client, /expectedMode:\s*payMode/);
  assert.match(client, /expectedProduct:\s*product/);
});
