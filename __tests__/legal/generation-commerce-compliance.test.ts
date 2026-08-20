import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CREDITS_OFFER_COPY,
  creditsOfferEvidenceSnapshot,
  recordCreditsOfferDisplayEvidence,
} from "../../lib/pay/display-evidence.ts";

const userId = "10000000-0000-4000-8000-000000000001";

test("generation submit boundaries stay member→body→work ordered without extra gates", () => {
  const fal = readFileSync(
    new URL("../../app/api/fal/route.ts", import.meta.url),
    "utf8",
  );
  const falPost = fal.slice(fal.indexOf("export async function POST"));
  const falMember = falPost.indexOf("await requireMember()");
  const falBody = falPost.indexOf("await readGenerationFormData(req)");
  const falProvider = falPost.indexOf("selectProvider(null)");
  assert.ok(
    falMember >= 0 && falMember < falBody && falBody < falProvider,
  );

  const doll = readFileSync(
    new URL("../../app/api/doll/route.ts", import.meta.url),
    "utf8",
  );
  const dollPost = doll.slice(
    doll.indexOf("export async function POST"),
    doll.indexOf("export async function GET"),
  );
  const dollMember = dollPost.indexOf("await requireMember()");
  const dollBody = dollPost.indexOf("await readApiJsonObjectRequest(req)");
  const dollSubmit = dollPost.indexOf("submitDollPickOnce(");
  assert.ok(
    dollMember >= 0 && dollMember < dollBody && dollBody < dollSubmit,
  );
});

test("008905 stores immutable age/flow-down evidence and six-month display evidence", () => {
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/008905_legal_commerce_generation_compliance.sql",
      import.meta.url,
    ),
    "utf8",
  );
  for (const contract of [
    /create or replace function public\.bp_legal_full_notice_valid\(/,
    /create or replace function public\.bp_legal_full_notice_guard\(\)/,
    /new\.version >= 2/,
    /tg_op = 'INSERT'[\s\S]*tg_op = 'UPDATE'/,
    /old\.effective_date is distinct from new\.effective_date/,
    /old\.sections is distinct from new\.sections/,
    /raise exception 'legal_notice_period_too_short'/,
    /create trigger trg_legal_full_notice_guard[\s\S]*before insert or update[\s\S]*public\.legal_documents/,
    /commerce_display_evidence/,
    /snapshot_sha256/,
    /last_displayed_at <[\s\S]*interval '6 months'/,
    /p_limit not between 1 and 100/,
    /grant execute on function public\.record_commerce_display_evidence\(text,jsonb\)[\s\S]*to service_role/,
  ]) {
    assert.match(migration, contract);
  }
  assert.doesNotMatch(
    migration,
    /grant (?:insert|update|delete|all) on table public\.commerce_display_evidence\s+to (?:anon|authenticated|service_role)/i,
  );
  assert.doesNotMatch(migration, /new\.version = 2/);
  assert.doesNotMatch(
    migration,
    /\bm\.withdrawal_generation\b/,
  );
  const withdrawalParam = migration.indexOf("p_checkout_request_id uuid");
  const checkoutBoundaryStart = migration.lastIndexOf(
    "create or replace function public.create_or_reuse_pending_order(",
    withdrawalParam,
  );
  const checkoutBoundaryEnd = migration.indexOf(
    "\nrevoke all on function public.create_or_reuse_pending_order(",
    withdrawalParam,
  );
  assert.ok(withdrawalParam >= 0);
  assert.ok(checkoutBoundaryStart >= 0);
  assert.ok(checkoutBoundaryEnd > checkoutBoundaryStart);
  const checkoutBoundary = migration.slice(
    checkoutBoundaryStart,
    checkoutBoundaryEnd,
  );
  assert.equal(
    checkoutBoundary.match(/pg_catalog\.jsonb_object_keys\(/g)?.length,
    4,
  );
  assert.doesNotMatch(checkoutBoundary, /\bjsonb_object_length\s*\(/);
  assert.match(
    migration,
    /to_regprocedure\([\s\S]*'pg_catalog\.jsonb_object_keys\(jsonb\)'[\s\S]*is null/,
  );
});

test("credits offer evidence pins every rendered economic field and disclosure", async () => {
  const products = [
    {
      productId: "credits_10",
      goodname: "캐릭터 생성권 10개",
      price: 3000,
      credits: 10,
    },
  ];
  const snapshot = creditsOfferEvidenceSnapshot({
    products,
    payMode: "test",
    channels: [{ method: "card", label: "카드" }],
  });
  assert.deepEqual(snapshot, {
    schemaVersion: 1,
    copyVersion: "credits-offer-2026-08-19-v3",
    surface: "credits_offer",
    payMode: "test",
    products: [
      {
        productId: "credits_10",
        goodname: "캐릭터 생성권 10개",
        priceKrwVatIncluded: 3000,
        credits: 10,
      },
    ],
    channels: [{ method: "card", label: "카드" }],
    displayCopy: {
      supply: CREDITS_OFFER_COPY.supply,
      validity: CREDITS_OFFER_COPY.validity,
      refund: CREDITS_OFFER_COPY.refund,
      refundReferencePrefix: CREDITS_OFFER_COPY.refundReferencePrefix,
      termsLinkLabel: CREDITS_OFFER_COPY.termsLinkLabel,
      refundReferenceSuffix: CREDITS_OFFER_COPY.refundReferenceSuffix,
    },
  });
  let captured: unknown = null;
  const result = await recordCreditsOfferDisplayEvidence(
    {
      async rpc(name, args) {
        assert.equal(name, "record_commerce_display_evidence");
        captured = args;
        return {
          data: {
            ok: true,
            evidence_id: userId,
            snapshot_sha256:
              "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            first_displayed_at: "2026-07-30T00:00:00.000Z",
            last_displayed_at: "2026-07-30T00:00:00.000Z",
            retain_until_at_least: "2027-01-30T00:00:00.000Z",
          },
          error: null,
        };
      },
    },
    {
      products,
      payMode: "test",
      channels: [{ method: "card", label: "카드" }],
    },
  );
  assert.deepEqual(captured, {
    p_surface: "credits_offer",
    p_snapshot: snapshot,
  });
  assert.deepEqual(result, {
    evidenceId: userId,
    snapshotSha256:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  });
  assert.throws(
    () =>
      creditsOfferEvidenceSnapshot({
        products: [],
        payMode: "live",
        channels: [{ method: "card", label: "카드" }],
      }),
    /credits_offer_snapshot_invalid/,
  );
});

test("credits page hides every offer if durable display evidence fails", () => {
  const page = readFileSync(
    new URL("../../app/credits/page.tsx", import.meta.url),
    "utf8",
  );
  const evidence = page.indexOf("await recordCreditsOfferDisplayEvidence(");
  const failure = page.indexOf("credits.offer_evidence_write_fail");
  const hidden = page.indexOf("classificationUnavailable", failure);
  const finalRender = page.lastIndexOf("<CreditsClient");
  assert.ok(
    evidence >= 0 &&
      evidence < failure &&
      failure < hidden &&
      hidden < finalRender,
  );
  const client = readFileSync(
    new URL("../../app/credits/CreditsClient.tsx", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(client, /CREDITS_OFFER_COPY\.summary/);
  assert.match(client, /CREDITS_OFFER_COPY\.supply/);
  assert.match(client, /CREDITS_OFFER_COPY\.validity/);
  assert.match(client, /CREDITS_OFFER_COPY\.refund/);
  assert.doesNotMatch(client, /CREDITS_OFFER_COPY\.price/);
});
