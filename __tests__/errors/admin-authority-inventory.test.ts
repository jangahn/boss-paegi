import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseAdminRpcPage,
  parseAdminWindowTotal,
  requireExactAdminIdCoverage,
  validateAdminRows,
} from "../../lib/admin-read-contract.ts";
import {
  listStorageObjectsPaginated,
  requireSupabasePage,
  SupabaseOperationError,
} from "../../lib/supabase-operation.ts";

const ID_A = "11111111-1111-4111-8111-111111111111";
const ID_B = "22222222-2222-4222-8222-222222222222";

function source(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
}

test("admin row contracts accept authoritative emptiness but reject malformed success payloads", () => {
  assert.deepEqual(
    validateAdminRows("rows", [], {
      id: "uuid",
      count: "nonnegativeInteger",
    }),
    [],
  );
  assert.deepEqual(
    validateAdminRows("rows", [{ id: ID_A, count: 0 }], {
      id: "uuid",
      count: "nonnegativeInteger",
    }),
    [{ id: ID_A, count: 0 }],
  );

  for (const value of [
    null,
    {},
    "rows",
    [{ id: ID_A }],
    [{ id: "not-a-uuid", count: 0 }],
    [{ id: ID_A, count: -1 }],
    [{ id: ID_A, count: 1.5 }],
  ]) {
    assert.throws(
      () =>
        validateAdminRows("rows", value, {
          id: "uuid",
          count: "nonnegativeInteger",
        }),
      SupabaseOperationError,
    );
  }
});

test("date and timestamp contracts reject calendar normalization and ambiguous strings", () => {
  assert.deepEqual(
    validateAdminRows("dates", [
      {
        day: "2024-02-29",
        at: "2026-07-29T00:00:00.123456+09:00",
      },
    ], {
      day: "date",
      at: "timestamp",
    }),
    [
      {
        day: "2024-02-29",
        at: "2026-07-29T00:00:00.123456+09:00",
      },
    ],
  );
  for (const value of [
    { day: "2023-02-29", at: "2026-07-29T00:00:00Z" },
    { day: "2026-02-30", at: "2026-07-29T00:00:00Z" },
    { day: "2026-07-29", at: "2026-07-29 00:00:00" },
    { day: "2026-07-29", at: "2026-07-29T24:00:00Z" },
    { day: "2026-07-29", at: "Wed, 29 Jul 2026 00:00:00 GMT" },
  ]) {
    assert.throws(
      () =>
        validateAdminRows("dates", [value], {
          day: "date",
          at: "timestamp",
        }),
      SupabaseOperationError,
    );
  }
});

test("nullable booleans accept only the exact SQL boolean domain", () => {
  assert.deepEqual(
    validateAdminRows("nullable-boolean", [
      { value: null },
      { value: false },
      { value: true },
    ], {
      value: "nullableBoolean",
    }),
    [{ value: null }, { value: false }, { value: true }],
  );
  for (const value of [0, 1, "", "false", undefined]) {
    assert.throws(
      () =>
        validateAdminRows("nullable-boolean", [{ value }], {
          value: "nullableBoolean",
        }),
      SupabaseOperationError,
    );
  }
});

test("admin RPC pages reject null, malformed totals, and totals smaller than the page", () => {
  const schema = { id: "uuid" } as const;
  assert.deepEqual(parseAdminRpcPage("page", { rows: [], total: 0 }, schema), {
    rows: [],
    total: 0,
  });
  assert.deepEqual(
    parseAdminRpcPage("page", { rows: [{ id: ID_A }], total: 2 }, schema),
    { rows: [{ id: ID_A }], total: 2 },
  );

  for (const value of [
    null,
    [],
    { rows: null, total: 0 },
    { rows: [], total: null },
    { rows: [], total: -1 },
    { rows: [], total: 1.5 },
    { rows: [{ id: ID_A }], total: 0 },
    { rows: [{ id: "bad" }], total: 1 },
  ]) {
    assert.throws(
      () => parseAdminRpcPage("page", value, schema),
      SupabaseOperationError,
    );
  }
});

test("window totals are exact, consistent, safe nonnegative integers", () => {
  assert.equal(parseAdminWindowTotal("window", []), 0);
  assert.equal(
    parseAdminWindowTotal("window", [
      { total_count: 2 },
      { total_count: "2" },
    ]),
    2,
  );

  for (const rows of [
    [{ total_count: null }],
    [{ total_count: -1 }],
    [{ total_count: 1.5 }],
    [{ total_count: "NaN" }],
    [{ total_count: 2 }, { total_count: 3 }],
    [{ total_count: 0 }, { total_count: 0 }],
  ]) {
    assert.throws(
      () => parseAdminWindowTotal("window", rows),
      SupabaseOperationError,
    );
  }
});

test("same-table enrichment requires one exact acknowledgement per requested id", () => {
  assert.doesNotThrow(() =>
    requireExactAdminIdCoverage("coverage", [], []),
  );
  assert.doesNotThrow(() =>
    requireExactAdminIdCoverage("coverage", [ID_A, ID_B], [ID_B, ID_A]),
  );

  for (const [expected, actual] of [
    [[ID_A], []],
    [[ID_A], [ID_B]],
    [[ID_A], [ID_A, ID_B]],
    [[ID_A, ID_A], [ID_A]],
    [[ID_A], [ID_A, ID_A]],
  ] as const) {
    assert.throws(
      () => requireExactAdminIdCoverage("coverage", expected, actual),
      SupabaseOperationError,
    );
  }
});

test("a successful Storage list must acknowledge an array, never null-as-empty", async () => {
  await assert.rejects(
    listStorageObjectsPaginated("storage.list", async () => ({
      data: null,
      error: null,
    })),
    (error) =>
      error instanceof SupabaseOperationError &&
      error.operation === "storage.list",
  );
});

test("exact Supabase pages reject totals smaller than the returned page", async () => {
  await assert.rejects(
    requireSupabasePage("page", async () => ({
      data: [{ id: ID_A }],
      count: 0,
      error: null,
    })),
    SupabaseOperationError,
  );
});

test("every admin authority reader has strict dependency and runtime-shape contracts", () => {
  const inventory = {
    "lib/admin-acquisition.ts": [
      "readSupabaseRowsPaginated",
      "validateAdminRows",
    ],
    "lib/admin-analytics.ts": [
      "readSupabaseRowsPaginated",
      "requireSupabaseRows",
      "requireSupabaseOptionalData",
      "validateAdminRows",
    ],
    "lib/admin-data.ts": [
      "requireSupabaseData",
      "requireSupabaseRows",
      "validateAdminRows",
      "requireExactAdminIdCoverage",
    ],
    "lib/admin-generations.ts": [
      "requireSupabasePage",
      "requireSupabaseRows",
      "requireSupabaseOptionalData",
      "validateAdminRows",
      "requireExactAdminIdCoverage",
    ],
    "lib/admin-integrity.ts": [
      "requireSupabasePage",
      "requireSupabaseRows",
      "requireSupabaseOptionalData",
      "validateAdminRows",
    ],
    "lib/admin-ledger.ts": ["requireSupabasePage", "validateAdminRows"],
    "lib/admin-moderation.ts": [
      "requireSupabaseData",
      "parseAdminRpcPage",
      "validateAdminRows",
    ],
    "lib/admin-orders.ts": [
      "requireSupabaseRows",
      "validateAdminRows",
      "parseAdminWindowTotal",
      "requireExactAdminIdCoverage",
    ],
    "lib/admin-users.ts": [
      "requireSupabasePage",
      "requireSupabaseRows",
      "requireSupabaseOptionalData",
      "validateAdminRows",
      "parseAdminWindowTotal",
    ],
  } as const;

  for (const [file, required] of Object.entries(inventory)) {
    const text = source(file);
    assert.match(text, /\.(?:from|rpc)\(/, `${file}: no authority read found`);
    for (const contract of required) {
      assert.match(text, new RegExp(`\\b${contract}\\b`), `${file}: ${contract}`);
    }
    assert.doesNotMatch(text, /\bdata\s*\?\?\s*\[\]/, `${file}: null became []`);
    assert.doesNotMatch(text, /\bcount\s*\?\?\s*0\b/, `${file}: null became 0`);
    assert.doesNotMatch(
      text,
      /\.catch\(\s*\(\s*\)\s*=>\s*\[\]\s*\)/,
      `${file}: rejection became []`,
    );
    assert.doesNotMatch(
      text,
      /\.then\(\s*\([^)]*\)\s*=>\s*[^;\n]*\.data\b/,
      `${file}: resolved error bypass`,
    );
  }
});

test("admin page-local reviewer reads are paginated and shape checked", () => {
  const page = source("app/admin/reviewers/page.tsx");
  assert.match(page, /readSupabaseRowsPaginated/);
  assert.match(page, /\.order\("created_at"/);
  assert.match(page, /\.order\("user_id"/);
  assert.match(page, /\.range\(offset, offset \+ limit - 1\)/);
  assert.match(page, /validateAdminRows<ReviewerRow>/);
  assert.match(page, /validateAdminRows<ReviewerJobRow>/);
  assert.match(page, /nullableBoolean/);
});

test("public OG readers distinguish authoritative absence from dependency failure", () => {
  const dollOg = source("app/doll/[id]/opengraph-image.tsx");
  const scoreOg = source("app/share/[scoreId]/opengraph-image.tsx");

  assert.match(dollOg, /requireSupabaseOptionalData/);
  assert.match(dollOg, /\.maybeSingle\(\)/);
  assert.match(dollOg, /validateAdminRows/);
  assert.doesNotMatch(dollOg, /og\.doll_query_fail/);
  assert.doesNotMatch(dollOg, /catch\s*\{[\s\S]{0,100}return null/);

  assert.match(scoreOg, /await fetchScoreDetail\(scoreId\)/);
  assert.doesNotMatch(scoreOg, /og\.score_query_fail/);
  assert.doesNotMatch(
    scoreOg,
    /catch[\s\S]{0,160}boss-default/,
  );
});

test("remaining server authority lists never collapse null or partial reads to empty/zero", () => {
  const inventory = {
    "app/api/doll/route.ts": ["requireSupabaseRows", "validateAdminRows"],
    "app/api/doll/signed-urls/route.ts": [
      "requireSupabaseRows",
      "validateAdminRows",
    ],
    "app/api/ops/reconcile/route.ts": ["validateAdminRows"],
    "app/api/score/route.ts": [
      "requireSupabaseData",
      "requireSupabaseRows",
      "requireSupabaseExactCount",
    ],
    "lib/account-delete-cleanup-job.ts": [
      "requireSupabaseRows",
      "validateAdminRows",
    ],
    "lib/refund-saga.ts": ["validateAdminRows"],
    "lib/supabase-operation.ts": ["requireSupabaseRows"],
  } as const;

  for (const [file, contracts] of Object.entries(inventory)) {
    const text = source(file);
    for (const contract of contracts) {
      assert.match(text, new RegExp(`\\b${contract}\\b`), `${file}: ${contract}`);
    }
    assert.doesNotMatch(text, /\bdata\s*\?\?\s*\[\]/, `${file}: null became []`);
    assert.doesNotMatch(text, /\bcount\s*\?\?\s*0\b/, `${file}: null became 0`);
  }
});

test("content/config authority readers validate rows and sitemap outages stay visible", () => {
  const configAudit = source("lib/config/audit.ts");
  const events = source("lib/events/index.ts");
  const legal = source("lib/legal/index.ts");
  const sitemap = source("app/sitemap.ts");

  assert.match(configAudit, /validateAdminRows/);
  assert.match(configAudit, /config\.audit_entry/);
  assert.match(configAudit, /version_missing_or_invalid/);

  assert.match(events, /validateEventRows/);
  assert.match(events, /validateAdminRows\("events\.sitemap"/);
  assert.match(events, /invalid_event_row/);

  assert.match(legal, /validateLegalRows/);
  assert.match(legal, /legalSectionsSchema\.safeParse/);
  assert.match(legal, /multiple_drafts/);

  assert.match(sitemap, /export const dynamic = "force-dynamic"/);
  assert.match(sitemap, /await getSitemapEvents\(\)/);
  assert.doesNotMatch(sitemap, /getSitemapEvents\(\)\.catch\(\(\) => \[\]\)/);
});

test("window-count readers probe total on an out-of-range empty page", () => {
  const orders = source("lib/admin-orders.ts");
  const users = source("lib/admin-users.ts");

  assert.match(orders, /admin\.orders\.search_total_probe/);
  assert.match(orders, /raw\.length > 0 \|\| page === 1/);
  assert.match(users, /admin\.user_generations_total_probe/);
  assert.match(users, /raw\.length > 0 \|\| p === 1/);
});
