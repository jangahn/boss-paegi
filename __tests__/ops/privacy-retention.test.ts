import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  EXTERNAL_COMPLAINT_MANUAL_BOUNDARY,
  COMMERCE_DISPLAY_RETENTION_LIMIT,
  GENERATION_PROVIDER_ACCEPTANCE_RETENTION_LIMIT,
  PRIVACY_RETENTION_LIMIT,
  parseCommerceDisplayRetentionResult,
  parseGenerationProviderAcceptanceRetentionResult,
  parsePrivacyRetentionResult,
  privacyRetentionNeedsRetry,
} from "../../lib/privacy-retention.ts";

function valid() {
  return {
    ok: true,
    processed: 0,
    errors: 0,
    payment_processed: 0,
    payment_errors: 0,
    content_report_processed: 0,
    content_report_errors: 0,
    payment_ready: 0,
    payment_ready_capped: false,
    payment_blocked: 0,
    payment_blocked_capped: false,
    payment_failures: 0,
    payment_failures_capped: false,
    content_report_ready: 0,
    content_report_ready_capped: false,
    content_report_blocked: 0,
    content_report_blocked_capped: false,
    content_report_failures: 0,
    content_report_failures_capped: false,
    content_report_open: 0,
    content_report_open_capped: false,
    consumer_dispute_source_mapped: true,
    consumer_dispute_backlog: 0,
    consumer_dispute_backlog_capped: false,
    legal_blockers: [],
    external_boundaries: [EXTERNAL_COMPLAINT_MANUAL_BOUNDARY],
  };
}

test("privacy retention result parser accepts only the exact bounded contract", () => {
  assert.deepEqual(parsePrivacyRetentionResult(valid()), {
    ok: true,
    processed: 0,
    errors: 0,
    paymentProcessed: 0,
    paymentErrors: 0,
    contentReportProcessed: 0,
    contentReportErrors: 0,
    paymentReady: 0,
    paymentReadyCapped: false,
    paymentBlocked: 0,
    paymentBlockedCapped: false,
    paymentFailures: 0,
    paymentFailuresCapped: false,
    contentReportReady: 0,
    contentReportReadyCapped: false,
    contentReportBlocked: 0,
    contentReportBlockedCapped: false,
    contentReportFailures: 0,
    contentReportFailuresCapped: false,
    contentReportOpen: 0,
    contentReportOpenCapped: false,
    consumerDisputeSourceMapped: true,
    consumerDisputeBacklog: 0,
    consumerDisputeBacklogCapped: false,
    legalBlockers: [],
    externalBoundaries: [EXTERNAL_COMPLAINT_MANUAL_BOUNDARY],
  });

  for (const malformed of [
    null,
    [],
    { ...valid(), extra: true },
    { ...valid(), ok: false },
    { ...valid(), errors: 1 },
    { ...valid(), processed: PRIVACY_RETENTION_LIMIT + 1 },
    {
      ...valid(),
      processed: 1,
      payment_processed: 0,
      content_report_processed: 0,
    },
    {
      ...valid(),
      errors: 1,
      payment_errors: 1,
      content_report_errors: 1,
      ok: false,
    },
    { ...valid(), payment_ready: 1001 },
    { ...valid(), content_report_ready_capped: 1 },
    { ...valid(), consumer_dispute_source_mapped: false },
    { ...valid(), consumer_dispute_backlog: null },
    { ...valid(), legal_blockers: ["permanent_blocker"] },
    { ...valid(), external_boundaries: [] },
    { ...valid(), legal_blockers: ["consumer_dispute_source_unmapped"] },
  ]) {
    assert.equal(parsePrivacyRetentionResult(malformed), null);
  }
  assert.ok(
    parsePrivacyRetentionResult({
      ...valid(),
      ok: false,
      errors: 1,
      content_report_errors: 1,
    }),
  );
});

test("every finite batch edge and durable blocked/failure queue retries visibly", () => {
  const parsed = parsePrivacyRetentionResult(valid());
  assert.ok(parsed);
  assert.equal(privacyRetentionNeedsRetry(parsed), false);

  for (const patch of [
    {
      processed: PRIVACY_RETENTION_LIMIT,
      content_report_processed: PRIVACY_RETENTION_LIMIT,
    },
    { payment_ready: 1 },
    { payment_ready_capped: true },
    { payment_blocked: 1 },
    { payment_blocked_capped: true },
    { payment_failures: 1 },
    { payment_failures_capped: true },
    { content_report_ready: 1, consumer_dispute_backlog: 1 },
    { content_report_ready_capped: true },
    { content_report_blocked: 1, consumer_dispute_backlog: 1 },
    { content_report_blocked_capped: true },
    { content_report_failures: 1 },
    { content_report_failures_capped: true },
  ]) {
    const candidate = parsePrivacyRetentionResult({ ...valid(), ...patch });
    assert.ok(candidate);
    assert.equal(privacyRetentionNeedsRetry(candidate), true);
  }
});

test("commerce display evidence prune result is exact and bounded", () => {
  assert.deepEqual(
    parseCommerceDisplayRetentionResult({
      ok: true,
      processed: 100,
      has_more: true,
    }),
    { processed: 100, hasMore: true },
  );
  for (const malformed of [
    null,
    [],
    { ok: true, processed: 0, has_more: false, extra: true },
    { ok: false, processed: 0, has_more: false },
    {
      ok: true,
      processed: COMMERCE_DISPLAY_RETENTION_LIMIT + 1,
      has_more: false,
    },
    { ok: true, processed: 0, has_more: 0 },
  ]) {
    assert.equal(parseCommerceDisplayRetentionResult(malformed), null);
  }
});

test("generation provider acceptance prune result is exact and bounded", () => {
  assert.deepEqual(
    parseGenerationProviderAcceptanceRetentionResult({
      ok: true,
      processed: 100,
      has_more: true,
    }),
    { processed: 100, hasMore: true },
  );
  for (const malformed of [
    null,
    [],
    { ok: true, processed: 0, has_more: false, extra: true },
    { ok: false, processed: 0, has_more: false },
    {
      ok: true,
      processed:
        GENERATION_PROVIDER_ACCEPTANCE_RETENTION_LIMIT + 1,
      has_more: false,
    },
    { ok: true, processed: 0, has_more: 0 },
  ]) {
    assert.equal(
      parseGenerationProviderAcceptanceRetentionResult(malformed),
      null,
    );
  }
});

test("ops route authenticates before RPC and never turns backlog into 2xx", () => {
  const route = readFileSync(
    new URL("../../app/api/ops/privacy-maintain/route.ts", import.meta.url),
    "utf8",
  );
  assert.ok(
    route.indexOf("cronSecretMatches") <
      route.indexOf('.rpc("maintain_privacy_retention"'),
  );
  assert.ok(
    route.indexOf('.rpc("maintain_privacy_retention"') <
      route.indexOf('.rpc("prune_commerce_display_evidence"'),
  );
  assert.ok(
    route.indexOf('.rpc("maintain_privacy_retention"') <
      route.indexOf(
        '.rpc("prune_generation_provider_acceptance_evidence"',
      ),
  );
  assert.match(route, /retryPending \? 429 : 200/);
  assert.match(route, /opsMaintenanceResponseInit\(status\)/);
  assert.match(route, /policyReady: result\.legalBlockers\.length === 0/);
  assert.match(route, /maintenance_time_budget/);
  assert.match(route, /commerceDisplayEvidence\.hasMore/);
  assert.match(route, /generationProviderAcceptanceEvidence\.hasMore/);
});

test("migration maps terminal UGC complaints to immutable three-year retention", () => {
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/008904_privacy_retention_controls.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(migration, /consumer_dispute_source_mapped', true/);
  assert.match(
    migration,
    /external_consumer_complaint_manual_retention_runbook/,
  );
  assert.match(migration, /delete from public\.content_reports/i);
  assert.match(migration, /report_terminal_clock_immutable/);
  assert.match(
    migration,
    /retention_terminal_at >= p_as_of - interval '3 years'/,
  );
  assert.match(migration, /content_report_payload_digest/);
  assert.match(migration, /extensions\.gen_salt\('bf', 10\)/);
  assert.match(migration, /report_id = null/);
  assert.match(
    migration,
    /limit greatest\(p_limit - v_content_report_attempted, 0\)/,
  );
  assert.match(migration, /limit 1001/g);
  assert.match(
    migration,
    /payment_retention_monthly_aggregates[\s\S]*primary key \(month_utc, provider, terminal_status, is_test\)/,
  );
});
