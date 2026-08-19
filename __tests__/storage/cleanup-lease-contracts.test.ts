import test from "node:test";
import assert from "node:assert/strict";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  parseAccountDeletionCleanupLease,
  parseAccountDeletionStart,
} = await import(
  "../../lib/account-delete-cleanup-job.ts"
);
const {
  moderationPurgeHttpStatus,
  parseModerationPurgeLease,
  parseModerationPurgeStatus,
} = await import("../../lib/moderation-purge-job.ts");
const { parseStorageCleanupLease } = await import(
  "../../lib/storage-cleanup-jobs.ts"
);

const JOB_ID = "00000000-0000-4000-8000-000000000001";
const USER_ID = "00000000-0000-4000-8000-000000000002";
const SUBJECT_ID = "00000000-0000-4000-8000-000000000003";
const OBJECT_ID = "00000000-0000-4000-8000-000000000004";
const LEASE_TOKEN = "00000000-0000-4000-8000-000000000005";

function uploadLease(overrides: Record<string, unknown> = {}) {
  return {
    job_id: JOB_ID,
    owner_user_id: USER_ID,
    subject_id: SUBJECT_ID,
    purpose: "highlight_upload",
    bucket: "highlights",
    path: `${SUBJECT_ID}/${OBJECT_ID}.webm`,
    lease_token: LEASE_TOKEN,
    lease_version: 2,
    attempt_count: 3,
    ...overrides,
  };
}

function objectLease(overrides: Record<string, unknown> = {}) {
  return {
    job_id: JOB_ID,
    kind: "doll_delete",
    user_id: USER_ID,
    subject_id: SUBJECT_ID,
    bucket: "dolls",
    path: `${USER_ID}/${SUBJECT_ID}.png`,
    lease_token: LEASE_TOKEN,
    lease_version: 2,
    attempt_count: 3,
    ...overrides,
  };
}

test("storage cleanup lease는 fence와 owner/subject/path를 한 계약으로 검증한다", () => {
  assert.deepEqual(parseStorageCleanupLease(uploadLease(), "upload"), {
    jobId: JOB_ID,
    bucket: "highlights",
    path: `${SUBJECT_ID}/${OBJECT_ID}.webm`,
    leaseToken: LEASE_TOKEN,
    leaseVersion: 2,
    attemptCount: 3,
  });
  assert.deepEqual(parseStorageCleanupLease(objectLease(), "object"), {
    jobId: JOB_ID,
    bucket: "dolls",
    path: `${USER_ID}/${SUBJECT_ID}.png`,
    leaseToken: LEASE_TOKEN,
    leaseVersion: 2,
    attemptCount: 3,
  });

  for (const malformed of [
    uploadLease({ owner_user_id: "not-a-uuid" }),
    uploadLease({ subject_id: USER_ID }),
    uploadLease({ path: `${SUBJECT_ID}/../${OBJECT_ID}.webm` }),
    uploadLease({ bucket: "dolls" }),
    uploadLease({ purpose: "unknown" }),
    uploadLease({ lease_token: "not-a-uuid" }),
    uploadLease({ lease_version: 0 }),
    uploadLease({ attempt_count: 1.5 }),
  ]) {
    assert.throws(
      () => parseStorageCleanupLease(malformed, "upload"),
      /invalid storage cleanup/,
    );
  }

  // 이전(flow-scoped migration)받은 doll: 폴더=원 소유자 uuid, user_id=현 소유자.
  // 폴더는 현재 user_id 와 상관하지 않는다 — 파일명=subject 상관만 강제(2026-08-19
  // poison-job 실사고의 수정 계약).
  assert.ok(
    parseStorageCleanupLease(objectLease({ user_id: OBJECT_ID }), "object"),
  );

  for (const malformed of [
    objectLease({ subject_id: OBJECT_ID }),
    objectLease({ path: `${USER_ID}/${OBJECT_ID}.png` }),
    objectLease({ path: `not-a-uuid/${SUBJECT_ID}.png` }),
    objectLease({ path: `../${USER_ID}/${SUBJECT_ID}.png` }),
    objectLease({ kind: "unknown" }),
  ]) {
    assert.throws(
      () => parseStorageCleanupLease(malformed, "object"),
      /invalid storage cleanup/,
    );
  }
});

test("site/event/avatar upload lease도 purpose별 exact path만 허용한다", () => {
  assert.ok(
    parseStorageCleanupLease(
      uploadLease({
        subject_id: null,
        purpose: "site_asset_og",
        bucket: "site-assets",
        path: `og/260729/${OBJECT_ID}.webp`,
      }),
      "upload",
    ),
  );
  assert.ok(
    parseStorageCleanupLease(
      uploadLease({
        subject_id: null,
        purpose: "event_image",
        bucket: "events",
        path: `260729/${OBJECT_ID}.gif`,
      }),
      "upload",
    ),
  );
  assert.ok(
    parseStorageCleanupLease(
      uploadLease({
        subject_id: null,
        purpose: "avatar_upload",
        bucket: "avatars",
        path: `${USER_ID}/${OBJECT_ID}.jpg`,
      }),
      "upload",
    ),
  );
  assert.throws(() =>
    parseStorageCleanupLease(
      uploadLease({
        subject_id: null,
        purpose: "avatar_upload",
        bucket: "avatars",
        path: `${SUBJECT_ID}/${OBJECT_ID}.jpg`,
      }),
      "upload",
    ),
  );
});

test("moderation purge lease는 canonical bucket/path와 fence만 승인한다", () => {
  const value = {
    job_id: JOB_ID,
    doll_id: SUBJECT_ID,
    manifest: [
      { bucket: "dolls", path: `${USER_ID}/${SUBJECT_ID}.png` },
      { bucket: "highlights", path: `${OBJECT_ID}/${JOB_ID}.webm` },
    ],
    lease_token: LEASE_TOKEN,
    lease_version: 4,
    attempt_count: 1,
  };
  assert.equal(parseModerationPurgeLease(value)?.targets.length, 2);

  assert.throws(() =>
    parseModerationPurgeLease({
      ...value,
      manifest: [
        { bucket: "dolls", path: `${USER_ID}/${OBJECT_ID}.png` },
      ],
    }),
  );
  assert.throws(() =>
    parseModerationPurgeLease({
      ...value,
      manifest: [
        { bucket: "dolls", path: `${USER_ID}/${SUBJECT_ID}.png` },
        { bucket: "dolls", path: `${USER_ID}/${SUBJECT_ID}.png` },
      ],
    }),
  );
  assert.throws(() =>
    parseModerationPurgeLease({
      ...value,
      manifest: [{ bucket: "dolls", path: `${USER_ID}/../x.png` }],
    }),
  );
  assert.throws(() =>
    parseModerationPurgeLease({
      ...value,
      manifest: Array.from({ length: 101 }, (_, index) => ({
        bucket: "highlights",
        path: `${OBJECT_ID}/${index}.webm`,
      })),
    }),
  );
});

test("account deletion lease는 최대 100개 owner-prefix target과 Auth action만 승인한다", () => {
  const value = {
    job_id: JOB_ID,
    user_id: USER_ID,
    targets: [
      { bucket: "dolls", path: `${USER_ID}/objects/candidate.png` },
      { bucket: "dolls", path: `tmp/face/${USER_ID}/source.jpg` },
      { bucket: "avatars", path: `${USER_ID}/avatar.webp` },
      { bucket: "highlights", path: `${OBJECT_ID}/orphan.webm` },
    ],
    generation_ids: [SUBJECT_ID],
    lease_token: LEASE_TOKEN,
    lease_version: 3,
    attempt_count: 4,
    scrub_auth: false,
  };
  assert.deepEqual(parseAccountDeletionCleanupLease(value), {
    jobId: JOB_ID,
    userId: USER_ID,
    targets: value.targets,
    generationIds: value.generation_ids,
    leaseToken: LEASE_TOKEN,
    leaseVersion: 3,
    attemptCount: 4,
    scrubAuth: false,
  });
  for (const malformed of [
    { ...value, lease_version: 0 },
    { ...value, scrub_auth: "false" },
    {
      ...value,
      generation_ids: Array.from(
        { length: 101 },
        (_, index) =>
          `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`,
      ),
    },
    {
      ...value,
      targets: [{ bucket: "avatars", path: `${SUBJECT_ID}/avatar.webp` }],
    },
    {
      ...value,
      targets: [{ bucket: "dolls", path: `tmp/face/${SUBJECT_ID}/x.jpg` }],
    },
    {
      ...value,
      targets: Array.from({ length: 101 }, (_, index) => ({
        bucket: "dolls",
        path: `${USER_ID}/objects/${index}.png`,
      })),
    },
  ]) {
    assert.throws(
      () => parseAccountDeletionCleanupLease(malformed),
      /invalid account/,
    );
  }
});

test("완료 응답 유실 재시도는 idle claim을 terminal status로 200 복구한다", () => {
  const terminal = parseModerationPurgeStatus(
    {
      ok: true,
      job_id: JOB_ID.toUpperCase(),
      doll_id: SUBJECT_ID.toUpperCase(),
      status: "completed",
      attempt_count: 1,
    },
    JOB_ID,
    SUBJECT_ID,
  );
  assert.deepEqual(terminal, {
    jobId: JOB_ID,
    dollId: SUBJECT_ID,
    status: "completed",
    attemptCount: 1,
  });

  // The first delivery completed Storage+finish but its HTTP response was
  // lost. Its immutable begin receipt replays the same job; completed jobs are
  // unclaimable (idle), so the correlated terminal read is what makes retry
  // return HTTP 200 rather than an eternal 202.
  assert.equal(
    moderationPurgeHttpStatus(
      { kind: "completed", jobId: JOB_ID, attemptCount: 1 },
      null,
    ),
    200,
  );
  assert.equal(moderationPurgeHttpStatus({ kind: "idle" }, terminal), 200);
  assert.equal(
    moderationPurgeHttpStatus(
      { kind: "idle" },
      { ...terminal, status: "leased" },
    ),
    202,
  );
  assert.equal(moderationPurgeHttpStatus({ kind: "idle" }, null), 202);

  for (const malformed of [
    { ...terminal, ok: true, job_id: OBJECT_ID, doll_id: SUBJECT_ID },
    { ...terminal, ok: true, job_id: JOB_ID, doll_id: OBJECT_ID },
    {
      ...terminal,
      ok: true,
      job_id: JOB_ID,
      doll_id: SUBJECT_ID,
      status: "unknown",
    },
    {
      ...terminal,
      ok: true,
      job_id: JOB_ID,
      doll_id: SUBJECT_ID,
      attempt_count: -1,
    },
  ]) {
    assert.throws(() =>
      parseModerationPurgeStatus(malformed, JOB_ID, SUBJECT_ID),
    );
  }
});

test("account deletion 시작 ack는 exact user/job/manifest correlation을 요구한다", () => {
  const value = {
    ok: true,
    job_id: JOB_ID,
    user_id: USER_ID,
    cleanup_status: "pending",
    manifest: {
      dolls: [`${USER_ID}/${SUBJECT_ID}.png`],
      highlights: [`${OBJECT_ID}/${JOB_ID}.webm`],
      avatar: `${USER_ID}/avatar.webp`,
    },
  };
  assert.equal(parseAccountDeletionStart(value, USER_ID).jobId, JOB_ID);
  assert.throws(() =>
    parseAccountDeletionStart({ ...value, user_id: OBJECT_ID }, USER_ID),
  );
  assert.throws(() =>
    parseAccountDeletionStart({ ...value, ok: false }, USER_ID),
  );
  assert.throws(() =>
    parseAccountDeletionStart(
      {
        ...value,
        manifest: {
          ...value.manifest,
          dolls: [`${OBJECT_ID}/${SUBJECT_ID}.png`],
        },
      },
      USER_ID,
    ),
  );
});
