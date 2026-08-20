import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolveOwnedBadgeRead } from "../../lib/badge-owned.ts";
import { resolveOrderHistoryRead } from "../../lib/pay/order-history.ts";
import { SupabaseOperationError } from "../../lib/supabase-operation.ts";
import {
  InvalidProfileReadError,
  parseProfileMember,
  parseProfileSelf,
} from "../../lib/profile-read.ts";

const validOrder = {
  order_uuid: "11111111-1111-4111-8111-111111111111",
  product_id: "credits-10",
  amount: 1000,
  credits: 10,
  status: "paid",
  paid_at: "2026-07-29T00:00:00.000Z",
  error_message: null,
  refunded_credits: 0,
  refunded_amount: 0,
  receipt_url: null,
  created_at: "2026-07-29T00:00:00.000Z",
  pay_channel: "card",
  is_test: false,
};

test("payment history distinguishes authoritative empty from dependency and shape failures", () => {
  assert.deepEqual(
    resolveOrderHistoryRead({ data: [], error: null }),
    [],
  );
  assert.deepEqual(
    resolveOrderHistoryRead({ data: [validOrder], error: null }),
    [validOrder],
  );
  for (const result of [
    { data: null, error: null },
    { data: [], error: new Error("orders unavailable") },
    { data: [{ ...validOrder, amount: "1000" }], error: null },
    { data: [{ ...validOrder, refunded_credits: 11 }], error: null },
    { data: [{ ...validOrder, is_test: "false" }], error: null },
    { data: [{ ...validOrder, status: "mystery" }], error: null },
    { data: [{ ...validOrder, error_message: 3 }], error: null },
    {
      data: [{ ...validOrder, receipt_url: "javascript:alert(1)" }],
      error: null,
    },
    { data: [validOrder, validOrder], error: null },
  ]) {
    assert.throws(
      () => resolveOrderHistoryRead(result),
      SupabaseOperationError,
    );
  }
});

test("owned badges distinguish authoritative empty from auth/data failure and malformed rows", () => {
  assert.deepEqual(
    [...resolveOwnedBadgeRead({ data: [], error: null })],
    [],
  );
  assert.deepEqual(
    [
      ...resolveOwnedBadgeRead({
        data: [{ badge_id: "first-win" }],
        error: null,
      }),
    ],
    ["first-win"],
  );
  for (const result of [
    { data: null, error: null },
    { data: [], error: new Error("badge read failed") },
    { data: [{}], error: null },
    { data: [{ badge_id: 7 }], error: null },
    { data: [{ badge_id: "" }], error: null },
    {
      data: [{ badge_id: "first-win" }, { badge_id: "first-win" }],
      error: null,
    },
    { data: [{ badge_id: " padded " }], error: null },
    { data: [{ badge_id: "x".repeat(41) }], error: null },
  ]) {
    assert.throws(
      () => resolveOwnedBadgeRead(result),
      SupabaseOperationError,
    );
  }
});

test("payment and badge pages render explicit retry UI instead of false-empty state", () => {
  const payments = readFileSync(
    new URL("../../app/account/payments/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(payments, /resolveOrderHistoryRead/);
  assert.match(payments, /결제 내역을 불러오지 못했어요/);
  assert.match(payments, /내역이 없는 것으로 처리하지 않았습니다/);
  assert.doesNotMatch(payments, /error \? \[\]/);

  const badges = readFileSync(
    new URL("../../app/badges/page.tsx", import.meta.url),
    "utf8",
  );
  assert.match(badges, /resolveOwnedBadgeRead/);
  assert.match(badges, /보유 뱃지를 불러오지 못했어요/);
  assert.match(badges, /미보유로 처리하지 않았습니다/);
  assert.doesNotMatch(badges, /setOwned\(new Set\(\)\)/);
});

test("profile rows reject no-row, identity drift, and truthy type confusion", () => {
  const userId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(
    parseProfileSelf(
      {
        id: userId,
        display_name: "테스터",
        avatar_url: null,
      },
      userId,
    ),
    {
      id: userId,
      display_name: "테스터",
      avatar_url: null,
    },
  );
  assert.deepEqual(
    parseProfileMember({ gen_credits: 3, is_admin: false }),
    { gen_credits: 3, is_admin: false },
  );
  for (const invalid of [
    null,
    {},
    { id: "other", display_name: "테스터", avatar_url: null },
    { id: userId, display_name: null, avatar_url: null },
    { id: userId, display_name: "테스터", avatar_url: 7 },
    { id: userId, display_name: " padded ", avatar_url: null },
    { id: userId, display_name: "x".repeat(13), avatar_url: null },
    {
      id: userId,
      display_name: "테스터",
      avatar_url: "javascript:alert(1)",
    },
    {
      id: userId,
      display_name: "테스터",
      avatar_url: `https://example.test/${"x".repeat(2048)}`,
    },
  ]) {
    assert.throws(
      () => parseProfileSelf(invalid, userId),
      InvalidProfileReadError,
    );
  }
  for (const invalid of [
    null,
    {},
    { gen_credits: "3", is_admin: false },
    { gen_credits: -1, is_admin: false },
    { gen_credits: 3.5, is_admin: false },
    { gen_credits: 3, is_admin: "yes" },
  ]) {
    assert.throws(
      () => parseProfileMember(invalid),
      InvalidProfileReadError,
    );
  }

  const profileSource = readFileSync(
    new URL("../../lib/profile.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    profileSource,
    /requireSupabaseData\(\s*"profile\.self"/,
  );
  assert.match(
    profileSource,
    /requireSupabaseOptionalData\(\s*"profile\.member"/,
  );
  assert.match(profileSource, /memberRow === null \? null/);
});
