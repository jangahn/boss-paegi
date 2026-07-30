import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  PAYMENT_ROLLOUT_COMMIT_HEADER,
  PAYMENT_ROLLOUT_PROJECT_HEADER,
  paymentCheckoutEnabled,
  paymentRolloutIdentityHeaders,
} from "../../lib/pay/checkout-rollout.ts";

test("checkout rollout gate only accepts the exact enabled sentinel", () => {
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
    route.indexOf(
      '"X-Boss-Paegi-Payment-Rollout": "frozen"',
      freeze,
    ) > freeze,
  );
  assert.ok(route.indexOf("paymentRolloutIdentityHeaders()", freeze) > freeze);
  for (const laterBoundary of [
    "portoneConfigured()",
    "requireMember()",
    "isReviewerUser(",
    'admin.rpc("create_pending_order"',
  ]) {
    assert.ok(
      route.indexOf(laterBoundary, handler) > freeze,
      `${laterBoundary} must remain after the route freeze`,
    );
  }
});
