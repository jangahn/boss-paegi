import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  parseReviewerMutationSuccess,
  parseReviewerPendingAck,
  reviewerHttpError,
} from "../../lib/reviewer-http-contract.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const JOB = "22222222-2222-4222-8222-222222222222";
const PASSWORD = "Abcdefghijk23456";

test("reviewer credential actions require a password xor reset-required proof", () => {
  assert.deepEqual(
    parseReviewerMutationSuccess(
      {
        ok: true,
        userId: USER,
        password: PASSWORD,
        credentialResetRequired: false,
      },
      { action: "provision" },
    ),
    {
      userId: USER,
      password: PASSWORD,
      credentialResetRequired: false,
    },
  );
  assert.deepEqual(
    parseReviewerMutationSuccess(
      {
        ok: true,
        userId: USER,
        credentialResetRequired: true,
      },
      { action: "reset_password", userId: USER },
    ),
    { userId: USER, credentialResetRequired: true },
  );
  for (const malformed of [
    null,
    {
      ok: true,
      userId: USER,
      credentialResetRequired: false,
    },
    {
      ok: true,
      userId: USER,
      password: PASSWORD,
      credentialResetRequired: true,
    },
    {
      ok: true,
      userId: USER,
      password: "short",
      credentialResetRequired: false,
    },
    {
      ok: true,
      userId: USER,
      password: PASSWORD,
      credentialResetRequired: false,
      error: "late_failure",
    },
  ]) {
    assert.equal(
      parseReviewerMutationSuccess(malformed, { action: "provision" }),
      null,
    );
  }
});

test("non-credential actions are target-bound and cannot carry a password", () => {
  const valid = {
    ok: true,
    userId: USER,
    credentialResetRequired: false,
  };
  assert.deepEqual(
    parseReviewerMutationSuccess(valid, {
      action: "set_active",
      userId: USER,
    }),
    { userId: USER, credentialResetRequired: false },
  );
  assert.equal(
    parseReviewerMutationSuccess(valid, {
      action: "delete",
      userId: JOB,
    }),
    null,
  );
  assert.equal(
    parseReviewerMutationSuccess(
      { ...valid, password: PASSWORD },
      { action: "delete", userId: USER },
    ),
    null,
  );
});

test("durable pending reviewer jobs require the exact expected job receipt", () => {
  assert.deepEqual(
    parseReviewerPendingAck(
      { ok: false, error: "sync_pending", jobId: JOB },
      "sync_pending",
    ),
    { error: "sync_pending", jobId: JOB },
  );
  for (const malformed of [
    null,
    { ok: false, error: "sync_pending" },
    { ok: true, error: "sync_pending", jobId: JOB },
    { ok: false, error: "delete_pending", jobId: JOB },
    { ok: false, error: "sync_pending", jobId: "bad" },
    { ok: false, error: "sync_pending", jobId: JOB, extra: true },
  ]) {
    assert.equal(
      parseReviewerPendingAck(malformed, "sync_pending"),
      null,
    );
  }
  assert.equal(reviewerHttpError({ error: "request_conflict" }), "request_conflict");
  assert.equal(reviewerHttpError({ error: "<html>" }), null);
});

test("reviewer UI clears its operation id only after an exact success", () => {
  const source = readFileSync(
    new URL(
      "../../components/admin/ReviewerAccountsPanel.tsx",
      import.meta.url,
    ),
    "utf8",
  );
  const parse = source.indexOf("parseReviewerMutationSuccess");
  const clear = source.indexOf("operations.current.clear(operationSlot)", parse);
  assert.ok(parse >= 0 && clear > parse);
  assert.match(source, /parseReviewerPendingAck\(data, expected\.pendingError\)/);
  assert.doesNotMatch(source, /!res\.ok \|\| !data\.ok/);
});

test("reviewer provisioning logs correlation ids without storing email PII", () => {
  const route = readFileSync(
    new URL("../../app/api/admin/reviewers/route.ts", import.meta.url),
    "utf8",
  );
  for (const [level, event] of [
    ["info", "admin.reviewer_provision_completed"],
    ["warn", "admin.reviewer_provision_not_completed"],
    ["error", "admin.reviewer_provision_start_fail"],
  ] as const) {
    const start = route.indexOf(`log.${level}("${event}"`);
    assert.ok(start >= 0, event);
    const block = route.slice(start, route.indexOf("});", start) + 3);
    assert.doesNotMatch(block, /\bemail\s*:/, event);
    assert.match(block, /\boperationId\s*:/, event);
  }
});
