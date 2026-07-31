import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
  isGenerationProviderAcceptanceRequest,
  parseGenerationProviderAcceptanceAck,
  parseGenerationProviderAcceptanceHttpAck,
  parseGenerationProviderAcceptanceStatus,
} from "../../lib/generation-provider-acceptance.ts";
import {
  CREDITS_OFFER_COPY,
  creditsOfferEvidenceSnapshot,
  recordCreditsOfferDisplayEvidence,
} from "../../lib/pay/display-evidence.ts";

const userId = "10000000-0000-4000-8000-000000000001";
const requestId = "20000000-0000-4000-8000-000000000002";

test("generation flow-down request requires three separate affirmative facts", () => {
  const valid = {
    requestId,
    adultSelfAttested: true,
    falTermsAccepted: true,
    falAupAccepted: true,
  };
  assert.equal(isGenerationProviderAcceptanceRequest(valid), true);
  for (const invalid of [
    null,
    [],
    {},
    { ...valid, requestId: "invalid" },
    { ...valid, adultSelfAttested: false },
    { ...valid, falTermsAccepted: false },
    { ...valid, falAupAccepted: false },
    { ...valid, extra: true },
  ]) {
    assert.equal(isGenerationProviderAcceptanceRequest(invalid), false);
  }
});

test("generation acceptance RPC payloads are parsed fail-closed", () => {
  assert.deepEqual(
    parseGenerationProviderAcceptanceStatus({
      ok: true,
      eligible: false,
      bundle_version: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
      accepted_at: null,
    }),
    {
      eligible: false,
      bundleVersion: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
      acceptedAt: null,
    },
  );
  assert.deepEqual(
    parseGenerationProviderAcceptanceAck({
      ok: true,
      eligible: true,
      evidence_id: userId,
      bundle_version: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
      accepted_at: "2026-07-30T00:00:00.000Z",
      idempotent: false,
    }),
    {
      evidenceId: userId,
      bundleVersion: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
      acceptedAt: "2026-07-30T00:00:00.000Z",
      idempotent: false,
    },
  );
  for (const invalid of [
    null,
    { ok: false },
    {
      ok: true,
      eligible: true,
      bundle_version: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
      accepted_at: null,
    },
    {
      ok: true,
      eligible: false,
      bundle_version: "old",
      accepted_at: null,
    },
    {
      ok: true,
      eligible: false,
      bundle_version: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
      accepted_at: null,
      extra: true,
    },
    {
      ok: true,
      eligible: true,
      bundle_version: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
      accepted_at: "2026-02-30T00:00:00Z",
    },
  ]) {
    assert.throws(
      () => parseGenerationProviderAcceptanceStatus(invalid),
      /generation_provider_acceptance_response_invalid/,
    );
  }
});

test("generation acceptance HTTP acknowledgement is exact and request-correlated", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  const valid = {
    ok: true,
    eligible: true,
    requestId,
    bundleVersion: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
    acceptedAt: "2026-07-30T00:00:00.000Z",
  };
  assert.deepEqual(
    parseGenerationProviderAcceptanceHttpAck(valid, requestId),
    {
      requestId,
      bundleVersion: GENERATION_PROVIDER_ACCEPTANCE_BUNDLE,
      acceptedAt: valid.acceptedAt,
    },
  );
  for (const invalid of [
    { ...valid, requestId: "22222222-2222-4222-8222-222222222222" },
    { ...valid, bundleVersion: "old" },
    { ...valid, acceptedAt: "2026-07-30" },
    { ...valid, extra: true },
  ]) {
    assert.throws(
      () =>
        parseGenerationProviderAcceptanceHttpAck(invalid, requestId),
      /generation_provider_acceptance_response_invalid/,
    );
  }
});

test("generation submit boundaries stay member→body→work ordered without extra gates", () => {
  const fal = readFileSync(
    new URL("../../app/api/fal/route.ts", import.meta.url),
    "utf8",
  );
  const falPost = fal.slice(fal.indexOf("export async function POST"));
  const falMember = falPost.indexOf("await requireMember()");
  const falBody = falPost.indexOf("await readGenerationFormData(req)");
  const falProvider = falPost.indexOf("selectProvider(null)");
  // 2026-07-31 product decision: provider acceptance is a recordable ledger,
  // not an enforcement gate, so the route must not block on it.
  assert.equal(
    falPost.indexOf("await readGenerationProviderAcceptance("),
    -1,
  );
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
  assert.equal(
    dollPost.indexOf("await readGenerationProviderAcceptance("),
    -1,
  );
  assert.ok(
    dollMember >= 0 && dollMember < dollBody && dollBody < dollSubmit,
  );
});

test("generate page and acceptance API are independently fail-closed", () => {
  const layout = readFileSync(
    new URL("../../app/generate/layout.tsx", import.meta.url),
    "utf8",
  );
  const layoutMember = layout.indexOf("await requireMember()");
  assert.equal(
    layout.indexOf("await readGenerationProviderAcceptance("),
    -1,
  );
  assert.ok(layoutMember >= 0);

  const route = readFileSync(
    new URL(
      "../../app/api/account/generation-provider-acceptance/route.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const member = route.indexOf("await requireMember()");
  const body = route.indexOf("await readApiJsonObjectRequest(req)");
  const rpc = route.indexOf('"record_generation_provider_acceptance"');
  assert.ok(member >= 0 && member < body && body < rpc);
  assert.match(route, /p_adult_self_attested: true/);
  assert.match(route, /p_fal_terms_accepted: true/);
  assert.match(route, /p_fal_aup_accepted: true/);
  assert.match(route, /requestId: requestBody\.value\.requestId/);
  assert.match(route, /\.abortSignal\(AbortSignal\.timeout\(15_000\)\)/);

  const client = readFileSync(
    new URL(
      "../../components/generate/GenerationProviderAcceptanceGate.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(client, /const requestBody = JSON\.stringify/);
  assert.match(
    client,
    /runClientMutation\(\{[\s\S]*attempt: deliver,[\s\S]*reconcile: deliver/,
  );
  assert.match(
    client,
    /parseGenerationProviderAcceptanceHttpAck\(body, requestId\)/,
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
    /generation_provider_acceptance_evidence/,
    /adult_age_threshold smallint not null default 19/,
    /adult_self_attested boolean not null check \(adult_self_attested\)/,
    /fal_terms_accepted boolean not null check \(fal_terms_accepted\)/,
    /fal_aup_accepted boolean not null check \(fal_aup_accepted\)/,
    /withdrawal_generation bigint not null/,
    /unique \(user_id, bundle_version, withdrawal_generation\)/,
    /service_terms_version integer not null/,
    /service_privacy_version integer not null/,
    /before update or delete[\s\S]*generation_provider_acceptance_evidence/,
    /record_generation_provider_acceptance/,
    /generation_provider_acceptance_status/,
    /p\.withdrawal_generation/,
    /effective_date <= v_today/,
    /coalesce\(v_member\.terms_version, 0\) < v_current_terms/,
    /coalesce\(v_member\.privacy_version, 0\) < v_current_privacy/,
    /on conflict \(request_id\) do nothing[\s\S]*raise exception 'request_conflict'/,
    /prune_generation_provider_acceptance_evidence/,
    /accepted_at < clock_timestamp\(\) - interval '5 years'/,
    /commerce_display_evidence/,
    /snapshot_sha256/,
    /last_displayed_at <[\s\S]*interval '6 months'/,
    /p_limit not between 1 and 100/,
    /grant execute on function public\.record_commerce_display_evidence\(text,jsonb\)[\s\S]*to service_role/,
  ]) {
    assert.match(migration, contract);
  }
  assert.match(
    migration,
    new RegExp(GENERATION_PROVIDER_ACCEPTANCE_BUNDLE),
  );
  assert.doesNotMatch(
    migration,
    /grant (?:insert|update|delete|all) on table public\.generation_provider_acceptance_evidence\s+to (?:anon|authenticated|service_role)/i,
  );
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
    copyVersion: "credits-offer-2026-07-30-v1",
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
      summary: CREDITS_OFFER_COPY.summary,
      supply: CREDITS_OFFER_COPY.supply,
      validity: CREDITS_OFFER_COPY.validity,
      refund: CREDITS_OFFER_COPY.refund,
      refundReferencePrefix: CREDITS_OFFER_COPY.refundReferencePrefix,
      termsLinkLabel: CREDITS_OFFER_COPY.termsLinkLabel,
      refundReferenceSuffix: CREDITS_OFFER_COPY.refundReferenceSuffix,
      price: CREDITS_OFFER_COPY.price,
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
  assert.match(client, /CREDITS_OFFER_COPY\.summary/);
  assert.match(client, /CREDITS_OFFER_COPY\.supply/);
  assert.match(client, /CREDITS_OFFER_COPY\.validity/);
  assert.match(client, /CREDITS_OFFER_COPY\.refund/);
  assert.match(client, /CREDITS_OFFER_COPY\.price/);
});
