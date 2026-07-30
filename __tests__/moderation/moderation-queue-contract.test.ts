import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  assertModerationQueueContract,
  MODERATION_REPORT_DETAIL_LIMIT,
  type ModerationQueueContractRow,
} from "../../lib/moderation-queue-contract.ts";

const migration = readFileSync(
  new URL(
    "../../supabase/migrations/0085_admin_mutation_idempotency.sql",
    import.meta.url,
  ),
  "utf8",
);
const legacyMigration = readFileSync(
  new URL(
    "../../supabase/migrations/0038_admin_moderation_queue.sql",
    import.meta.url,
  ),
  "utf8",
);

const report = (
  id: string,
  createdAt: string,
  status = "pending",
) => ({
  id,
  reason: "portrait",
  detail: null,
  contact: null,
  status,
  created_at: createdAt,
});

const base = (): ModerationQueueContractRow => ({
  state: "pending",
  deleted_at: null,
  artifacts_purged_at: null,
  report_count: 2,
  pending_count: 2,
  latest_report_at: "2026-07-30T01:00:00.000Z",
  reports_truncated: false,
  reports: [
    report(
      "ffffffff-ffff-ffff-ffff-ffffffffffff",
      "2026-07-30T01:00:00.000Z",
    ),
    report(
      "00000000-0000-0000-0000-000000000000",
      "2026-07-30T00:00:00.000Z",
    ),
  ],
});

test("moderation queue SQL keeps exact counts and a deterministic latest-N preview", () => {
  assert.equal(MODERATION_REPORT_DETAIL_LIMIT, 100);
  assert.match(migration, /'report_count', p\.report_count/);
  assert.match(migration, /'pending_count', p\.pending_count/);
  assert.match(migration, /'reports_truncated', p\.report_count > 100/);
  assert.match(
    migration,
    /from \(\s*select[\s\S]*?from public\.content_reports r[\s\S]*?order by r\.created_at desc, r\.id desc\s*limit 100\s*\) r/,
  );
  for (const definition of [legacyMigration, migration]) {
    assert.match(
      definition,
      /limit least\(greatest\(coalesce\(p_limit, 10\), 1\), 100\)/,
    );
    assert.match(definition, /'reports_truncated', p\.report_count > 100/);
    assert.match(
      definition,
      /order by r\.created_at desc, r\.id desc[\s\S]*?limit 100/,
    );
  }
});

test("moderation queue contract accepts every coherent lifecycle state", () => {
  assert.doesNotThrow(() => assertModerationQueueContract(base()));

  const dismissed = base();
  Object.assign(dismissed, {
    state: "dismissed",
    report_count: 1,
    pending_count: 0,
    reports: [report(dismissed.reports[0]!.id, dismissed.reports[0]!.created_at, "dismissed")],
  });
  assert.doesNotThrow(() => assertModerationQueueContract(dismissed));

  const hidden = { ...dismissed, state: "hidden", deleted_at: "2026-07-30T02:00:00Z" };
  assert.doesNotThrow(() => assertModerationQueueContract(hidden));

  const purged = {
    ...hidden,
    state: "purged",
    artifacts_purged_at: "2026-07-30T03:00:00Z",
  };
  assert.doesNotThrow(() => assertModerationQueueContract(purged));
});

test("moderation queue contract rejects count, lifecycle, ordering and enum drift", () => {
  const mutations: Array<(row: ModerationQueueContractRow) => void> = [
    (row) => { row.state = "toString"; },
    (row) => { row.pending_count = 3; },
    (row) => { row.reports_truncated = true; },
    (row) => { row.deleted_at = "2026-07-30T02:00:00Z"; },
    (row) => { row.latest_report_at = "2026-07-29T00:00:00Z"; },
    (row) => { row.reports.reverse(); },
    (row) => { row.reports[0]!.reason = "unknown"; },
    (row) => { row.reports[0]!.status = "unknown"; },
    (row) => { row.reports[0]!.detail = "x".repeat(2_001); },
    (row) => { row.reports[0]!.contact = "x".repeat(201); },
  ];
  for (const mutate of mutations) {
    const row = base();
    mutate(row);
    assert.throws(() => assertModerationQueueContract(row));
  }
});

test("moderation queue contract accepts a capped preview only with explicit truncation", () => {
  const reports = Array.from(
    { length: MODERATION_REPORT_DETAIL_LIMIT },
    (_, index) =>
      report(
        `${(MODERATION_REPORT_DETAIL_LIMIT - index)
          .toString(16)
          .padStart(8, "0")}-0000-0000-0000-000000000000`,
        new Date(Date.UTC(2026, 6, 30, 1, 0, 0) - index * 1_000).toISOString(),
      ),
  );
  const row: ModerationQueueContractRow = {
    ...base(),
    report_count: MODERATION_REPORT_DETAIL_LIMIT + 1,
    pending_count: MODERATION_REPORT_DETAIL_LIMIT + 1,
    reports,
    reports_truncated: true,
  };
  assert.doesNotThrow(() => assertModerationQueueContract(row));

  row.reports.push(
    report(
      "00000000-0000-0000-0000-000000000000",
      "2026-07-29T00:00:00.000Z",
    ),
  );
  assert.throws(() => assertModerationQueueContract(row));
});
