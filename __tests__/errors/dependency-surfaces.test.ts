import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
  readSupabaseRowsPaginated,
  requireSupabaseData,
  requireSupabaseExactCount,
  requireSupabaseOptionalData,
  requireSupabasePage,
  requireSupabaseRows,
  SupabaseOperationError,
} from "../../lib/supabase-operation.ts";
import {
  contentReportRpcErrorCode,
  isContentReportTargetNotFound,
  parseContentReportHttpAck,
  parseContentReportInput,
  parseContentReportSubmission,
} from "../../lib/content-report.ts";
import {
  requireOkRpcPayload,
  requireUuidRpcPayload,
} from "../../lib/rpc-payload.ts";
import { restoreAuthEmailWithRetry } from "../../lib/reactivation-auth-sync.ts";
import { resolveReviewerAccountRead } from "../../lib/reviewer-status.ts";
import { parseLeaderboardRows } from "../../lib/leaderboard-response.ts";

function source(relative: string): string {
  return readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8");
}

const reportRoute = source("app/api/report/route.ts");
const reportDialog = source("components/ReportDialog.tsx");
const reportMigration = source(
  "supabase/migrations/0080_atomic_content_report_submission.sql",
);
const profileSource = source("lib/profile.ts");
const oauthSource = source("lib/auth-oauth.ts");
const integritySource = source("lib/admin-integrity.ts");
const configAuditSource = source("lib/config/audit.ts");
const scoreDetailSource = source("lib/score-detail.ts");
const moderationRevalidateSource = source("lib/moderation-revalidate.ts");
const reviewersRoute = source("app/api/admin/reviewers/route.ts");
const legalRoute = source("app/api/admin/legal/route.ts");
const eventsRoute = source("app/api/admin/events/route.ts");
const checkoutRoute = source("app/api/pay/checkout/route.ts");
const creditsPage = source("app/credits/page.tsx");
const creditsClient = source("app/credits/CreditsClient.tsx");
const settleRoute = source("app/api/admin/settle/route.ts");
const leaderboardRoute = source("app/api/leaderboard/route.ts");
const leaderboardPage = source("app/leaderboard/page.tsx");

test("strict Supabase helpers distinguish no-row from resolved/throw failures", async () => {
  assert.equal(
    await requireSupabaseOptionalData("optional", async () => ({
      data: null,
      error: null,
    })),
    null,
  );
  const injected = { code: "PGRST000", message: "db unavailable" };
  await assert.rejects(
    requireSupabaseOptionalData("optional", async () => ({
      data: null,
      error: injected,
    })),
    (error) =>
      error instanceof SupabaseOperationError &&
      error.operation === "optional" &&
      error.operationError === injected,
  );
  await assert.rejects(
    requireSupabaseOptionalData("optional_throw", async () => {
      throw injected;
    }),
    (error) =>
      error instanceof SupabaseOperationError &&
      error.operationError === injected,
  );
  await assert.rejects(
    requireSupabaseData("required", async () => ({
      data: null,
      error: null,
    })),
    /required failed/,
  );
});

test("row/count/page contracts reject malformed successful responses", async () => {
  await assert.rejects(
    requireSupabaseRows("rows", async () => ({
      data: null,
      error: null,
    })),
    /rows failed/,
  );
  for (const count of [null, -1, 1.5, Number.NaN]) {
    await assert.rejects(
      requireSupabaseExactCount("count", async () => ({
        count,
        error: null,
      })),
      /count failed/,
    );
  }
  assert.deepEqual(
    await requireSupabasePage("page", async () => ({
      data: [{ id: 1 }],
      count: 1,
      error: null,
    })),
    { rows: [{ id: 1 }], count: 1 },
  );
  await assert.rejects(
    requireSupabasePage("page", async () => ({
      data: [],
      count: null,
      error: null,
    })),
    /page failed/,
  );
});

test("pagination returns every page and never leaks a partial result after failure", async () => {
  const calls: number[] = [];
  const all = await readSupabaseRowsPaginated(
    "all_rows",
    async (offset) => {
      calls.push(offset);
      return {
        data: offset === 0 ? [1, 2] : offset === 2 ? [3] : [],
        error: null,
      };
    },
    2,
  );
  assert.deepEqual(all, [1, 2, 3]);
  assert.deepEqual(calls, [0, 2]);

  await assert.rejects(
    readSupabaseRowsPaginated(
      "failed_rows",
      async (offset) =>
        offset === 0
          ? { data: [1, 2], error: null }
          : { data: null, error: new Error("page two failed") },
      2,
    ),
    /failed_rows\[offset=2\] failed/,
  );
});

test("report JSON boundary rejects type confusion and silent truncation", () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const submissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  assert.deepEqual(
    parseContentReportInput({
      submissionId: submissionId.toUpperCase(),
      targetId: id,
      reason: "portrait",
      detail: "  why  ",
      contact: "  me@example.test ",
    }),
    {
      ok: true,
      value: {
        submissionId,
        targetId: id,
        reason: "portrait",
        detail: "why",
        contact: "me@example.test",
      },
    },
  );
  assert.deepEqual(
    parseContentReportInput({
      submissionId,
      targetId: id,
      reason: "forged",
    }),
    { ok: false, error: "reason_invalid" },
  );
  assert.deepEqual(
    parseContentReportInput({
      submissionId,
      targetId: id,
      reason: "other",
      detail: 123,
    }),
    { ok: false, error: "detail_invalid" },
  );
  assert.deepEqual(
    parseContentReportInput({
      submissionId,
      targetId: id,
      reason: "other",
      contact: "x".repeat(201),
    }),
    { ok: false, error: "contact_invalid" },
  );
  assert.deepEqual(
    parseContentReportInput({
      targetId: id,
      reason: "other",
    }),
    { ok: false, error: "client_upgrade_required" },
  );
  assert.deepEqual(
    parseContentReportInput({
      submissionId: "not-a-uuid",
      targetId: id,
      reason: "other",
    }),
    { ok: false, error: "submission_id_invalid" },
  );
});

test("report RPC response accepts only complete inserted/removed outcomes", () => {
  const reportId = "22222222-2222-4222-8222-222222222222";
  assert.deepEqual(
    parseContentReportSubmission({
      ok: true,
      inserted: true,
      already_removed: false,
      was_first: true,
      report_id: reportId,
      duplicate: false,
    }),
    { kind: "inserted", reportId, wasFirst: true, duplicate: false },
  );
  assert.deepEqual(
    parseContentReportSubmission({
      ok: true,
      inserted: false,
      already_removed: true,
      was_first: false,
      report_id: null,
      duplicate: true,
    }),
    { kind: "already_removed", duplicate: true },
  );
  for (const malformed of [
    null,
    { ok: true },
    {
      ok: true,
      inserted: true,
      already_removed: false,
      was_first: null,
      report_id: reportId,
      duplicate: false,
    },
    {
      ok: true,
      inserted: false,
      already_removed: false,
      was_first: false,
      duplicate: false,
    },
    {
      ok: true,
      inserted: false,
      already_removed: true,
      was_first: false,
      report_id: reportId,
      duplicate: false,
    },
    {
      ok: true,
      inserted: true,
      already_removed: false,
      was_first: true,
      report_id: reportId,
    },
  ]) {
    assert.equal(parseContentReportSubmission(malformed), null);
  }

  assert.deepEqual(parseContentReportHttpAck({ ok: true, duplicate: false }), {
    ok: true,
    duplicate: false,
    alreadyRemoved: false,
  });
  assert.deepEqual(
    parseContentReportHttpAck({
      ok: true,
      duplicate: true,
      already_removed: true,
    }),
    { ok: true, duplicate: true, alreadyRemoved: true },
  );
  for (const malformed of [
    null,
    {},
    { ok: true },
    { ok: true, duplicate: "false" },
    { ok: true, duplicate: false, already_removed: false },
  ]) {
    assert.equal(parseContentReportHttpAck(malformed), null);
  }
  assert.match(reportDialog, /parseContentReportHttpAck\(body\)/);
  assert.doesNotMatch(reportDialog, /if \(res\.ok\) \{/);
});

test("target_not_found recognition requires the expected database error code", () => {
  assert.equal(
    isContentReportTargetNotFound({
      code: "P0001",
      message: "target_not_found",
    }),
    true,
  );
  assert.equal(
    isContentReportTargetNotFound({
      code: "PGRST000",
      message: "target_not_found",
    }),
    false,
  );
  assert.equal(
    isContentReportTargetNotFound({
      code: "P0001",
      message: "not_target_not_found_suffix",
    }),
    false,
  );
  assert.equal(
    contentReportRpcErrorCode({
      code: "P0001",
      message: "submission_conflict",
    }),
    "submission_conflict",
  );
  assert.equal(
    contentReportRpcErrorCode({
      code: "P0001",
      message: "rate_limited",
    }),
    "rate_limited",
  );
});

test("generic RPC payload guards reject null false-success", () => {
  assert.deepEqual(requireOkRpcPayload({ ok: true, version: 3 }), {
    ok: true,
    version: 3,
  });
  assert.throws(() => requireOkRpcPayload(null), /invalid_rpc_response/);
  assert.throws(
    () => requireOkRpcPayload({ ok: false }),
    /invalid_rpc_response/,
  );
  assert.equal(
    requireUuidRpcPayload("33333333-3333-4333-8333-333333333333"),
    "33333333-3333-4333-8333-333333333333",
  );
  assert.throws(() => requireUuidRpcPayload("not-a-uuid"));
});

test("GoTrue email restore retries resolved and thrown errors without false success", async () => {
  let attempts = 0;
  const delays: number[] = [];
  const recovered = await restoreAuthEmailWithRetry(
    async () => {
      attempts += 1;
      if (attempts === 1) return { error: new Error("resolved") };
      if (attempts === 2) throw new Error("thrown");
      return { error: null };
    },
    {
      delay: async (milliseconds) => {
        delays.push(milliseconds);
      },
    },
  );
  assert.deepEqual(recovered, { ok: true, attempts: 3 });
  assert.deepEqual(delays.length, 2);

  const failed = await restoreAuthEmailWithRetry(
    async () => ({ error: new Error("persistent") }),
    { maxAttempts: 2, delay: async () => {} },
  );
  assert.equal(failed.ok, false);
  assert.equal(failed.attempts, 2);
});

test("reviewer lookup keeps inactive/no-row separate from dependency failure", () => {
  assert.deepEqual(resolveReviewerAccountRead({ data: null, error: null }), {
    ok: true,
    isReviewer: false,
  });
  assert.deepEqual(
    resolveReviewerAccountRead({
      data: { active: false, auth_sync_pending: false },
      error: null,
    }),
    { ok: true, isReviewer: false },
  );
  assert.deepEqual(
    resolveReviewerAccountRead({
      data: { active: true, auth_sync_pending: false },
      error: null,
    }),
    { ok: true, isReviewer: true },
  );
  const error = new Error("reviewer DB unavailable");
  assert.deepEqual(
    resolveReviewerAccountRead({
      data: { active: true, auth_sync_pending: false },
      error,
    }),
    { ok: false, error },
  );
  assert.equal(
    resolveReviewerAccountRead({
      data: { active: true, auth_sync_pending: true },
      error: null,
    }).ok,
    false,
  );
  assert.equal(resolveReviewerAccountRead({ data: {}, error: null }).ok, false);
});

test("report route has one atomic write path and alerts only the elected first report", () => {
  assert.match(reportRoute, /admin\.rpc\("submit_content_report"/);
  assert.doesNotMatch(reportRoute, /\.from\("content_reports"\)/);
  assert.match(
    reportRoute,
    /submission\.wasFirst[\s\S]*!submission\.duplicate[\s\S]*log\.error\("report\.new"/,
  );
  assert.match(reportRoute, /report\.invalid_rpc_response/);
  assert.match(reportRoute, /rpcResult\.error/);
  assert.match(reportRoute, /p_submission_id: submissionId/);
  assert.match(reportRoute, /p_rate_allowed: rateAllowed/);
  assert.match(
    reportRoute,
    /status:\s*parsed\.error === "client_upgrade_required" \? 409 : 400/,
  );
  assert.match(reportRoute, /submission_conflict[\s\S]*status: 409/);
  assert.match(
    reportDialog,
    /submissionIdRef = useRef<string \| null>\(null\)/,
  );
  assert.match(
    reportDialog,
    /submissionIdRef\.current \?\? createContentReportSubmissionId\(\)/,
  );
  assert.match(reportDialog, /submissionIdRef\.current = submissionId/);
  assert.match(
    reportDialog,
    /errorCode === "rate_limited"[\s\S]*?submissionIdRef\.current = null/,
  );
  assert.match(reportDialog, /JSON\.stringify\(\{[\s\S]*submissionId,/);
});

test("0080 orders lifecycle lock before report election and denies direct writes", () => {
  const functionStart = reportMigration.indexOf(
    "create or replace function public.submit_content_report",
  );
  const functionEnd = reportMigration.indexOf(
    "alter function public.submit_content_report",
    functionStart,
  );
  const fn = reportMigration.slice(functionStart, functionEnd);
  const submissionLock = fn.indexOf("content-report:submission:");
  const receiptRead = fn.indexOf(
    "from public.content_report_submission_receipts",
  );
  const dollLock = fn.indexOf("for key share");
  const deletedCheck = fn.indexOf("if v_deleted_at is not null");
  const targetLock = fn.indexOf("content-report:doll:");
  const pendingRead = fn.indexOf("select not exists");
  const insert = fn.indexOf("insert into public.content_reports");
  const receiptInsert = fn.lastIndexOf(
    "insert into public.content_report_submission_receipts",
  );
  assert.ok(submissionLock >= 0);
  assert.ok(receiptRead > submissionLock);
  assert.ok(dollLock > receiptRead);
  assert.ok(deletedCheck > dollLock);
  assert.ok(targetLock > deletedCheck);
  assert.ok(pendingRead > targetLock);
  assert.ok(insert > pendingRead);
  assert.ok(receiptInsert > insert);
  assert.match(
    reportMigration,
    /revoke insert on table public\.content_reports from service_role/,
  );
  assert.match(reportMigration, /set search_path = ''/);
  assert.match(reportMigration, /raise exception 'submission_conflict'/);
  assert.match(
    reportMigration,
    /revoke all on table public\.content_report_submission_receipts/,
  );
});

test("profile/OAuth/integrity/config reads do not collapse dependency errors", () => {
  assert.match(
    profileSource,
    /requireSupabaseData\(\s*"profile\.self"/,
  );
  assert.match(
    profileSource,
    /requireSupabaseOptionalData\(\s*"profile\.member"/,
  );
  assert.doesNotMatch(profileSource, /\.then\(\(r\) => r\.data/);

  assert.match(
    oauthSource,
    /runClientMutation\(\{[\s\S]*createClient\(\s*requestSignal,\s*\)\.auth\.getUser\(\)/,
  );
  assert.match(
    oauthSource,
    /return error\s*\?\s*\{ kind: "rejected" as const, error \}\s*:\s*\{ kind: "confirmed" as const, value: data \}/,
  );
  assert.match(oauthSource, /if \(userRead\.kind !== "confirmed"\)/);
  assert.match(
    oauthSource,
    /const prepared = await runClientMutation\(\{[\s\S]*attempt: prepare,[\s\S]*reconcile: prepare/,
  );
  assert.match(oauthSource, /if \(prepared\.kind !== "confirmed"\)/);
  assert.match(oauthSource, /auth\.prepare_signup_fail[\s\S]*throw e/);

  assert.match(integritySource, /requireSupabasePage\(/);
  assert.match(integritySource, /integrity\.detail\.score/);
  assert.match(integritySource, /integrity\.detail\.flag/);
  assert.match(integritySource, /integrity\.detail\.member/);
  assert.match(integritySource, /integrity\.detail\.telemetry/);
  assert.match(integritySource, /integrity\.detail\.other_scores/);

  assert.match(configAuditSource, /requireSupabasePage</);
  assert.match(configAuditSource, /config\.audit_entry/);
  assert.match(configAuditSource, /config\.version/);
  assert.doesNotMatch(configAuditSource, /return 0;[\s\S]*if \(error\)/);
});

test("remaining read/admin surfaces distinguish absence from infrastructure failure", () => {
  assert.match(scoreDetailSource, /PGRST116/);
  assert.match(scoreDetailSource, /throw new SupabaseOperationError/);
  assert.match(moderationRevalidateSource, /readSupabaseRowsPaginated/);
  assert.doesNotMatch(moderationRevalidateSource, /\.limit\(200\)/);
  assert.match(reviewersRoute, /create_pending/);
  assert.match(reviewersRoute, /sync_pending/);
  assert.match(reviewersRoute, /reset_pending/);
  assert.match(reviewersRoute, /delete_pending/);
  assert.match(reviewersRoute, /start_reviewer_provision/);
  assert.match(reviewersRoute, /start_reviewer_auth_sync/);
  assert.match(reviewersRoute, /reviewerCredentialResetRequired/);
  assert.doesNotMatch(reviewersRoute, /auth\.admin\.updateUserById/);
  assert.match(legalRoute, /parseLegalSaveResult\(data\)/);
  assert.match(legalRoute, /parseLegalPublishResult\(data\)/);
  assert.match(legalRoute, /parseLegalUnpublishResult\(data\)/);
  assert.match(eventsRoute, /parseAdminEventMutationResult\(data\)/);
  assert.match(
    eventsRoute,
    /if \(!parsed\) throw new Error\("invalid_rpc_response"\)/,
  );
  assert.match(eventsRoute, /const payload = eventMutationPayload\(data\)/);
});

test("reviewer uncertainty cannot select a live payment channel or a false normal UI", () => {
  const lookup = checkoutRoute.indexOf(
    "reviewer = await waitForCheckoutDependency(",
  );
  const failClosed = checkoutRoute.indexOf("if (!reviewer.ok)", lookup);
  const unavailable = checkoutRoute.indexOf(
    '{ error: "payment_unavailable" }',
    failClosed,
  );
  const mode = checkoutRoute.indexOf("const mode = payModeFor", lookup);
  assert.ok(lookup >= 0);
  assert.ok(failClosed > lookup);
  assert.ok(unavailable > failClosed);
  assert.ok(mode > unavailable);
  assert.match(creditsPage, /if \(!reviewer\.ok\)/);
  assert.match(creditsPage, /classificationUnavailable/);
  assert.match(
    creditsClient,
    /if \(\s*classificationUnavailable \|\|[\s\S]*안전을 위해 결제를 시작하지 않았어요/,
  );
});

test("admin dependency failures are 5xx and unknown DB messages are not reflected", () => {
  assert.match(
    settleRoute,
    /if \(loadErr\)[\s\S]*action_failed[\s\S]*status: 503/,
  );
  assert.match(settleRoute, /code === "action_failed" \? 500 : 400/);
  assert.match(settleRoute, /parseAdminSettlementMutationResult\(data\)/);
  assert.match(
    settleRoute,
    /if \(!result\) \{[\s\S]*?action_failed[\s\S]*?status: 500/,
  );
  assert.match(
    legalRoute,
    /known[\s\S]*\? \{ error: known\.message, code \}[\s\S]*: \{ error: "update_failed" \}/,
  );
  assert.match(
    eventsRoute,
    /known \? \{ error: known, code \} : \{ error: "update_failed" \}/,
  );
  for (const route of [legalRoute, eventsRoute]) {
    assert.doesNotMatch(route, /\{ error: known \?\? "update_failed", code \}/);
  }
});

test("leaderboard parser distinguishes a genuine empty ranking from malformed success", () => {
  assert.deepEqual(parseLeaderboardRows([]), []);
  const valid = {
    id: "44444444-4444-4444-8444-444444444444",
    owner_id: "55555555-5555-4555-8555-555555555555",
    score: 123,
    weapon: "fist",
    duration_ms: 1_000,
    created_at: "2026-07-29T00:00:00.000Z",
    display_name: null,
    avatar_url: null,
  };
  assert.deepEqual(parseLeaderboardRows([valid]), [valid]);
  for (const malformed of [
    null,
    {},
    [{ ...valid, score: Number.NaN }],
    [{ ...valid, owner_id: "not-uuid" }],
    [{ ...valid, created_at: "not-date" }],
    Array.from({ length: 11 }, () => valid),
  ]) {
    assert.equal(parseLeaderboardRows(malformed), null);
  }
});

test("leaderboard API/UI keep unavailable separate from a genuine empty ranking", () => {
  assert.match(
    leaderboardRoute,
    /leaderboard_unavailable[\s\S]*status: 503[\s\S]*Cache-Control": "no-store"/,
  );
  assert.match(leaderboardRoute, /parseLeaderboardRows\(data\)/);
  assert.doesNotMatch(leaderboardRoute, /\{ rows: \[\] \}/);
  assert.match(
    leaderboardPage,
    /response\.ok[\s\S]*parseLeaderboardRows\(body\?\.rows\)/,
  );
  assert.doesNotMatch(leaderboardPage, /body\.rows as RankRow\[\]/);
  assert.match(leaderboardPage, /setLoadError\(true\)/);
  assert.match(leaderboardPage, /다시 불러오기/);
});

test("report race harnesses are syntactically valid and wired into CI", () => {
  const repoRoot = new URL("../../", import.meta.url);
  for (const relative of [
    "../../scripts/qa/test-report-submission-race.sh",
    "../../scripts/qa/test-public-score-report-quota-races.sh",
  ]) {
    const scriptUrl = new URL(relative, import.meta.url);
    const check = spawnSync("bash", ["-n", scriptUrl.pathname], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    assert.equal(check.status, 0, `${relative}: ${check.stderr}`);
  }
  assert.match(source("package.json"), /qa:db:report-race/);
  assert.match(source(".github/workflows/quality.yml"), /qa:db:report-race/);
  assert.match(source("package.json"), /qa:db:score-report-quota-race/);
  assert.match(
    source(".github/workflows/quality.yml"),
    /qa:db:score-report-quota-race/,
  );
});

test("report race cleanup is retention-authorized, exact, and fail-visible", () => {
  const reportRace = source("scripts/qa/test-report-submission-race.sh");
  const quotaRace = source(
    "scripts/qa/test-public-score-report-quota-races.sh",
  );

  for (const script of [reportRace, quotaRace]) {
    assert.match(
      script,
      /begin;[\s\S]*'boss_paegi\.privacy_retention_delete',[\s\S]*'008904:v1',[\s\S]*true[\s\S]*delete from public\.content_report_submission_receipts[\s\S]*commit;/,
    );
    assert.match(
      script,
      /cleanup_remaining="\$\([\s\S]*pg_catalog\.count\(\*\)/,
    );
    assert.match(script, /elif \[\[ "\$cleanup_remaining" != "0" \]\]/);
    assert.match(
      script,
      /cleanup_failed != 0 && original_status == 0[\s\S]*exit 1/,
    );
  }

  assert.match(
    quotaRace,
    /cleanup_remaining="\$\([\s\S]*from public\.public_write_attempts[\s\S]*from public\.public_write_quota_buckets/,
  );
});
