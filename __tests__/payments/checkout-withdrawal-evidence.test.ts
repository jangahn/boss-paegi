import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CHECKOUT_WITHDRAWAL_CONFIRMATION,
  matchesCheckoutWithdrawalEvidence,
  parseCheckoutRequestBody,
} from "../../lib/pay/withdrawal-evidence.ts";
import {
  creditsOfferEvidenceRecordMatches,
  creditsOfferEvidenceSnapshot,
} from "../../lib/pay/display-evidence.ts";

const requestId = "10000000-0000-4000-8000-000000000001";
const userId = "20000000-0000-4000-8000-000000000002";
const orderUuid = "30000000-0000-4000-8000-000000000003";
const evidenceId = "40000000-0000-4000-8000-000000000004";
const offerEvidenceId = "50000000-0000-4000-8000-000000000005";
const offerSnapshotSha256 = "a".repeat(64);
const product = {
  productId: "credits_10",
  goodname: "캐릭터 생성권 10개",
  price: 3_000,
  credits: 10,
};

function validRequest() {
  return {
    checkoutRequestId: requestId,
    productId: product.productId,
    method: "card",
    expectedMode: "live",
    expectedProduct: product,
    offerEvidenceId,
    offerSnapshotSha256,
    withdrawalConfirmation: {
      confirmed: true,
      copyVersion: CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion,
      statement: CHECKOUT_WITHDRAWAL_CONFIRMATION.statement,
    },
  };
}

test("checkout request requires an exact separate affirmative confirmation", () => {
  assert.deepEqual(parseCheckoutRequestBody(validRequest()), validRequest());
  for (const malformed of [
    null,
    [],
    { ...validRequest(), extra: true },
    {
      ...validRequest(),
      checkoutRequestId: "10000000-0000-1000-8000-000000000001",
    },
    { ...validRequest(), offerSnapshotSha256: "A".repeat(64) },
    {
      ...validRequest(),
      expectedProduct: { ...product, extra: true },
    },
    {
      ...validRequest(),
      withdrawalConfirmation: {
        ...validRequest().withdrawalConfirmation,
        confirmed: false,
      },
    },
    {
      ...validRequest(),
      withdrawalConfirmation: {
        ...validRequest().withdrawalConfirmation,
        copyVersion: "old-copy",
      },
    },
    {
      ...validRequest(),
      withdrawalConfirmation: {
        ...validRequest().withdrawalConfirmation,
        statement: `${CHECKOUT_WITHDRAWAL_CONFIRMATION.statement} `,
      },
    },
    {
      ...validRequest(),
      withdrawalConfirmation: {
        ...validRequest().withdrawalConfirmation,
        extra: true,
      },
    },
  ]) {
    assert.equal(parseCheckoutRequestBody(malformed), null);
  }
});

test("persisted withdrawal evidence must match every immutable checkout fact", () => {
  const expected = {
    evidenceId,
    requestId,
    orderUuid,
    userId,
    product,
    payMode: "live" as const,
    payChannel: "card" as const,
    offerEvidenceId,
    offerSnapshotSha256,
  };
  const row = {
    id: evidenceId,
    request_id: requestId,
    order_uuid: orderUuid,
    user_id: userId,
    product_id: product.productId,
    product_name: product.goodname,
    amount: product.price,
    credits: product.credits,
    pay_mode: "live",
    pay_channel: "card",
    offer_evidence_id: offerEvidenceId,
    offer_snapshot_sha256: offerSnapshotSha256,
    copy_version: CHECKOUT_WITHDRAWAL_CONFIRMATION.copyVersion,
    confirmation_copy: CHECKOUT_WITHDRAWAL_CONFIRMATION.statement,
    confirmed: true,
    accepted_at: "2026-07-30T00:00:00.123456+00:00",
  };
  assert.equal(matchesCheckoutWithdrawalEvidence(row, expected), true);
  for (const mutation of [
    { id: requestId },
    { request_id: evidenceId },
    { order_uuid: evidenceId },
    { user_id: evidenceId },
    { product_id: "credits_20" },
    { product_name: "다른 상품" },
    { amount: 1 },
    { credits: 1 },
    { pay_mode: "test" },
    { pay_channel: "tosspay" },
    { offer_evidence_id: evidenceId },
    { offer_snapshot_sha256: "b".repeat(64) },
    { copy_version: "old" },
    { confirmation_copy: "다른 확인" },
    { confirmed: false },
    { accepted_at: "2026-07-30" },
  ]) {
    assert.equal(
      matchesCheckoutWithdrawalEvidence({ ...row, ...mutation }, expected),
      false,
    );
  }
});

test("offer evidence pins method-label pairs and the complete visible snapshot", () => {
  const snapshot = creditsOfferEvidenceSnapshot({
    products: [product],
    payMode: "live",
    channels: [{ method: "card", label: "카드" }],
  });
  const record = {
    id: offerEvidenceId,
    surface: "credits_offer",
    snapshot,
    snapshot_sha256: offerSnapshotSha256,
  };
  assert.equal(
    creditsOfferEvidenceRecordMatches(record, {
      evidenceId: offerEvidenceId,
      snapshotSha256: offerSnapshotSha256,
      snapshot,
    }),
    true,
  );
  assert.equal(
    creditsOfferEvidenceRecordMatches(
      {
        ...record,
        snapshot: {
          ...snapshot,
          channels: [{ method: "card", label: "신용카드" }],
        },
      },
      {
        evidenceId: offerEvidenceId,
        snapshotSha256: offerSnapshotSha256,
        snapshot,
      },
    ),
    false,
  );
  assert.equal(
    creditsOfferEvidenceRecordMatches(
      { ...record, extra: true },
      {
        evidenceId: offerEvidenceId,
        snapshotSha256: offerSnapshotSha256,
        snapshot,
      },
    ),
    false,
  );
});

test("UI, route, expand RPC and contract cleanup form one fail-closed boundary", () => {
  const root = new URL("../../", import.meta.url);
  const client = readFileSync(
    new URL("app/credits/CreditsClient.tsx", root),
    "utf8",
  );
  const route = readFileSync(
    new URL("app/api/pay/checkout/route.ts", root),
    "utf8",
  );
  const expand = readFileSync(
    new URL(
      "supabase/migrations/008905_legal_commerce_generation_compliance.sql",
      root,
    ),
    "utf8",
  );
  const contract = readFileSync(
    new URL("supabase/migrations/0092_rollout_contract_cleanup.sql", root),
    "utf8",
  );

  const checkbox = client.indexOf('type="checkbox"');
  const confirmation = client.indexOf(
    "CHECKOUT_WITHDRAWAL_CONFIRMATION.statement",
    checkbox,
  );
  const buttonGate = client.indexOf(
    "disabled={!!pending || !withdrawalConfirmed}",
  );
  const request = client.indexOf("withdrawalConfirmation:");
  assert.ok(
    checkbox >= 0 &&
      confirmation > checkbox &&
      buttonGate > confirmation &&
      request >= 0,
  );
  assert.match(client, /useState\(false\)/);
  assert.match(client, /setWithdrawalConfirmed\(false\)/);

  const parse = route.indexOf("parseCheckoutRequestBody(");
  const offerRead = route.indexOf('.from("commerce_display_evidence")');
  const mutation = route.indexOf('"create_or_reuse_pending_order"');
  const evidenceRead = route.indexOf(
    '.from("checkout_withdrawal_acceptance_evidence")',
  );
  const paymentResponse = route.indexOf("return NextResponse.json(response)");
  assert.ok(
    parse >= 0 &&
      parse < offerRead &&
      offerRead < mutation &&
      mutation < evidenceRead &&
      evidenceRead < paymentResponse,
  );
  assert.match(route, /export const maxDuration = 25/);
  assert.match(route, /AbortSignal\.timeout\(\s*CHECKOUT_DEPENDENCY_TIMEOUT_MS/);
  assert.equal(
    (
      route.match(/\.abortSignal\(checkoutSignal\)/g) ?? []
    ).length,
    4,
  );

  assert.match(
    expand,
    /create table public\.checkout_withdrawal_acceptance_evidence/,
  );
  assert.match(
    expand,
    /foreign key \(order_uuid, user_id\)[\s\S]*on delete cascade/,
  );
  assert.match(expand, /confirmed boolean not null check \(confirmed\)/);
  assert.match(expand, /checkout_withdrawal_evidence_immutable/);
  assert.match(
    expand,
    /create or replace function public\.create_or_reuse_pending_order\([\s\S]*p_checkout_request_id uuid[\s\S]*p_withdrawal_confirmed boolean/,
  );
  assert.match(
    expand,
    /bp_008905_create_or_reuse_pending_order_impl[\s\S]*insert into public\.checkout_withdrawal_acceptance_evidence/,
  );
  assert.match(
    contract,
    /drop function public\.create_or_reuse_pending_order\(\s*uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text\s*\)/,
  );
  assert.match(
    contract,
    /create_or_reuse_pending_order\(uuid,uuid,text,integer,integer,text,text,text,boolean,text,text,text,uuid,text,uuid,text,text,text,boolean\)'[\s\S]*'EXECUTE'/,
  );
});
