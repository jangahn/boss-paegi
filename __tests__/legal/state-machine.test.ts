import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { kstDateAt } from "../../lib/legal/kst-boundary.ts";
import {
  parseLegalPublishResult,
  parseLegalSaveResult,
  parseLegalUnpublishResult,
} from "../../lib/legal/mutation-result.ts";
import { LegalOperationIds } from "../../lib/legal/operation-ids.ts";

function source(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
}

const strictVersions = source("lib/legal/strict-versions.ts");
const legalRoute = source("app/api/admin/legal/route.ts");
const legalEditor = source("components/admin/content/LegalDocEditor.tsx");
const migration = source(
  "supabase/migrations/0081_legal_state_machine_idempotency.sql",
);

test("KST legal effective date flips at the exact UTC 15:00 boundary", () => {
  assert.equal(kstDateAt("2026-07-28T14:59:59.999Z"), "2026-07-28");
  assert.equal(kstDateAt("2026-07-28T15:00:00.000Z"), "2026-07-29");
  assert.equal(kstDateAt("2026-07-28T23:59:59.999Z"), "2026-07-29");
  assert.throws(() => kstDateAt("not-an-instant"), /invalid_instant/);
});

test("strict legal auth reads are uncached across an automatic KST-midnight activation", () => {
  assert.doesNotMatch(strictVersions, /unstable_cache/);
  assert.doesNotMatch(strictVersions, /revalidate\s*:/);
  assert.match(strictVersions, /const today = kstDateAt\(\)/);
  assert.match(strictVersions, /\.lte\("effective_date", today\)/);
  assert.match(strictVersions, /\.limit\(1\)[\s\S]*\.maybeSingle\(\)/);
  assert.doesNotMatch(strictVersions, /\.in\("doc_type"/);
  assert.match(strictVersions, /의도적으로 캐시하지 않는다/);
});

test("legal RPC result parsers require complete committed identities", () => {
  const draftId = "11111111-1111-4111-8111-111111111111";
  const publishedId = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(
    parseLegalSaveResult({
      ok: true,
      draft_id: draftId,
      draft_updated_at: "2026-07-29T00:00:00.123456+00:00",
    }),
    {
      ok: true,
      draft_id: draftId,
      draft_updated_at: "2026-07-29T00:00:00.123456+00:00",
    },
  );
  assert.deepEqual(
    parseLegalPublishResult({
      ok: true,
      published_id: publishedId,
      version: 3,
      effective_date: "2026-07-29",
    }),
    {
      ok: true,
      published_id: publishedId,
      version: 3,
      effective_date: "2026-07-29",
    },
  );
  assert.deepEqual(
    parseLegalUnpublishResult({
      ok: true,
      restored_draft: false,
      version: 3,
    }),
    { ok: true, restored_draft: false, version: 3 },
  );

  for (const malformed of [
    null,
    { ok: true },
    {
      ok: true,
      draft_id: draftId,
      draft_updated_at: "not-a-timestamp",
    },
    {
      ok: true,
      published_id: publishedId,
      version: 0,
      effective_date: "2026-07-29",
    },
    {
      ok: true,
      published_id: publishedId,
      version: 1,
      effective_date: "2026-02-31",
    },
  ]) {
    assert.throws(
      () =>
        "draft_id" in (malformed ?? {})
          ? parseLegalSaveResult(malformed)
          : parseLegalPublishResult(malformed),
      /invalid_rpc_response/,
    );
  }
  assert.throws(
    () =>
      parseLegalUnpublishResult({
        ok: true,
        restored_draft: "yes",
        version: 1,
      }),
    /invalid_rpc_response/,
  );
  assert.throws(
    () =>
      parseLegalSaveResult({
        ok: true,
        draft_id: draftId,
        draft_updated_at: "2026-07-29T00:00:00.123456+00:00",
        error: "late_failure",
      }),
    /invalid_rpc_response/,
  );
  assert.match(legalEditor, /parseLegalSaveResult\(raw\)/);
  assert.match(legalEditor, /parseLegalPublishResult\(raw\)/);
  assert.match(legalEditor, /parseLegalUnpublishResult\(raw\)/);
  assert.doesNotMatch(legalEditor, /res\.ok && out\.ok === true/);
});

test("uncertain retries reuse an operation UUID; changed requests do not", () => {
  const ids = [
    "11111111-1111-4111-8111-111111111111",
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ];
  const registry = new LegalOperationIds(() => {
    const next = ids.shift();
    assert.ok(next);
    return next;
  });
  const first = registry.get("save", { title: "one", base: null });
  assert.equal(
    registry.get("save", { title: "one", base: null }),
    first,
    "exact response-loss retry must reuse the receipt key",
  );
  assert.notEqual(
    registry.get("save", { title: "two", base: null }),
    first,
    "an edited payload is a new logical operation",
  );
  const publish = registry.get("publish", { draftId: "draft" });
  assert.equal(
    registry.get("publish", { draftId: "draft" }),
    publish,
    "operation slots are independently retryable",
  );
  registry.clear("publish");
  assert.notEqual(
    registry.get("publish", { draftId: "draft" }),
    publish,
    "a confirmed response retires its operation UUID",
  );
});

test("admin boundary supplies operation IDs and exact CAS identities", () => {
  for (const parameter of [
    "p_operation_id",
    "p_base_updated_at",
    "p_expected_draft_id",
    "p_expected_draft_updated_at",
    "p_expected_reservation_id",
    "p_expected_reservation_version",
  ]) {
    assert.match(legalRoute, new RegExp(parameter));
  }
  assert.match(legalRoute, /version_conflict/);
  assert.match(legalRoute, /request_conflict/);
  assert.match(legalEditor, /"publish-save"/);
  assert.match(legalEditor, /draftBaseUpdatedAt/);
  assert.match(legalEditor, /LegalOperationIds/);
});

test("all legal transitions use the same document lock and receipts use a global operation lock", () => {
  const documentLocks = migration.match(
    /hashtextextended\(\s*'legal:' \|\| p_doc_type,\s*0::bigint\s*\)/g,
  );
  assert.equal(documentLocks?.length, 6);
  assert.match(
    migration,
    /hashtextextended\(\s*'legal-operation:' \|\| p_operation_id::text/,
  );
  assert.match(migration, /raise exception 'request_conflict'/);
  assert.match(migration, /raise exception 'version_conflict'/);
});

test("legal two-session race harness is syntactically valid and wired into CI", () => {
  const raceHarness = source("scripts/qa/test-legal-state-machine-race.sh");
  const result = spawnSync(
    "bash",
    ["-n", "scripts/qa/test-legal-state-machine-race.sh"],
    {
      cwd: new URL("../../", import.meta.url),
      encoding: "utf8",
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(raceHarness, /date \+ 31/);
  assert.match(raceHarness, /date \+ 41/);
  assert.doesNotMatch(raceHarness, /date \+ (?:10|20)/);
  assert.match(source("package.json"), /qa:db:legal-race/);
  assert.match(source(".github/workflows/quality.yml"), /qa:db:legal-race/);
});

test("legal QA fixtures preserve the full-notice and current-authority boundary", () => {
  const currentAuthorityFixtures = [
    source("supabase/tests/account_consent_lifecycle.pgtap.sql"),
    source("supabase/tests/refund_saga.pgtap.sql"),
    source("scripts/qa/test-consent-delete-races.sh"),
  ];
  for (const fixture of currentAuthorityFixtures) {
    assert.doesNotMatch(
      fixture,
      /coalesce\(max\(version\),\s*0\)\s*\+\s*100/,
    );
    assert.match(fixture, /'published',[\s\S]*?\b1\b/);
    assert.match(
      fixture,
      /order by l\.effective_date desc, l\.version desc, l\.id desc/,
    );
  }

  const stateMachineFixture = source(
    "supabase/tests/legal_state_machine_idempotency.pgtap.sql",
  );
  assert.match(stateMachineFixture, /set future_publish[\s\S]*?date \+ 31/);
  assert.doesNotMatch(
    stateMachineFixture,
    /set future_publish[\s\S]*?date \+ 10/,
  );

  const complianceFixture = source(
    "supabase/tests/legal_commerce_generation_compliance.pgtap.sql",
  );
  const materializeAt = complianceFixture.indexOf(
    "create temporary table qa_generation_reacceptance as",
  );
  const verifyAt = complianceFixture.indexOf(
    "from qa_generation_reacceptance q",
  );
  assert.ok(materializeAt >= 0);
  assert.ok(verifyAt > materializeAt);
});

test("legal HTTP error lookup cannot read Object.prototype as a known DB error", () => {
  const route = readFileSync(
    new URL("../../app/api/admin/legal/route.ts", import.meta.url),
    "utf8",
  );
  assert.match(route, /ownRecordValue\(KNOWN_ERRORS, code\)/);
  assert.doesNotMatch(route, /const known = KNOWN_ERRORS\[code\]/);
});
