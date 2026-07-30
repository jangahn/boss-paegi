import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  OPS_MAINTENANCE_ROUTE_BUDGET_MS,
  boundedBatchMayHaveMore,
  createOpsMaintenanceDeadline,
  opsMaintenanceDeadlineReached,
  opsMaintenanceResponseInit,
  opsMaintenanceStatus,
  opsMaintenanceTimeRemaining,
  runOpsMaintenanceWithDeadline,
} from "../../lib/ops-maintenance-status.ts";
import {
  advanceChronologicalCursor,
  chronologicalKeysetFilter,
  compareChronologicalKey,
  isAfterChronologicalCursor,
} from "../../lib/ops-keyset-pagination.ts";
import {
  DOLL_SIGNED_URL_QUOTA_DAILY_ROW_CEILING,
  PUBLIC_WRITE_QUOTA_DAILY_ROW_CEILING,
  PUBLIC_WRITE_ATTEMPT_DAILY_ROW_CEILING,
  PUBLIC_WRITE_QUOTA_PRUNE_BATCH_LIMIT,
  PUBLIC_WRITE_QUOTA_PRUNE_CAPACITY,
  PUBLIC_WRITE_QUOTA_PRUNE_MAX_BATCHES,
  PUBLIC_WRITE_QUOTA_PRUNE_TIME_BUDGET_MS,
  REPORT_QUOTA_DAILY_ROW_CEILING,
  REPORT_ATTEMPT_DAILY_ROW_CEILING,
  SCORE_QUOTA_DAILY_ROW_CEILING,
  SCORE_ATTEMPT_DAILY_ROW_CEILING,
  TELEMETRY_QUOTA_DAILY_ROW_CEILING,
  TRACK_QUOTA_DAILY_ROW_CEILING,
  runPublicWriteQuotaPrune,
} from "../../lib/public-write-quota-maintenance.ts";
import { discoverOpsRouteNames } from "./ops-route-inventory.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

function route(name: string): string {
  return readFileSync(join(HERE, `../../app/api/ops/${name}/route.ts`), "utf8");
}

test("analytics maintenance exposes prune failures to the scheduler", () => {
  const source = route("analytics-maintain");
  assert.match(
    source,
    /if \(!rollupRpc\.ok\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)[\s\S]*?\}/,
  );
  assert.match(
    source,
    /const rollup = parseRollupMaintenanceAck\([\s\S]*?if \(!rollup\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)/,
  );
  assert.match(
    source,
    /if \(!pruneRpc\.ok\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)[\s\S]*?\}/,
  );
  assert.match(
    source,
    /const prune = parseAnalyticsPruneAck\(pruneRpc\.data\);[\s\S]*?if \(!prune\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)/,
  );
  assert.ok(
    source.indexOf("if (!rollup)") < source.indexOf('"prune_analytics_events"'),
    "a malformed rollup acknowledgement must gate destructive pruning",
  );
});

test("telemetry maintenance exposes every authoritative stage failure", () => {
  const source = route("telemetry-maintain");
  assert.match(
    source,
    /if \(!rollupRpc\.ok\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)[\s\S]*?\}/,
  );
  assert.match(
    source,
    /const rollup = parseRollupMaintenanceAck\([\s\S]*?if \(!rollup\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)/,
  );
  assert.match(
    source,
    /if \(!pruneRpc\.ok\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)[\s\S]*?\}/,
  );
  assert.match(
    source,
    /const prune = parseTelemetryPruneAck\(pruneRpc\.data\);[\s\S]*?if \(!prune\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)/,
  );
  assert.match(
    source,
    /if \(!budgetRpc\.ok\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)[\s\S]*?\}/,
  );
  assert.match(
    source,
    /const budget = parseTelemetryBudgetAck\(budgetRpc\.data\);[\s\S]*?if \(!budget\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)/,
  );
  assert.match(source, /const quotaPruneRun = await runPublicWriteQuotaPrune/);
  assert.match(
    source,
    /if \(!quotaPruneRun\.ok\) \{[\s\S]*?public_write_quota_prune_failed[\s\S]*?opsMaintenanceResponseInit\(500\)/,
  );
  assert.match(
    source,
    /if \(!quotaPrune\.done\) \{[\s\S]*?public_write_quota_prune_backlog[\s\S]*?opsMaintenanceResponseInit\(503\)/,
    "a bounded quota-retention backlog must remain retry-visible",
  );
  assert.match(
    source,
    /if \(budget\.degrade_mode !== "full"\) \{[\s\S]*?telemetry_budget_backlog[\s\S]*?opsMaintenanceResponseInit\(429\)/,
    "a bounded telemetry prune that leaves summary/off mode must remain retry-visible",
  );
  assert.ok(
    source.indexOf('"prune_public_write_quota_buckets"') <
      source.indexOf('"telemetry_rollup_days"') &&
      source.indexOf('"prune_public_write_quota_buckets"') <
        source.indexOf("if (!rollupRpc.ok)"),
    "unrelated telemetry maintenance failure cannot suppress the daily quota-retention attempt",
  );
  const initialQuotaDecision = source.slice(
    source.indexOf("if (!quotaPruneRun.ok)"),
    source.indexOf("// ②"),
  );
  assert.doesNotMatch(
    initialQuotaDecision,
    /\breturn\b/,
    "quota retention failure must not short-circuit telemetry stages",
  );
  assert.ok(
    source.indexOf('"telemetry_rollup_days"') <
      source.indexOf('"telemetry_prune"') &&
      source.indexOf('"telemetry_prune"') <
        source.indexOf('"telemetry_budget_refresh"') &&
      source.indexOf("const budget = parseTelemetryBudgetAck") <
        source.lastIndexOf("if (!quotaPruneRun.ok)"),
    "rollup, telemetry prune, and budget refresh all run before a quota-retention failure is returned",
  );
  assert.ok(
    source.lastIndexOf("if (!quotaPruneRun.ok)") <
      source.indexOf('if (budget.degrade_mode !== "full")'),
    "quota retention errors keep precedence over a telemetry budget backlog",
  );
  assert.ok(
    source.indexOf("if (!rollup)") < source.indexOf('"telemetry_prune"'),
    "a malformed rollup acknowledgement must gate destructive pruning",
  );
});

test("public-write quota maintenance capacity exceeds every actor dimension's exact daily row ceiling", () => {
  assert.equal(TELEMETRY_QUOTA_DAILY_ROW_CEILING, 50_001);
  assert.equal(TRACK_QUOTA_DAILY_ROW_CEILING, 2_001);
  assert.equal(SCORE_QUOTA_DAILY_ROW_CEILING, 10_001);
  assert.equal(REPORT_QUOTA_DAILY_ROW_CEILING, 501);
  assert.equal(DOLL_SIGNED_URL_QUOTA_DAILY_ROW_CEILING, 10_001);
  assert.equal(SCORE_ATTEMPT_DAILY_ROW_CEILING, 5_000);
  assert.equal(REPORT_ATTEMPT_DAILY_ROW_CEILING, 500);
  assert.equal(PUBLIC_WRITE_ATTEMPT_DAILY_ROW_CEILING, 5_500);
  assert.equal(PUBLIC_WRITE_QUOTA_DAILY_ROW_CEILING, 78_005);
  assert.equal(PUBLIC_WRITE_QUOTA_PRUNE_BATCH_LIMIT, 80_000);
  assert.equal(PUBLIC_WRITE_QUOTA_PRUNE_MAX_BATCHES, 2);
  assert.equal(PUBLIC_WRITE_QUOTA_PRUNE_CAPACITY, 160_000);
  assert.ok(
    PUBLIC_WRITE_QUOTA_PRUNE_BATCH_LIMIT > PUBLIC_WRITE_QUOTA_DAILY_ROW_CEILING,
    "the mandatory first batch alone must out-drain a maximal day",
  );
});

test("public-write quota maintenance drains a mathematically maximal day in one mandatory batch", async () => {
  const results = [
    {
      data: {
        ok: true,
        deleted: 78_005,
        done: true,
        cutoff: "2026-07-28",
      },
      error: null,
    },
  ];
  const limits: number[] = [];
  const run = await runPublicWriteQuotaPrune(async (limit) => {
    limits.push(limit);
    return results.shift()!;
  });
  assert.deepEqual(limits, [80_000]);
  assert.deepEqual(run, {
    ok: true,
    summary: {
      ok: true,
      deleted: 78_005,
      done: true,
      cutoff: "2026-07-28",
      batches: 1,
      capacity: 160_000,
    },
  });
});

test("public-write quota maintenance keeps bounded backlog and dependency faults non-green", async () => {
  const backlog = await runPublicWriteQuotaPrune(async () => ({
    data: {
      ok: true,
      deleted: 80_000,
      done: false,
      cutoff: "2026-07-28",
    },
    error: null,
  }));
  assert.equal(backlog.ok, true);
  if (backlog.ok) {
    assert.equal(backlog.summary.done, false);
    assert.equal(backlog.summary.deleted, 160_000);
    assert.equal(backlog.summary.batches, 2);
  }

  assert.deepEqual(
    await runPublicWriteQuotaPrune(async () => ({
      data: null,
      error: new Error("resolved"),
    })),
    {
      ok: false,
      reason: "rpc_error",
      cause: new Error("resolved"),
    },
  );
  const thrown = await runPublicWriteQuotaPrune(async () => {
    throw new Error("throw");
  });
  assert.equal(thrown.ok, false);
  if (!thrown.ok) assert.equal(thrown.reason, "rpc_throw");
  assert.deepEqual(
    await runPublicWriteQuotaPrune(async () => ({
      data: { ok: true, deleted: 80_001, done: true, cutoff: "2026-07-28" },
      error: null,
    })),
    { ok: false, reason: "invalid_result" },
  );
});

test("public-write quota maintenance time budget never reports false convergence", async () => {
  const clock = [0, PUBLIC_WRITE_QUOTA_PRUNE_TIME_BUDGET_MS];
  let calls = 0;
  const run = await runPublicWriteQuotaPrune(
    async () => {
      calls += 1;
      return {
        data: {
          ok: true,
          deleted: 80_000,
          done: false,
          cutoff: "2026-07-28",
        },
        error: null,
      };
    },
    () => clock.shift() ?? PUBLIC_WRITE_QUOTA_PRUNE_TIME_BUDGET_MS,
  );
  assert.equal(calls, 1);
  assert.equal(run.ok, true);
  if (run.ok) {
    assert.equal(run.summary.done, false);
    assert.equal(run.summary.deleted, 80_000);
    assert.equal(run.summary.batches, 1);
  }
});

test("integrity and credit cron never coerce malformed mutation responses to zero-success", () => {
  const integrity = route("integrity-scan");
  assert.match(
    integrity,
    /const result = parseIntegrityScanAck\(scanRpc\.data\);[\s\S]*?if \(!result\) \{[\s\S]*?opsMaintenanceResponseInit\(500\)/,
  );
  assert.doesNotMatch(integrity, /\(data \?\? \{\}\)/);
  assert.doesNotMatch(integrity, /scanned \?\? 0/);

  const credit = route("credit-expire");
  assert.match(
    credit,
    /const sweep = parseCreditSweepAck\(sweepRpc\.data, SWEEP_LIMIT\);[\s\S]*?if \(!sweep\) \{[\s\S]*?opsMaintenanceResponseInit\(503\)/,
  );
  assert.doesNotMatch(credit, /\.expired \?\? 0/);
  assert.match(
    credit,
    /const status = opsMaintenanceStatus\(\{\s*systemErrors: 0,\s*retryPending: done \? 0 : 1,/,
    "a time-budget stop must be a retryable non-green result",
  );
  assert.match(
    credit,
    /if \(status === 200\) \{[\s\S]*?heartbeat\([\s\S]*?"success"[\s\S]*?\} else \{[\s\S]*?heartbeat\([\s\S]*?"failure"[\s\S]*?"time_budget_backlog"/,
  );
  assert.match(
    credit,
    /ok: status === 200,[\s\S]*?retry_pending: done \? 0 : 1,[\s\S]*?opsMaintenanceResponseInit\(status\)/,
  );
});

test("generation recovery never reports green on query or durable retry failures", () => {
  const source = route("gen-recover");
  assert.match(
    source,
    /if \(pageError\) \{[\s\S]*?opsMaintenanceResponseInit\(503\)[\s\S]*?\}/,
  );
  for (const errorName of [
    "deletedRowsError",
    "staleDoneError",
    "cleanupQueryError",
    "prErr",
  ]) {
    assert.match(
      source,
      new RegExp(`if \\(${errorName}\\) \\{[\\s\\S]*?systemErrors\\+\\+`),
      `${errorName} must make the scheduler result non-green`,
    );
  }
  assert.match(
    source,
    /if \(pageError \|\| !Array\.isArray\(page\)\) \{\s*systemErrors\+\+;\s*stuckScanFailed = true/,
    "every failed or malformed page in the stuck-generation scan must make the scheduler result non-green",
  );
  assert.match(
    source,
    /const retryPending = pending \+ cleanupPending \+ refundPending/,
  );
  assert.match(
    source,
    /const status = opsMaintenanceStatus\(\{[\s\S]*?systemErrors,[\s\S]*?retryPending,[\s\S]*?boundedBacklogs,[\s\S]*?\}\)/,
  );
  assert.match(source, /if \(!Array\.isArray\(page\)\) \{/);
  assert.doesNotMatch(source, /\.range\(/);
  assert.match(
    source,
    /let recoveryCursor: ChronologicalCursor \| null = null/,
  );
  assert.match(
    source,
    /pageQuery = pageQuery\.or\(\s*chronologicalKeysetFilter\(recoveryCursor\)/,
  );
  assert.match(source, /let stuckCursor: ChronologicalCursor \| null = null/);
  assert.match(
    source,
    /pageQuery = pageQuery\.or\(chronologicalKeysetFilter\(stuckCursor\)\)/,
  );
  assert.match(
    source,
    /advanceChronologicalCursor\(\s*validatedPage,\s*recoveryCursor/,
  );
  assert.match(source, /if \(allTargets\.length > SWEEP_LIMIT\)/);
  assert.match(
    source,
    /NextResponse\.json\([\s\S]*?\{ ok: status === 200, \.\.\.result \},[\s\S]*?opsMaintenanceResponseInit\(status\)/,
  );
});

test("generation recovery keyset cannot skip rows when earlier statuses leave the scan", () => {
  const createdAt = "2026-07-29T00:00:00.000Z";
  const rows = Array.from({ length: 2_000 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    created_at: createdAt,
    index,
  }));
  const firstPage = rows.slice(0, 1_000);
  const cursor = advanceChronologicalCursor(firstPage, null);
  assert.ok(cursor);
  assert.equal(
    chronologicalKeysetFilter(cursor),
    `created_at.gt.${createdAt},and(created_at.eq.${createdAt},id.gt.${firstPage.at(-1)!.id})`,
  );

  // Five hundred rows from page 1 concurrently transition out of queued/done.
  const mutableWindow = rows.filter((row) => row.index >= 500);
  const keysetSecondPage = mutableWindow
    .filter((row) => isAfterChronologicalCursor(row, cursor))
    .slice(0, 1_000);
  assert.equal(keysetSecondPage[0]?.index, 1_000);
  assert.equal(keysetSecondPage.at(-1)?.index, 1_999);

  // The former offset implementation starts at the shrunken offset 1000 and
  // therefore skips original rows 1000..1499.
  const offsetSecondPage = mutableWindow.slice(1_000, 2_000);
  assert.equal(offsetSecondPage[0]?.index, 1_500);

  assert.throws(
    () => advanceChronologicalCursor([firstPage.at(-1)!], cursor),
    /non_advancing_chronological_page/,
  );
});

test("generation recovery keyset preserves PostgreSQL microsecond order", () => {
  const earlier = {
    createdAt: "2026-07-29T00:00:00.000001Z",
    id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  };
  const later = {
    createdAt: "2026-07-29T00:00:00.000002Z",
    id: "00000000-0000-4000-8000-000000000000",
  };
  assert.equal(compareChronologicalKey(earlier, later), -1);
  assert.deepEqual(
    advanceChronologicalCursor(
      [
        { created_at: earlier.createdAt, id: earlier.id },
        { created_at: later.createdAt, id: later.id },
      ],
      null,
    ),
    later,
  );
  assert.equal(
    compareChronologicalKey(earlier, {
      createdAt: "2026-07-29T09:00:00.000001+09:00",
      id: earlier.id,
    }),
    0,
  );
  assert.throws(
    () =>
      chronologicalKeysetFilter({
        createdAt: "2026-02-30T00:00:00Z",
        id: earlier.id,
      }),
    /invalid_chronological_cursor/,
  );
});

test("reconcile exposes unresolved work, refund retry states, faults, and full batches", () => {
  const source = route("reconcile");
  assert.match(
    source,
    /const retryPending = unresolved\.length \+ sweep\.retryPending/,
  );
  assert.match(
    source,
    /boundedBatchMayHaveMore\(rows\.length, BATCH\)[\s\S]*?sweep\.boundedBacklogs/,
  );
  assert.match(
    source,
    /requireSupabaseExactCount\([\s\S]*"pay\.reconcile\.open_issues"[\s\S]*\.from\("reconciliation_issues"\)[\s\S]*\.eq\("state", "open"\)/,
  );
  assert.match(
    source,
    /manualReview > 0 && openIssues === 0[\s\S]*systemErrors \+= 1/,
  );
  assert.match(
    source,
    /const status = opsMaintenanceStatus\(\{\s*systemErrors,\s*retryPending,\s*boundedBacklogs,\s*operatorPending: openIssues,/,
  );
  assert.match(
    source,
    /if \(status === 200\) \{[\s\S]*?heartbeat\([\s\S]*?admin,[\s\S]*?"success"[\s\S]*?\} else \{[\s\S]*?heartbeat\([\s\S]*?"failure"[\s\S]*?status === 503 \? "system_error" : "incomplete"/,
  );
  assert.match(
    source,
    /ok: status === 200,[\s\S]*?refundBlocked: sweep\.blocked,[\s\S]*?refundOutstanding: sweep\.outstanding,[\s\S]*?refundPending: sweep\.pending,[\s\S]*?opsMaintenanceResponseInit\(status\)/,
  );
});

test("content maintenance uses the same non-green scheduler contract", () => {
  const source = route("content-maintain");
  assert.match(
    source,
    /const status = opsMaintenanceStatus\(\{[\s\S]*?systemErrors: result\.systemErrors,[\s\S]*?retryPending,[\s\S]*?boundedBacklogs: result\.boundedBacklogs,[\s\S]*?\}\)/,
  );
  assert.match(
    source,
    /boundedBatchMayHaveMore\(result\.expired, EXPIRE_LIMIT\)/,
  );
  assert.match(
    source,
    /boundedBatchMayHaveMore\([\s\S]*?cleanup\.claimed,[\s\S]*?DURABLE_CLEANUP_LIMIT/,
  );
  assert.match(
    source,
    /drainAccountReactivationJobs\([\s\S]*?\{ maxDurationMs: REACTIVATION_BUDGET_MS \}[\s\S]*?reactivationRetryBacklog = reactivation\.retryBacklog/,
  );
  assert.ok(
    source.indexOf("drainAccountReactivationJobs(") <
      source.indexOf("listStorageObjectsPaginated<"),
    "reactivation must run before the unbounded Storage inventory walk",
  );
  assert.match(
    source,
    /reactivationFailures = reactivation\.failures[\s\S]*?reactivationClaimFailures = reactivation\.claimFailures[\s\S]*?reactivationBacklogSample = reactivation\.backlogSample/,
  );
  assert.match(
    source,
    /reactivation\.claimErrors > 0 \|\| reactivation\.healthErrors > 0[\s\S]*?result\.systemErrors \+=/,
  );
  assert.match(
    source,
    /Math\.max\([\s\S]*?result\.reactivationPending,[\s\S]*?result\.reactivationRetryBacklog/,
    "durable backoff rows must keep cron non-2xx even when no job is due",
  );
  assert.match(
    source,
    /generationProviderOutputScrubBacklog[\s\S]*?boundedBacklogs \+= 1/,
    "private provider URL scrub backlog must keep bounded maintenance non-green",
  );
  assert.match(
    source,
    /retryPending =[\s\S]*?result\.generationProviderOutputScrubBacklog/,
    "private provider URL scrub backlog must remain retry-visible",
  );
  assert.match(
    source,
    /NextResponse\.json\([\s\S]*?\{ ok, retryPending, \.\.\.result \},[\s\S]*?opsMaintenanceResponseInit\(status\)/,
  );
});

test("maintenance status is exhaustive and never green at a bounded queue edge", () => {
  for (let systemErrors = 0; systemErrors <= 2; systemErrors += 1) {
    for (let retryPending = 0; retryPending <= 2; retryPending += 1) {
      for (
        let boundedBacklogs = 0;
        boundedBacklogs <= 2;
        boundedBacklogs += 1
      ) {
        for (
          let operatorPending = 0;
          operatorPending <= 2;
          operatorPending += 1
        ) {
          const expected =
            systemErrors > 0
              ? 503
              : retryPending > 0 || boundedBacklogs > 0 || operatorPending > 0
                ? 429
                : 200;
          assert.equal(
            opsMaintenanceStatus({
              systemErrors,
              retryPending,
              boundedBacklogs,
              operatorPending,
            }),
            expected,
          );
        }
      }
    }
  }

  assert.equal(boundedBatchMayHaveMore(9, 10), false);
  assert.equal(boundedBatchMayHaveMore(10, 10), true);
  assert.equal(boundedBatchMayHaveMore(11, 10), true);
  assert.equal(boundedBatchMayHaveMore(Number.NaN, 10), true);
  assert.equal(
    opsMaintenanceStatus({
      systemErrors: Number.NaN,
      retryPending: 0,
      boundedBacklogs: 0,
    }),
    503,
  );
  assert.deepEqual(opsMaintenanceResponseInit(200), {
    status: 200,
    headers: { "Cache-Control": "no-store" },
  });
  assert.deepEqual(opsMaintenanceResponseInit(429), {
    status: 429,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": "60",
    },
  });
  assert.deepEqual(opsMaintenanceResponseInit(503), {
    status: 503,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": "60",
    },
  });
  assert.deepEqual(opsMaintenanceResponseInit(401), {
    status: 401,
    headers: { "Cache-Control": "no-store" },
  });
  assert.deepEqual(opsMaintenanceResponseInit(500), {
    status: 500,
    headers: {
      "Cache-Control": "no-store",
      "Retry-After": "60",
    },
  });
});

test("every ops route finishes before the scheduler timeout and never uses 207", () => {
  const routeNames = discoverOpsRouteNames();
  assert.ok(routeNames.length > 0, "ops route discovery must not be empty");
  for (const name of routeNames) {
    const source = route(name);
    assert.match(source, /export const maxDuration = 25;/, name);
    assert.doesNotMatch(source, /\b207\b/, name);
    assert.match(
      source,
      /opsMaintenanceResponseInit\((?:429|5\d\d)\)/,
      `${name}: retryable responses must flow through the shared Retry-After helper`,
    );
    assert.doesNotMatch(
      source,
      /\bstatus\s*:\s*(?:429|5\d\d)\b/,
      `${name}: no raw retryable status may bypass common headers`,
    );
    assert.match(
      source,
      /const deadline = createOpsMaintenanceDeadline\(\)/,
      name,
    );
    assert.match(
      source,
      /runOpsMaintenanceWithDeadline(?:<NextResponse>)?\([\s\S]*?deadline,/,
      name,
    );
    assert.match(
      source,
      /maintenance_time_budget[\s\S]*?opsMaintenanceResponseInit\(429\)|opsMaintenanceResponseInit\(429\)[\s\S]*?maintenance_time_budget/,
      name,
    );
    assert.match(
      source,
      /\.abortSignal\(deadline\.signal\)|opsMaintenanceDeadlineReached\(deadline|listStorageObjectsPaginated|drainAccountReactivationJobs|recoverQueuedGeneration/,
      `${name}: authoritative I/O must be abort-aware or followed by a cooperative fence`,
    );
  }
  assert.equal(OPS_MAINTENANCE_ROUTE_BUDGET_MS, 20_000);
  assert.match(
    route("credit-expire"),
    /opsMaintenanceDeadlineReached\(deadline, 2_000\)/,
  );
  for (const name of ["credit-expire", "reconcile"]) {
    const source = route(name);
    assert.match(source, /AbortSignal\.timeout\(1_000\)/, name);
    assert.match(
      source,
      /"failure",[\s\S]*?"time_budget",[\s\S]*?AbortSignal\.timeout\(1_000\)/,
      `${name}: timeout must attempt a bounded durable failure heartbeat`,
    );
    assert.match(
      source,
      /request\.abortSignal\(signal\)/,
      `${name}: success heartbeat must be cancelled with route work`,
    );
  }
});

test("the shared monotonic deadline has exact boundary semantics", async () => {
  let now = 1_000;
  const deadline = createOpsMaintenanceDeadline(20_000, () => now);
  assert.equal(opsMaintenanceTimeRemaining(deadline), 20_000);
  assert.equal(opsMaintenanceDeadlineReached(deadline, 2_000), false);
  now = 19_000;
  assert.equal(opsMaintenanceTimeRemaining(deadline), 2_000);
  assert.equal(opsMaintenanceDeadlineReached(deadline, 2_000), true);
  now = 21_000;
  assert.equal(opsMaintenanceTimeRemaining(deadline), 0);

  let workCalled = false;
  const timedOut = await runOpsMaintenanceWithDeadline(
    deadline,
    async () => {
      workCalled = true;
      return "work";
    },
    () => "timeout",
  );
  assert.equal(timedOut, "timeout");
  assert.equal(workCalled, false);
});

test("timeout owns the result before abort-aware work can resolve", async () => {
  const deadline = createOpsMaintenanceDeadline(5);
  let timeoutObservedAbort = false;
  const result = await runOpsMaintenanceWithDeadline(
    deadline,
    () =>
      new Promise<string>((resolve) => {
        deadline.signal.addEventListener(
          "abort",
          () => resolve("late_work_result"),
          { once: true },
        );
      }),
    async () => {
      timeoutObservedAbort = deadline.signal.aborted;
      return "timeout_result";
    },
  );
  assert.equal(result, "timeout_result");
  assert.equal(timeoutObservedAbort, true);
  assert.equal(deadline.signal.aborted, true);
});
