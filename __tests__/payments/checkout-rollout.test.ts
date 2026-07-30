import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PAYMENT_ROLLOUT_COMMIT_HEADER,
  PAYMENT_ROLLOUT_PROJECT_HEADER,
  WITHDRAWAL_LIMIT_EVIDENCE_IMPLEMENTED,
  checkoutProductSnapshotMatches,
  checkoutPayModeMatches,
  paymentCheckoutEnabled,
  paymentRolloutIdentityHeaders,
} from "../../lib/pay/checkout-rollout.ts";

test("implemented checkout opens only for the exact rollout sentinel", () => {
  for (const value of [
    undefined,
    null,
    "",
    "0",
    "true",
    "TRUE",
    " 1",
    "1 ",
    1,
    true,
  ]) {
    assert.equal(paymentCheckoutEnabled(value), false);
  }
  assert.equal(WITHDRAWAL_LIMIT_EVIDENCE_IMPLEMENTED, true);
  assert.equal(paymentCheckoutEnabled("1"), true);
});

test("checkout freeze exposes only a complete validated deployment identity", () => {
  const commit = "abcdef0123456789abcdef0123456789abcdef01";
  assert.deepEqual(
    paymentRolloutIdentityHeaders({
      NEXT_PUBLIC_SUPABASE_URL:
        "https://abcdefghijklmnopqrst.supabase.co/",
      VERCEL_GIT_COMMIT_SHA: commit.toUpperCase(),
    }),
    {
      [PAYMENT_ROLLOUT_PROJECT_HEADER]: "abcdefghijklmnopqrst",
      [PAYMENT_ROLLOUT_COMMIT_HEADER]: commit,
    },
  );

  for (const env of [
    {},
    {
      NEXT_PUBLIC_SUPABASE_URL:
        "https://abcdefghijklmnopqrst.supabase.co/",
    },
    {
      NEXT_PUBLIC_SUPABASE_URL:
        "https://abcdefghijklmnopqrst.supabase.co/",
      VERCEL_GIT_COMMIT_SHA: "short",
    },
    {
      NEXT_PUBLIC_SUPABASE_URL:
        "https://abcdefghijklmnopqrst.supabase.co.evil.example/",
      VERCEL_GIT_COMMIT_SHA: commit,
    },
    {
      NEXT_PUBLIC_SUPABASE_URL:
        "https://user@abcdefghijklmnopqrst.supabase.co/",
      VERCEL_GIT_COMMIT_SHA: commit,
    },
    {
      NEXT_PUBLIC_SUPABASE_URL:
        "https://abcdefghijklmnopqrst.supabase.co/path",
      VERCEL_GIT_COMMIT_SHA: commit,
    },
  ]) {
    assert.deepEqual(paymentRolloutIdentityHeaders(env), {});
  }
});

test("route-level freeze runs before auth, reviewer bypass, and order mutation", () => {
  const route = readFileSync(
    new URL("../../app/api/pay/checkout/route.ts", import.meta.url),
    "utf8",
  );
  const handler = route.indexOf("export async function POST");
  const freeze = route.indexOf("if (!paymentCheckoutEnabled())", handler);
  assert.ok(handler >= 0 && freeze > handler);
  assert.ok(
    route.indexOf('"X-Boss-Paegi-Payment-Rollout": "frozen"', freeze) >
      freeze,
  );
  assert.ok(route.indexOf("paymentRolloutIdentityHeaders()", freeze) > freeze);
  for (const laterBoundary of [
    "portoneConfigured()",
    "requireMember()",
    "getReviewerStatus(",
    '"create_or_reuse_pending_order"',
  ]) {
    assert.ok(
      route.indexOf(laterBoundary, handler) > freeze,
      `${laterBoundary} must remain after the route freeze`,
    );
  }
});

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
