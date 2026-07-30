import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parsePermanentDeleteHttpOutcome } from "../../lib/moderation-action-response.ts";

const JOB = "11111111-1111-4111-8111-111111111111";

test("permanent-delete distinguishes durable queue acceptance from completion", () => {
  assert.deepEqual(
    parsePermanentDeleteHttpOutcome(202, {
      accepted: true,
      purge: "pending",
      jobId: JOB.toUpperCase(),
    }),
    { kind: "pending", jobId: JOB },
  );
  assert.deepEqual(
    parsePermanentDeleteHttpOutcome(200, {
      ok: true,
      purged: true,
      failed: 0,
    }),
    { kind: "completed" },
  );
  assert.deepEqual(
    parsePermanentDeleteHttpOutcome(200, {
      ok: true,
      already_purged: true,
    }),
    { kind: "completed" },
  );
});

test("permanent-delete never promotes malformed or incomplete 2xx to completed", () => {
  for (const [status, body] of [
    [202, { accepted: true, purge: "pending" }],
    [202, { accepted: true, purge: "completed", jobId: JOB }],
    [202, { ok: true, purged: true, failed: 0 }],
    [200, { accepted: true, purge: "pending", jobId: JOB }],
    [200, { ok: true, purged: false, failed: 0 }],
    [200, { ok: true, purged: true, failed: 1 }],
    [204, { ok: true, purged: true, failed: 0 }],
    [200, null],
  ] as const) {
    assert.equal(
      parsePermanentDeleteHttpOutcome(status, body),
      null,
      JSON.stringify({ status, body }),
    );
  }
});

test("moderation UI keeps a valid 202 visible as pending", () => {
  const source = readFileSync(
    new URL("../../components/admin/ModerationQueueTable.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /parsePermanentDeleteHttpOutcome\(res\.status, body\)/);
  assert.match(
    source,
    /if \(outcome\.kind === "confirmed"\)[\s\S]*if \(outcome\.value\.kind === "pending"\)[\s\S]*setPurgePendingJobId\(outcome\.value\.jobId\)[\s\S]*return;/,
  );
  assert.match(source, /아직 완료되지 않았어요/);
  assert.doesNotMatch(
    source,
    /if \(res\.ok\) \{\s*setMode\(null\)[\s\S]*parsePermanentDeleteHttpOutcome/,
  );
});

test("permanent-delete modal freezes one request and exact payload across retries", () => {
  const source = readFileSync(
    new URL("../../components/admin/ModerationQueueTable.tsx", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /requestId: crypto\.randomUUID\(\),[\s\S]*expectedState: "hidden",[\s\S]*expectedVersion: row\.moderationVersion/,
  );
  assert.match(
    source,
    /submittedReason = permanentIntent\.reason \?\? submittedReason;[\s\S]*expectedVersion = permanentIntent\.expectedVersion;[\s\S]*requestId = permanentIntent\.requestId;/,
  );
  assert.match(
    source,
    /setPermanentIntent\(\{ \.\.\.permanentIntent, reason: submittedReason \}\);/,
  );
  assert.match(source, /\.\.\.\(requestId \? \{ requestId \} : \{\}\)/);
  assert.match(
    source,
    /mode === "permanent" && permanentIntent\?\.reason !== null/,
  );
  assert.match(
    source,
    /const closeModal = \(\) => \{[\s\S]*setPermanentIntent\(null\);/,
  );
});
