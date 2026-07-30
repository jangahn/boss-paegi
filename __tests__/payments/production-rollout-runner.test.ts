import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CANONICAL_BOOTSTRAP_COMMIT,
  CONTRACT_MIGRATIONS,
  EXPAND_MIGRATIONS,
  buildMigrationReceiptCatalog,
  parseRolloutArgs,
  pendingMigrationsForStage,
  runProductionRollout,
  verifyFrozenSurfaces,
} from "../../scripts/qa/apply-production-rollout.mjs";

const SOURCE_COMMIT = "abcdef0123456789abcdef0123456789abcdef01";
const MERGE_COMMIT = "2222222222222222222222222222222222222222";
const SOURCE_TREE = "1111111111111111111111111111111111111111";
const RECEIPTS = await buildMigrationReceiptCatalog(
  SOURCE_COMMIT,
  SOURCE_TREE,
);
const ROLLOUT_ENV = Object.freeze({
  NODE_ENV: "test" as const,
  BOSS_PAEGI_SUPABASE_ACCESS_TOKEN: "management-token",
  BOSS_PAEGI_SUPABASE_PROJECT_REF: "abcdefghijklmnopqrst",
  BOSS_PAEGI_PRODUCTION_ORIGIN: "https://boss-paegi.example",
});

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function rolloutFetchHarness({
  initiallyApplied = [],
  contractReady = true,
  candidateReady = true,
  frozenCommit = CANONICAL_BOOTSTRAP_COMMIT,
  migrationAppCommit = SOURCE_COMMIT,
  receiptOverride = new Map(),
  migrationOutcome = () => "success",
}: {
  initiallyApplied?: string[];
  contractReady?: boolean | (() => boolean);
  candidateReady?: boolean;
  frozenCommit?: string;
  migrationAppCommit?: string;
  receiptOverride?: Map<string, Record<string, unknown>>;
  migrationOutcome?: (
    version: string,
  ) => "success" | "unknown_committed" | "failure";
} = {}) {
  const applied = new Map(
    initiallyApplied.map((version) => {
      const receipt = RECEIPTS.get(version);
      assert.ok(receipt);
      return [
        version,
        receiptOverride.get(version) ?? {
          version,
          migration_hash: receipt.migrationHash,
          manifest_hash: receipt.manifestHash,
          app_commit: receipt.appCommit,
        },
      ];
    }),
  );
  const events: Array<{
    kind: string;
    version?: string;
    surface?: string;
  }> = [];
  const allMigrations = [...EXPAND_MIGRATIONS, ...CONTRACT_MIGRATIONS];

  const fetchImpl = async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = String(input);
    if (
      url.endsWith("/api/pay/checkout") ||
      url.endsWith("/api/fal") ||
      url.endsWith("/api/doll")
    ) {
      const surface = new URL(url).pathname;
      events.push({ kind: "freeze", surface });
      const checkout = surface === "/api/pay/checkout";
      return new Response(
        JSON.stringify({
          error: checkout
            ? "payment_unavailable"
            : "generation_unavailable",
        }),
        {
          status: 503,
          headers: {
            "Content-Type": "application/json",
            [checkout
              ? "X-Boss-Paegi-Payment-Rollout"
              : "X-Boss-Paegi-Generation-Cost-Rollout"]: "frozen",
            "X-Boss-Paegi-Supabase-Project-Ref":
              ROLLOUT_ENV.BOSS_PAEGI_SUPABASE_PROJECT_REF,
            "X-Boss-Paegi-Build-Commit": frozenCommit,
          },
        },
      );
    }

    assert.match(url, /api\.supabase\.com\/v1\/projects\//);
    const payload = JSON.parse(String(init?.body)) as { query?: unknown };
    assert.equal(typeof payload.query, "string");
    const query = payload.query as string;
    const readOnlyQuery = query.startsWith("select");

    if (readOnlyQuery && query.includes(") duplicates")) {
      events.push({ kind: "index-duplicates" });
      return jsonResponse([{ duplicate_users: "0" }]);
    }
    if (readOnlyQuery && query.includes("pg_get_indexdef")) {
      events.push({ kind: "index-catalog" });
      return jsonResponse([
        {
          named_indexes: "1",
          exact_indexes: "1",
          repairable_indexes: "0",
          building_indexes: "0",
        },
      ]);
    }
    if (
      readOnlyQuery &&
      query.includes("from public.schema_migration_journal j")
    ) {
      events.push({ kind: "journal" });
      return jsonResponse(
        [...applied.values()].sort((left, right) =>
          String(left.version).localeCompare(String(right.version)),
        ),
      );
    }
    if (query.includes("as stale_generations")) {
      events.push({ kind: "candidate-inventory" });
      return jsonResponse([
        {
          stale_generations: candidateReady ? "0" : "2",
          stale_candidate_objects: candidateReady ? "0" : "6",
          approved_stale_generations: candidateReady ? "0" : "2",
          unapproved_stale_generations: "0",
          terminal_candidate_objects: "0",
          orphan_candidate_objects: "0",
          noncanonical_candidate_objects: "0",
        },
      ]);
    }
    if (readOnlyQuery && query.includes("as partial_tuples")) {
      events.push({ kind: "contract-inventory" });
      const inventoryReady =
        typeof contractReady === "function"
          ? contractReady()
          : contractReady;
      return jsonResponse([
        {
          partial_tuples: inventoryReady ? "0" : "1",
          incomplete_portone_rows: "0",
          duplicate_users: "0",
          legacy_reactivation_repairs: "0",
          active_auth_email_mismatches: "0",
        },
      ]);
    }

    const version = allMigrations.find((candidate) =>
      query.includes(`values ('${candidate}', '`),
    );
    assert.notEqual(version, undefined, "unexpected management SQL");
    const receipt = RECEIPTS.get(version as string);
    assert.ok(receipt);
    assert.ok(
      query.includes(
        `values ('${version}', '${receipt.migrationHash}', ` +
          `'${receipt.manifestHash}', '${migrationAppCommit}')`,
      ),
      "migration SQL must carry its exact source-bound receipt",
    );
    assert.equal(
      query.includes(`values ('${version}', null, null, null)`),
      false,
    );
    events.push({ kind: "migration", version });
    const outcome = migrationOutcome(version as string);
    if (outcome === "success") {
      applied.set(version as string, {
        version,
        migration_hash: receipt.migrationHash,
        manifest_hash: receipt.manifestHash,
        app_commit: migrationAppCommit,
      });
      return jsonResponse([]);
    }
    if (outcome === "unknown_committed") {
      applied.set(version as string, {
        version,
        migration_hash: receipt.migrationHash,
        manifest_hash: receipt.manifestHash,
        app_commit: migrationAppCommit,
      });
    }
    return jsonResponse([], 500);
  };

  return { applied, events, fetchImpl };
}

test("production rollout CLI is dry-run by default and requires one exact stage", () => {
  assert.deepEqual(parseRolloutArgs(["--stage", "expand"]), {
    ok: true,
    stage: "expand",
    apply: false,
  });
  assert.deepEqual(parseRolloutArgs(["--apply", "--stage", "contract"]), {
    ok: true,
    stage: "contract",
    apply: true,
  });
  assert.deepEqual(parseRolloutArgs(["--stage", "app-postflight"]), {
    ok: true,
    stage: "app-postflight",
    apply: false,
  });
  assert.deepEqual(
    parseRolloutArgs(["--stage", "app-postflight", "--apply"]),
    { ok: false, reason: "postflight_is_read_only" },
  );
  for (const args of [
    [],
    ["--stage"],
    ["--stage", "all"],
    ["--stage", "expand", "--stage", "expand"],
    ["--apply", "--apply", "--stage", "expand"],
    ["--stage", "expand", "--unknown"],
  ]) {
    assert.equal(parseRolloutArgs(args).ok, false);
  }
});

test("rollout inventory is ordered, complete, and has no duplicate receipt key", () => {
  assert.equal(EXPAND_MIGRATIONS.length, 26);
  assert.equal(CONTRACT_MIGRATIONS.length, 3);
  const all = [...EXPAND_MIGRATIONS, ...CONTRACT_MIGRATIONS];
  assert.equal(new Set(all).size, 29);
  assert.equal(all[0].startsWith("0072_"), true);
  assert.equal(
    all.at(-4),
    "008907_atomic_active_event_snapshot",
  );
  assert.equal(all.at(-3)?.startsWith("0090_"), true);
  assert.equal(all.at(-1)?.startsWith("0092_"), true);
  const migrationVersion = (value: string) =>
    value.match(/^[0-9]+/)?.[0] ?? "";
  assert.deepEqual(
    [...all].sort((left, right) => {
      const leftVersion = migrationVersion(left);
      const rightVersion = migrationVersion(right);
      return leftVersion < rightVersion
        ? -1
        : leftVersion > rightVersion
          ? 1
          : 0;
    }),
    all,
    "digit-version order must be 008800 -> 008899 -> 008900 -> 0090",
  );

  for (const version of all) {
    const migration = readFileSync(
      new URL(`../../supabase/migrations/${version}.sql`, import.meta.url),
      "utf8",
    );
    assert.equal((migration.match(/^begin;$/gm) ?? []).length, 1, version);
    assert.equal((migration.match(/^commit;$/gm) ?? []).length, 1, version);
    assert.match(
      migration,
      /^set local lock_timeout = '[1-9][0-9]*(?:ms|s|min)';$/m,
      version,
    );
    assert.match(
      migration,
      /^set local statement_timeout = '[1-9][0-9]*(?:ms|s|min)';$/m,
      version,
    );
    assert.equal(
      (
        migration.match(
          new RegExp(
            `values\\s*\\(\\s*'${version}'\\s*,\\s*null\\s*,\\s*null\\s*,\\s*null\\s*\\)`,
            "g",
          ),
        ) ?? []
      ).length,
      1,
      `${version} must atomically journal completion`,
    );
    assert.equal(
      /create\s+(?:unique\s+)?index\s+concurrently/i.test(
        migration.replace(/^[\t ]*--.*$/gm, ""),
      ),
      false,
      `${version} must not hide a concurrent index in its transaction`,
    );
    const receipt = RECEIPTS.get(version);
    assert.ok(receipt);
    assert.equal(
      receipt.migrationHash,
      createHash("sha256").update(migration).digest("hex"),
      `${version} receipt must hash the canonical unmodified source`,
    );
    assert.equal(receipt.appCommit, SOURCE_COMMIT);
    assert.match(receipt.manifestHash, /^[0-9a-f]{64}$/);
  }
  assert.equal(
    new Set(
      EXPAND_MIGRATIONS.map(
        (version) => RECEIPTS.get(version)?.manifestHash,
      ),
    ).size,
    1,
  );
  assert.equal(
    new Set(
      CONTRACT_MIGRATIONS.map(
        (version) => RECEIPTS.get(version)?.manifestHash,
      ),
    ).size,
    1,
  );
  assert.notEqual(
    RECEIPTS.get(EXPAND_MIGRATIONS[0])?.manifestHash,
    RECEIPTS.get(CONTRACT_MIGRATIONS[0])?.manifestHash,
  );
});

test("journal planning accepts only a contiguous stage prefix", () => {
  assert.deepEqual(
    pendingMigrationsForStage("expand", new Set()),
    { ok: true, pending: [...EXPAND_MIGRATIONS] },
  );
  const firstTwo = new Set(EXPAND_MIGRATIONS.slice(0, 2));
  assert.deepEqual(
    pendingMigrationsForStage("expand", firstTwo),
    { ok: true, pending: [...EXPAND_MIGRATIONS.slice(2)] },
  );
  assert.deepEqual(
    pendingMigrationsForStage(
      "expand",
      new Set([EXPAND_MIGRATIONS[1]]),
    ),
    { ok: false, reason: "migration_journal_noncontiguous" },
  );
  assert.deepEqual(
    pendingMigrationsForStage(
      "expand",
      new Set([CONTRACT_MIGRATIONS[0]]),
    ),
    { ok: false, reason: "contract_already_started" },
  );
  assert.deepEqual(
    pendingMigrationsForStage("contract", new Set()),
    { ok: false, reason: "expand_incomplete" },
  );
  const expanded = new Set(EXPAND_MIGRATIONS);
  assert.deepEqual(
    pendingMigrationsForStage("contract", expanded),
    { ok: true, pending: [...CONTRACT_MIGRATIONS] },
  );
  expanded.add(CONTRACT_MIGRATIONS[1]);
  assert.deepEqual(
    pendingMigrationsForStage("contract", expanded),
    { ok: false, reason: "migration_journal_noncontiguous" },
  );
});

test("production freeze probe binds all three paid routes to one exact project and commit", async () => {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const responseFor = (
    url: string,
    overrides: Record<string, string> = {},
  ) => {
    const path = new URL(url).pathname;
    const checkout = path === "/api/pay/checkout";
    return new Response(
      JSON.stringify({
        error: checkout
          ? "payment_unavailable"
          : "generation_unavailable",
      }),
      {
        status: 503,
        headers: {
          "Content-Type": "application/json",
          [checkout
            ? "X-Boss-Paegi-Payment-Rollout"
            : "X-Boss-Paegi-Generation-Cost-Rollout"]: "frozen",
          "X-Boss-Paegi-Supabase-Project-Ref":
            ROLLOUT_ENV.BOSS_PAEGI_SUPABASE_PROJECT_REF,
          "X-Boss-Paegi-Build-Commit": SOURCE_COMMIT,
          ...overrides,
        },
      },
    );
  };
  const frozen = await verifyFrozenSurfaces({
    origin: "https://boss-paegi.vercel.app",
    expectedProjectRef: ROLLOUT_ENV.BOSS_PAEGI_SUPABASE_PROJECT_REF,
    allowedCommits: new Set([SOURCE_COMMIT]),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return responseFor(String(url));
    },
  });
  assert.equal(frozen, true);
  assert.deepEqual(
    requests.map(({ url }) => new URL(url).pathname).sort(),
    ["/api/doll", "/api/fal", "/api/pay/checkout"],
  );
  for (const request of requests) {
    assert.equal(request.init?.method, "POST");
    assert.equal(request.init?.body, "{}");
    assert.equal(request.init?.redirect, "error");
    assert.equal(
      Object.keys(request.init?.headers ?? {}).some(
        (key) => key.toLowerCase() === "authorization",
      ),
      false,
    );
  }

  const otherAllowedCommit =
    "1234567890abcdef1234567890abcdef12345678";
  assert.equal(
    await verifyFrozenSurfaces({
      expectedProjectRef: ROLLOUT_ENV.BOSS_PAEGI_SUPABASE_PROJECT_REF,
      allowedCommits: new Set([SOURCE_COMMIT, otherAllowedCommit]),
      fetchImpl: async (url) =>
        responseFor(
          String(url),
          String(url).endsWith("/api/doll")
            ? { "X-Boss-Paegi-Build-Commit": otherAllowedCommit }
            : {},
        ),
    }),
    false,
    "the three routes may not come from mixed rolling deployments",
  );
  assert.equal(
    await verifyFrozenSurfaces({
      expectedProjectRef: ROLLOUT_ENV.BOSS_PAEGI_SUPABASE_PROJECT_REF,
      allowedCommits: new Set([SOURCE_COMMIT]),
      fetchImpl: async (url) =>
        String(url).endsWith("/api/fal")
          ? new Response(
              JSON.stringify({ error: "generation_unavailable" }),
              {
                status: 503,
                headers: {
                  "X-Boss-Paegi-Generation-Cost-Rollout": "frozen",
                  "X-Boss-Paegi-Build-Commit": SOURCE_COMMIT,
                },
              },
            )
          : responseFor(String(url)),
    }),
    false,
    "a missing project identity on one route must fail closed",
  );
});

test("0073 is atomic and retry-safe within its expand stage", () => {
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/0073_generation_terminal_state_machine.sql",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(
    migration,
    /create table if not exists public\.generation_artifact_write_leases/,
  );
  assert.match(
    migration,
    /create index if not exists idx_generation_artifact_write_lease_expiry/,
  );
  assert.ok(migration.indexOf("notify pgrst") < migration.indexOf("commit;"));
});

test("local migration applier accepts and orders variable-width digit versions", () => {
  const applier = readFileSync(
    new URL("../../scripts/qa/apply-local-migrations.sh", import.meta.url),
    "utf8",
  );
  assert.match(applier, /\^\[0-9\]\{4,\}\$/);
  assert.match(applier, /ordered_migration_versions=\(\)/);
  assert.match(
    applier,
    /"\$migration_version" < "\$\{ordered_migration_versions\[\$index\]\}"/,
  );
  assert.doesNotMatch(
    applier,
    /for migration_file in supabase\/migrations\/\*\.sql/,
  );
});

test("production rollout dry-run performs every preflight but sends no migration SQL", async () => {
  const harness = rolloutFetchHarness();
  const logs: string[] = [];
  const result = await runProductionRollout({
    stage: "expand",
    env: ROLLOUT_ENV,
    fetchImpl: harness.fetchImpl,
    logger: (line: string) => logs.push(line),
    sourceCommit: SOURCE_COMMIT,
    sourceTree: SOURCE_TREE,
  });

  assert.deepEqual(result, {
    changed: false,
    stage: "expand",
    pending: [...EXPAND_MIGRATIONS],
  });
  assert.deepEqual(
    harness.events.map(({ kind }) => kind),
    [
      "freeze",
      "freeze",
      "freeze",
      "index-duplicates",
      "index-catalog",
      "journal",
      "candidate-inventory",
    ],
  );
  assert.equal(
    harness.events.some(({ kind }) => kind === "migration"),
    false,
  );
  assert.equal(logs.some((line) => line.includes("mode=dry-run")), true);
  assert.equal(
    logs.filter((line) => line.startsWith("pending migration=")).length,
    EXPAND_MIGRATIONS.length,
  );
});

test("contract stage refuses inventory blockers before any migration SQL", async () => {
  const harness = rolloutFetchHarness({
    initiallyApplied: [...EXPAND_MIGRATIONS],
    contractReady: false,
    frozenCommit: SOURCE_COMMIT,
  });

  await assert.rejects(
    runProductionRollout({
      stage: "contract",
      env: ROLLOUT_ENV,
      fetchImpl: harness.fetchImpl,
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
    }),
    /contract_inventory_blocked/,
  );
  assert.deepEqual(
    harness.events.map(({ kind }) => kind),
    [
      "freeze",
      "freeze",
      "freeze",
      "index-duplicates",
      "index-catalog",
      "journal",
      "candidate-inventory",
      "contract-inventory",
    ],
  );
});

test("app postflight requires the source build on all paid routes and zero candidate backlog", async () => {
  const mergeReceipts = await buildMigrationReceiptCatalog(
    MERGE_COMMIT,
    SOURCE_TREE,
  );
  assert.equal(
    mergeReceipts.get(EXPAND_MIGRATIONS[0])?.manifestHash,
    RECEIPTS.get(EXPAND_MIGRATIONS[0])?.manifestHash,
    "merge/squash commit metadata may differ while its source tree stays exact",
  );
  assert.notEqual(
    mergeReceipts.get(EXPAND_MIGRATIONS[0])?.appCommit,
    RECEIPTS.get(EXPAND_MIGRATIONS[0])?.appCommit,
  );
  const healthy = rolloutFetchHarness({
    initiallyApplied: [...EXPAND_MIGRATIONS],
    frozenCommit: MERGE_COMMIT,
  });
  assert.deepEqual(
    await runProductionRollout({
      stage: "app-postflight",
      env: ROLLOUT_ENV,
      fetchImpl: healthy.fetchImpl,
      sourceCommit: MERGE_COMMIT,
      sourceTree: SOURCE_TREE,
    }),
    { changed: false, stage: "app-postflight", pending: [] },
  );
  assert.equal(
    healthy.events.filter(({ kind }) => kind === "freeze").length,
    6,
    "postflight probes all three routes before and after DB inventories",
  );

  const stale = rolloutFetchHarness({
    initiallyApplied: [...EXPAND_MIGRATIONS],
    frozenCommit: MERGE_COMMIT,
    candidateReady: false,
  });
  await assert.rejects(
    runProductionRollout({
      stage: "app-postflight",
      env: ROLLOUT_ENV,
      fetchImpl: stale.fetchImpl,
      sourceCommit: MERGE_COMMIT,
      sourceTree: SOURCE_TREE,
    }),
    /candidate_retention_postcondition_failed/,
  );
  assert.equal(
    stale.events.some(({ kind }) => kind === "migration"),
    false,
  );
});

test("contract refuses stale candidate retention state even when payment evidence is ready", async () => {
  const harness = rolloutFetchHarness({
    initiallyApplied: [...EXPAND_MIGRATIONS],
    frozenCommit: SOURCE_COMMIT,
    candidateReady: false,
  });
  await assert.rejects(
    runProductionRollout({
      stage: "contract",
      env: ROLLOUT_ENV,
      fetchImpl: harness.fetchImpl,
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
    }),
    /candidate_retention_postcondition_failed/,
  );
  assert.equal(
    harness.events.some(({ kind }) => kind === "migration"),
    false,
  );
});

test("an applied journal row with null or drifted source evidence blocks the rollout", async () => {
  const first = EXPAND_MIGRATIONS[0];
  for (const badRow of [
    {
      version: first,
      migration_hash: null,
      manifest_hash: null,
      app_commit: null,
    },
    {
      version: first,
      migration_hash: "0".repeat(64),
      manifest_hash: RECEIPTS.get(first)?.manifestHash,
      app_commit: SOURCE_COMMIT,
    },
  ]) {
    const harness = rolloutFetchHarness({
      initiallyApplied: [first],
      receiptOverride: new Map([[first, badRow]]),
    });
    await assert.rejects(
      runProductionRollout({
        stage: "expand",
        env: ROLLOUT_ENV,
        fetchImpl: harness.fetchImpl,
        sourceCommit: SOURCE_COMMIT,
        sourceTree: SOURCE_TREE,
      }),
      new RegExp(`migration_journal_receipt_mismatch:${first}`),
    );
    assert.equal(
      harness.events.some(({ kind }) => kind === "migration"),
      false,
    );
  }

  const treeDrift = rolloutFetchHarness({
    initiallyApplied: [first],
  });
  await assert.rejects(
    runProductionRollout({
      stage: "expand",
      env: ROLLOUT_ENV,
      fetchImpl: treeDrift.fetchImpl,
      sourceCommit: MERGE_COMMIT,
      sourceTree: "3333333333333333333333333333333333333333",
    }),
    new RegExp(`migration_journal_receipt_mismatch:${first}`),
  );

  const second = EXPAND_MIGRATIONS[1];
  const secondReceipt = RECEIPTS.get(second);
  assert.ok(secondReceipt);
  const mixedCommit = rolloutFetchHarness({
    initiallyApplied: [first, second],
    receiptOverride: new Map([
      [
        second,
        {
          version: second,
          migration_hash: secondReceipt.migrationHash,
          manifest_hash: secondReceipt.manifestHash,
          app_commit: MERGE_COMMIT,
        },
      ],
    ]),
  });
  await assert.rejects(
    runProductionRollout({
      stage: "expand",
      env: ROLLOUT_ENV,
      fetchImpl: mixedCommit.fetchImpl,
      sourceCommit: MERGE_COMMIT,
      sourceTree: SOURCE_TREE,
    }),
    /migration_journal_stage_commit_mismatch:expand/,
  );
});

test("contract records the merge build while accepting an exact-tree expand receipt from the QA branch", async () => {
  const harness = rolloutFetchHarness({
    initiallyApplied: [...EXPAND_MIGRATIONS],
    frozenCommit: MERGE_COMMIT,
    migrationAppCommit: MERGE_COMMIT,
  });
  assert.deepEqual(
    await runProductionRollout({
      stage: "contract",
      apply: true,
      env: ROLLOUT_ENV,
      fetchImpl: harness.fetchImpl,
      sourceCommit: MERGE_COMMIT,
      sourceTree: SOURCE_TREE,
    }),
    { changed: true, stage: "contract", pending: [] },
  );
  assert.equal(
    harness.applied.get(EXPAND_MIGRATIONS[0])?.app_commit,
    SOURCE_COMMIT,
  );
  for (const version of CONTRACT_MIGRATIONS) {
    assert.equal(harness.applied.get(version)?.app_commit, MERGE_COMMIT);
  }
});

test("contract apply cannot report success when a blocker appears after its initial gate", async () => {
  let contractReady = true;
  const harness = rolloutFetchHarness({
    initiallyApplied: [...EXPAND_MIGRATIONS],
    frozenCommit: SOURCE_COMMIT,
    contractReady: () => contractReady,
    migrationOutcome: (version) => {
      if (version === CONTRACT_MIGRATIONS.at(-1)) {
        contractReady = false;
      }
      return "success";
    },
  });

  await assert.rejects(
    runProductionRollout({
      stage: "contract",
      apply: true,
      env: ROLLOUT_ENV,
      fetchImpl: harness.fetchImpl,
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
    }),
    /contract_inventory_postcondition_failed/,
  );
  assert.equal(
    harness.events.filter(({ kind }) => kind === "contract-inventory")
      .length,
    2,
  );
  assert.deepEqual(
    harness.events
      .filter(({ kind }) => kind === "migration")
      .map(({ version }) => version),
    [...CONTRACT_MIGRATIONS],
  );
});

test("unknown migration response converges only through its atomic journal receipt", async () => {
  const lastExpand = EXPAND_MIGRATIONS.at(-1) as string;
  const harness = rolloutFetchHarness({
    initiallyApplied: EXPAND_MIGRATIONS.slice(0, -1),
    migrationOutcome: (version) =>
      version === lastExpand ? "unknown_committed" : "failure",
  });
  const delays: number[] = [];
  const result = await runProductionRollout({
    stage: "expand",
    apply: true,
    env: ROLLOUT_ENV,
    fetchImpl: harness.fetchImpl,
    sourceCommit: SOURCE_COMMIT,
    sourceTree: SOURCE_TREE,
    delayImpl: async (milliseconds: number) => {
      delays.push(milliseconds);
    },
  });

  assert.deepEqual(result, {
    changed: true,
    stage: "expand",
    pending: [],
  });
  assert.equal(harness.applied.has(lastExpand), true);
  assert.deepEqual(
    harness.events.map(({ kind, version }) =>
      version ? `${kind}:${version}` : kind,
    ),
    [
      "freeze",
      "freeze",
      "freeze",
      "index-duplicates",
      "index-catalog",
      "journal",
      "candidate-inventory",
      "freeze",
      "freeze",
      "freeze",
      `migration:${lastExpand}`,
      "journal",
      "journal",
      "freeze",
      "freeze",
      "freeze",
    ],
  );
  assert.deepEqual(delays, []);
});

test("first failed migration stops the stage and never attempts a later file", async () => {
  const firstPending = EXPAND_MIGRATIONS.at(-2) as string;
  const laterPending = EXPAND_MIGRATIONS.at(-1) as string;
  const harness = rolloutFetchHarness({
    initiallyApplied: EXPAND_MIGRATIONS.slice(0, -2),
    migrationOutcome: () => "failure",
  });
  const delays: number[] = [];

  await assert.rejects(
    runProductionRollout({
      stage: "expand",
      apply: true,
      env: ROLLOUT_ENV,
      fetchImpl: harness.fetchImpl,
      sourceCommit: SOURCE_COMMIT,
      sourceTree: SOURCE_TREE,
      delayImpl: async (milliseconds: number) => {
        delays.push(milliseconds);
      },
    }),
    new RegExp(
      `migration_apply_failed:${firstPending}:status=500`,
    ),
  );
  assert.deepEqual(
    harness.events
      .filter(({ kind }) => kind === "migration")
      .map(({ version }) => version),
    [firstPending],
  );
  assert.equal(harness.applied.has(firstPending), false);
  assert.equal(harness.applied.has(laterPending), false);
  assert.deepEqual(delays, [2000, 2000, 2000, 2000]);
});
