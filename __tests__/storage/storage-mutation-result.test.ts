import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cleanupJobToRun,
  isCleanupTerminal,
  parseDetachedStorageMutationAck,
  parseDollDeleteAck,
  parseDollDeleteHttpAck,
  parseDollRoleUpdateAck,
} from "../../lib/storage-mutation-result.ts";

const JOB_ID = "00000000-0000-4000-8000-000000000001";

test("avatar cleanup ack는 exact shape와 job/status 상관관계를 요구한다", () => {
  assert.deepEqual(
    parseDetachedStorageMutationAck({
      ok: true,
      job_id: JOB_ID,
      cleanup_status: "pending",
    }),
    { jobId: JOB_ID, cleanupStatus: "pending" },
  );
  assert.deepEqual(
    parseDetachedStorageMutationAck({
      ok: true,
      job_id: null,
      cleanup_status: "completed",
    }),
    { jobId: null, cleanupStatus: "completed" },
  );

  for (const malformed of [
    null,
    true,
    {},
    { ok: false, job_id: null, cleanup_status: "completed" },
    { ok: true, job_id: null, cleanup_status: "pending" },
    { ok: true, job_id: "not-a-uuid", cleanup_status: "pending" },
    { ok: true, job_id: JOB_ID, cleanup_status: "unknown" },
    {
      ok: true,
      job_id: JOB_ID,
      cleanup_status: "completed",
      extra: true,
    },
  ]) {
    assert.equal(parseDetachedStorageMutationAck(malformed), null);
  }
});

test("doll DELETE ack는 response-loss receipt와 terminal 상태를 정확히 보존한다", () => {
  for (const cleanupStatus of [
    "pending",
    "leased",
    "completed",
    "canceled",
  ] as const) {
    assert.deepEqual(
      parseDollDeleteAck({
        ok: true,
        already_deleted: true,
        job_id: JOB_ID,
        cleanup_status: cleanupStatus,
      }),
      {
        alreadyDeleted: true,
        jobId: JOB_ID,
        cleanupStatus,
      },
    );
  }
  assert.deepEqual(
    parseDollDeleteAck({
      ok: true,
      already_deleted: false,
      job_id: null,
      cleanup_status: "completed",
    }),
    {
      alreadyDeleted: false,
      jobId: null,
      cleanupStatus: "completed",
    },
  );
  for (const malformed of [
    {
      ok: true,
      already_deleted: true,
      job_id: null,
      cleanup_status: "completed",
    },
    {
      ok: true,
      already_deleted: "true",
      job_id: JOB_ID,
      cleanup_status: "completed",
    },
    {
      ok: true,
      already_deleted: false,
      job_id: null,
      cleanup_status: "pending",
    },
    {
      ok: true,
      already_deleted: false,
      job_id: JOB_ID,
      cleanup_status: "completed",
      extra: 1,
    },
  ]) {
    assert.equal(parseDollDeleteAck(malformed), null);
  }
});

test("completed/canceled만 claim 없이 terminal이고 pending/leased는 재처리된다", () => {
  assert.equal(isCleanupTerminal("completed"), true);
  assert.equal(isCleanupTerminal("canceled"), true);
  assert.equal(isCleanupTerminal("pending"), false);
  assert.equal(isCleanupTerminal("leased"), false);
  assert.equal(
    cleanupJobToRun({ jobId: JOB_ID, cleanupStatus: "pending" }),
    JOB_ID,
  );
  assert.equal(
    cleanupJobToRun({ jobId: JOB_ID, cleanupStatus: "leased" }),
    JOB_ID,
  );
  assert.equal(
    cleanupJobToRun({ jobId: JOB_ID, cleanupStatus: "completed" }),
    null,
  );
  assert.equal(
    cleanupJobToRun({ jobId: JOB_ID, cleanupStatus: "canceled" }),
    null,
  );
  assert.equal(
    cleanupJobToRun({ jobId: null, cleanupStatus: "completed" }),
    null,
  );
});

test("doll role ack는 exact echoed role 외에는 성공이 아니다", () => {
  assert.equal(
    parseDollRoleUpdateAck({ ok: true, role: "teamlead" }, "teamlead"),
    true,
  );
  for (const malformed of [
    null,
    { ok: true, role: "boss" },
    { ok: false, role: "teamlead" },
    { ok: true },
    { ok: true, role: "teamlead", extra: true },
  ]) {
    assert.equal(parseDollRoleUpdateAck(malformed, "teamlead"), false);
  }
});

test("doll delete HTTP ack는 완료와 durable pending만 구분해 승인한다", () => {
  assert.deepEqual(
    parseDollDeleteHttpAck({ ok: true, cleanup: "completed" }),
    { ok: true, cleanup: "completed" },
  );
  assert.deepEqual(
    parseDollDeleteHttpAck({ accepted: true, cleanup: "pending" }),
    { accepted: true, cleanup: "pending" },
  );
  for (const malformed of [
    null,
    { ok: true },
    { accepted: true },
    { ok: true, cleanup: "pending" },
    { accepted: true, cleanup: "completed" },
    { ok: true, cleanup: "completed", error: "late_failure" },
  ]) {
    assert.equal(parseDollDeleteHttpAck(malformed), null);
  }
});

test("gallery clients validate exact delete and role acknowledgements", () => {
  const gallery = readFileSync(
    new URL("../../app/gallery/page.tsx", import.meta.url),
    "utf8",
  );
  const card = readFileSync(
    new URL("../../components/gallery/DollCard.tsx", import.meta.url),
    "utf8",
  );
  assert.match(gallery, /parseDollDeleteHttpAck\(body\)/);
  assert.match(card, /parseDollRoleUpdateAck\(body, next\)/);
  assert.doesNotMatch(card, /if \(!r\.ok\) \{/);
});
