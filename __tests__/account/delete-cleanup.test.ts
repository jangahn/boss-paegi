// delete-cleanup.test.ts — 외부 서비스 없이 계정 탈퇴/얼굴 임시파일 정리의
// `{ error }` silent failure 회귀를 fault injection으로 검증한다.
// 실행: node --test __tests__/account/delete-cleanup.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  AccountDeleteCleanupError,
  cleanupDeletedAccountAssets,
  parseAccountDeletionCleanupManifest,
  uploadedAvatarPath,
  type AccountDeleteCleanupDependencies,
} from "../../lib/account-delete-cleanup.ts";
import {
  listStorageObjectsPaginated,
  removeStorageObjects,
  storagePathBatches,
  SupabaseOperationError,
} from "../../lib/supabase-operation.ts";
import { deletedEmailMarker } from "../../lib/oauth-metadata.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";
const SCORE_ID = "00000000-0000-4000-8000-000000000002";
const DOLL_ID = "00000000-0000-4000-8000-000000000003";
const HIGHLIGHT_ID = "00000000-0000-4000-8000-000000000004";
const LATE_DOLL_ID = "00000000-0000-4000-8000-000000000099";

const absent = async () => ({ data: false, error: null });
const removed = async (paths: string[]) => ({
  data: paths.map((name) => ({ name })),
  error: null,
});
const scrubbedAuth = async () => ({
  data: {
    user: {
      id: USER_ID,
      email: deletedEmailMarker(USER_ID),
      user_metadata: {},
    },
  },
  error: null,
});

test("업로드 avatar URL은 RPC 전에 본인 버킷 경로로 복원한다", () => {
  assert.equal(
    uploadedAvatarPath(
      `https://project.supabase.co/storage/v1/object/public/avatars/${USER_ID}/avatar.jpg?cache=1`,
      USER_ID,
    ),
    `${USER_ID}/avatar.jpg`,
  );
  assert.equal(
    uploadedAvatarPath(`${USER_ID}/nested/avatar.webp#v2`, USER_ID),
    `${USER_ID}/nested/avatar.webp`,
  );
});

test("OAuth·기본·타 사용자 avatar는 Storage 삭제 대상으로 만들지 않는다", () => {
  assert.equal(
    uploadedAvatarPath("https://k.kakaocdn.net/avatar.jpg", USER_ID),
    null,
  );
  assert.equal(uploadedAvatarPath("/avatars/default.png", USER_ID), null);
  assert.equal(
    uploadedAvatarPath(
      "https://project.supabase.co/storage/v1/object/public/avatars/another-user/avatar.jpg",
      USER_ID,
    ),
    null,
  );
  assert.equal(uploadedAvatarPath(`${USER_ID}/../other-user/avatar.jpg`, USER_ID), null);
});

test("Storage remove가 reject하지 않고 { error }를 반환해도 실패로 승격한다", async () => {
  await assert.rejects(
    removeStorageObjects(
      "gen.face_cleanup",
      [`tmp/face/${USER_ID}/generation.jpg`],
      async () => ({
        data: null,
        error: new Error("injected remove failure"),
      }),
      absent,
    ),
    (error: unknown) => {
      assert.ok(error instanceof SupabaseOperationError);
      assert.equal(error.operation, "gen.face_cleanup");
      assert.match(
        String((error.operationError as Error).message),
        /injected remove failure/,
      );
      return true;
    },
  );
});

test("Storage remove는 exact ack와 실제 부재가 모두 증명되어야 완료된다", async () => {
  const path = `${USER_ID}/${DOLL_ID}.png`;

  await assert.rejects(
    removeStorageObjects(
      "storage.remove",
      [path],
      async () => ({ data: [{ name: `${USER_ID}/${LATE_DOLL_ID}.png` }], error: null }),
      absent,
    ),
    (error: unknown) => {
      assert.ok(error instanceof SupabaseOperationError);
      assert.equal(error.operation, "storage.remove");
      return true;
    },
  );

  await assert.rejects(
    removeStorageObjects(
      "storage.remove",
      [path],
      async () => ({ data: [{ name: path }], error: null }),
      async () => ({ data: true, error: null }),
    ),
    (error: unknown) => {
      assert.ok(error instanceof SupabaseOperationError);
      assert.equal(error.operation, "storage.remove.verify_absent");
      return true;
    },
  );

  await removeStorageObjects(
    "storage.remove",
    [path],
    async () => ({ data: [], error: null }),
    async () => ({
      data: false,
      error: { statusCode: "404", message: "not found" },
    }),
  );
});

test("Storage remove는 traversal 경로를 호출 전에 거부한다", async () => {
  let calls = 0;
  await assert.rejects(
    removeStorageObjects(
      "storage.remove",
      [`${USER_ID}/../other/${DOLL_ID}.png`],
      async (paths) => {
        calls += 1;
        return removed(paths);
      },
      absent,
    ),
    /storage\.remove failed/,
  );
  assert.equal(calls, 0);
});

test("Storage list pagination은 100개 경계를 넘어 offset으로 전수 수집한다", async () => {
  const objects = Array.from({ length: 205 }, (_, index) => ({
    name: `${index}.jpg`,
  }));
  const offsets: number[] = [];
  const listed = await listStorageObjectsPaginated(
    "storage.test.list",
    async ({ limit, offset }) => {
      offsets.push(offset);
      return {
        data: objects.slice(offset, offset + limit),
        error: null,
      };
    },
  );

  assert.equal(listed.length, 205);
  assert.deepEqual(offsets, [0, 100, 200]);
  assert.equal(listed[204]?.name, "204.jpg");
});

test("remove batching은 중복을 제거하고 100개 이하 묶음으로 전수 분할한다", () => {
  const paths = [
    ...Array.from({ length: 205 }, (_, index) => `p/${index}`),
    "p/0",
  ];
  const batches = storagePathBatches(paths);
  assert.deepEqual(
    batches.map((batch) => batch.length),
    [100, 100, 5],
  );
  assert.equal(new Set(batches.flat()).size, 205);
});

test("cleanup manifest는 배열/nullable avatar 계약을 엄격히 검증한다", () => {
  assert.deepEqual(
    parseAccountDeletionCleanupManifest({
      dolls: [`${USER_ID}/${DOLL_ID}.png`, `${USER_ID}/${DOLL_ID}.png`],
      highlights: [`${SCORE_ID}/${HIGHLIGHT_ID}.webm`],
      avatar: null,
    }, USER_ID),
    {
      dolls: [`${USER_ID}/${DOLL_ID}.png`],
      highlights: [`${SCORE_ID}/${HIGHLIGHT_ID}.webm`],
      avatar: null,
    },
  );
  assert.throws(
    () =>
      parseAccountDeletionCleanupManifest({
        dolls: "a",
        highlights: [],
        avatar: null,
      }, USER_ID),
    /manifest\.dolls/,
  );
  assert.throws(
    () =>
      parseAccountDeletionCleanupManifest({
        dolls: [],
        highlights: [],
        avatar: 1,
      }, USER_ID),
    /manifest\.avatar/,
  );
});

test("cleanup manifest는 타 사용자·비소유 prefix를 삭제 대상으로 승인하지 않는다", () => {
  const otherUser = "00000000-0000-4000-8000-000000000005";
  assert.throws(
    () =>
      parseAccountDeletionCleanupManifest(
        {
          dolls: [`${otherUser}/${DOLL_ID}.png`],
          highlights: [],
          avatar: null,
        },
        USER_ID,
      ),
    /doll path/,
  );
  assert.throws(
    () =>
      parseAccountDeletionCleanupManifest(
        {
          dolls: [],
          highlights: [],
          avatar: `${otherUser}/avatar.jpg`,
        },
        USER_ID,
      ),
    /avatar path/,
  );
  assert.throws(
    () =>
      parseAccountDeletionCleanupManifest(
        {
          dolls: [],
          highlights: [`${SCORE_ID}/../${HIGHLIGHT_ID}.webm`],
          avatar: null,
        },
        USER_ID,
      ),
    /storage path/,
  );
});

test("정상 정리는 confirmed/candidate/tmp/highlight/avatar/auth를 모두 수행한다", async () => {
  const removeCalls: { bucket: string; paths: string[] }[] = [];
  const listCalls: { bucket: string; prefix: string }[] = [];
  let authCalls = 0;

  const dependencies: AccountDeleteCleanupDependencies = {
    async list(bucket, prefix) {
      listCalls.push({ bucket, prefix });
      if (bucket === "dolls" && prefix === USER_ID) {
        return {
          data: [
            { name: `${LATE_DOLL_ID}.png` },
            { name: "candidates" },
            { name: "not-a-doll.webp" },
          ],
          error: null,
        };
      }
      if (prefix === `${USER_ID}/candidates`) {
        return { data: [{ name: "generation-1" }], error: null };
      }
      if (prefix === `${USER_ID}/candidates/generation-1`) {
        return {
          data: [{ name: "0.png" }, { name: "1.png" }],
          error: null,
        };
      }
      if (prefix === `tmp/face/${USER_ID}`) {
        return { data: [{ name: "generation-1.jpg" }], error: null };
      }
      if (prefix === SCORE_ID) {
        return { data: [{ name: "late-upload.webm" }], error: null };
      }
      if (bucket === "avatars" && prefix === USER_ID) {
        return { data: [{ name: "late-avatar.webp" }], error: null };
      }
      return { data: [], error: null };
    },
    async remove(bucket, paths) {
      removeCalls.push({ bucket, paths });
      return {
        data: paths.map((name) => ({ name })),
        error: null,
      };
    },
    exists: absent,
    async scrubAuth() {
      authCalls += 1;
      return scrubbedAuth();
    },
    readAuth: scrubbedAuth,
  };

  await cleanupDeletedAccountAssets({
    userId: USER_ID,
    dollPaths: [`${USER_ID}/${DOLL_ID}.png`, `${USER_ID}/${DOLL_ID}.png`],
    highlightPaths: [`${SCORE_ID}/${HIGHLIGHT_ID}.webm`],
    highlightScoreIds: [SCORE_ID],
    avatarPath: `${USER_ID}/avatar.jpg`,
    dependencies,
  });

  assert.deepEqual(listCalls, [
    { bucket: "dolls", prefix: USER_ID },
    { bucket: "dolls", prefix: `${USER_ID}/candidates` },
    { bucket: "dolls", prefix: `${USER_ID}/candidates/generation-1` },
    { bucket: "dolls", prefix: `tmp/face/${USER_ID}` },
    { bucket: "highlights", prefix: SCORE_ID },
    { bucket: "avatars", prefix: USER_ID },
  ]);
  assert.deepEqual(removeCalls, [
    { bucket: "dolls", paths: [`${USER_ID}/${DOLL_ID}.png`] },
    { bucket: "dolls", paths: [`${USER_ID}/${LATE_DOLL_ID}.png`] },
    {
      bucket: "dolls",
      paths: [
        `${USER_ID}/candidates/generation-1/0.png`,
        `${USER_ID}/candidates/generation-1/1.png`,
      ],
    },
    {
      bucket: "dolls",
      paths: [`tmp/face/${USER_ID}/generation-1.jpg`],
    },
    {
      bucket: "highlights",
      paths: [`${SCORE_ID}/${HIGHLIGHT_ID}.webm`],
    },
    {
      bucket: "highlights",
      paths: [`${SCORE_ID}/late-upload.webm`],
    },
    { bucket: "avatars", paths: [`${USER_ID}/avatar.jpg`] },
    { bucket: "avatars", paths: [`${USER_ID}/late-avatar.webp`] },
  ]);
  assert.equal(authCalls, 1);
});

test("candidate/tmp가 각각 100개를 넘어도 pagination+batch remove로 전수 정리한다", async () => {
  const candidateFiles = Array.from({ length: 205 }, (_, index) => ({
    name: `${index}.png`,
  }));
  const dollFiles = Array.from({ length: 202 }, (_, index) => ({
    name: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}.png`,
  }));
  const faceFiles = Array.from({ length: 201 }, (_, index) => ({
    name: `${index}.jpg`,
  }));
  const highlightFiles = Array.from({ length: 205 }, (_, index) => ({
    name: `${index}.webm`,
  }));
  const avatarFiles = Array.from({ length: 203 }, (_, index) => ({
    name: `${index}.webp`,
  }));
  const removed: string[] = [];
  const listOffsets = new Map<string, number[]>();

  const dependencies: AccountDeleteCleanupDependencies = {
    async list(bucket, prefix, { limit, offset }) {
      const listKey = `${bucket}:${prefix}`;
      const offsets = listOffsets.get(listKey) ?? [];
      offsets.push(offset);
      listOffsets.set(listKey, offsets);
      if (prefix === `${USER_ID}/candidates`) {
        return {
          data: offset === 0 ? [{ name: "generation-1" }] : [],
          error: null,
        };
      }
      const source =
        bucket === "dolls" && prefix === USER_ID
          ? dollFiles
          : prefix === `${USER_ID}/candidates/generation-1`
          ? candidateFiles
          : prefix === `tmp/face/${USER_ID}`
            ? faceFiles
            : prefix === SCORE_ID
              ? highlightFiles
              : bucket === "avatars" && prefix === USER_ID
                ? avatarFiles
                : [];
      return { data: source.slice(offset, offset + limit), error: null };
    },
    async remove(_bucket, paths) {
      removed.push(...paths);
      return {
        data: paths.map((name) => ({ name })),
        error: null,
      };
    },
    exists: absent,
    scrubAuth: scrubbedAuth,
    readAuth: scrubbedAuth,
  };

  await cleanupDeletedAccountAssets({
    userId: USER_ID,
    dollPaths: [],
    highlightPaths: [],
    highlightScoreIds: [SCORE_ID],
    avatarPath: null,
    dependencies,
  });

  assert.deepEqual(
    listOffsets.get(`dolls:${USER_ID}/candidates/generation-1`),
    [0, 100, 200],
  );
  assert.deepEqual(listOffsets.get(`dolls:${USER_ID}`), [0, 100, 200]);
  assert.deepEqual(
    listOffsets.get(`dolls:tmp/face/${USER_ID}`),
    [0, 100, 200],
  );
  assert.deepEqual(
    listOffsets.get(`highlights:${SCORE_ID}`),
    [0, 100, 200],
  );
  assert.deepEqual(
    listOffsets.get(`avatars:${USER_ID}`),
    [0, 100, 200],
  );
  assert.equal(
    removed.filter(
      (path) =>
        path.startsWith(`${USER_ID}/`) &&
        path.endsWith(".png") &&
        !path.includes("/candidates/"),
    ).length,
    202,
  );
  assert.equal(
    removed.filter((path) => path.includes("/candidates/")).length,
    205,
  );
  assert.equal(
    removed.filter((path) => path.startsWith("tmp/face/")).length,
    201,
  );
  assert.equal(
    removed.filter((path) => path.startsWith(`${SCORE_ID}/`)).length,
    205,
  );
  assert.equal(
    removed.filter((path) => path.startsWith(`${USER_ID}/`) && path.endsWith(".webp"))
      .length,
    203,
  );
});

test("Storage remove fault가 있어도 나머지 개인정보 정리와 auth scrub을 시도한 뒤 reject한다", async () => {
  const removedBuckets: string[] = [];
  let authCalls = 0;

  const dependencies: AccountDeleteCleanupDependencies = {
    async list(_bucket, prefix) {
      if (prefix === `${USER_ID}/candidates`) {
        return { data: [], error: null };
      }
      if (prefix === `tmp/face/${USER_ID}`) {
        return { data: [{ name: "face.jpg" }], error: null };
      }
      return { data: [], error: null };
    },
    async remove(bucket, paths) {
      removedBuckets.push(bucket);
      if (bucket === "dolls" && paths[0] === `${USER_ID}/${DOLL_ID}.png`) {
        return { data: null, error: new Error("injected dolls failure") };
      }
      return {
        data: paths.map((name) => ({ name })),
        error: null,
      };
    },
    exists: absent,
    async scrubAuth() {
      authCalls += 1;
      return scrubbedAuth();
    },
    readAuth: scrubbedAuth,
  };

  await assert.rejects(
    cleanupDeletedAccountAssets({
      userId: USER_ID,
      dollPaths: [`${USER_ID}/${DOLL_ID}.png`],
      highlightPaths: [`${SCORE_ID}/${HIGHLIGHT_ID}.webm`],
      highlightScoreIds: [SCORE_ID],
      avatarPath: `${USER_ID}/avatar.jpg`,
      dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AccountDeleteCleanupError);
      assert.deepEqual(
        error.failures.map((failure) => failure.operation),
        ["storage.dolls.remove"],
      );
      return true;
    },
  );

  assert.deepEqual(removedBuckets, [
    "dolls",
    "dolls",
    "highlights",
    "avatars",
  ]);
  assert.equal(authCalls, 1);
});

test("Storage list의 { error }도 누락된 정리로 간주하고 다른 단계 후 reject한다", async () => {
  const removedBuckets: string[] = [];
  let authCalls = 0;
  const dependencies: AccountDeleteCleanupDependencies = {
    async list(_bucket, prefix) {
      if (prefix === `${USER_ID}/candidates`) {
        return {
          data: null,
          error: new Error("injected candidate list failure"),
        };
      }
      return { data: [], error: null };
    },
    async remove(bucket) {
      removedBuckets.push(bucket);
      return { data: [], error: null };
    },
    exists: absent,
    async scrubAuth() {
      authCalls += 1;
      return scrubbedAuth();
    },
    readAuth: scrubbedAuth,
  };

  await assert.rejects(
    cleanupDeletedAccountAssets({
      userId: USER_ID,
      dollPaths: [],
      highlightPaths: [`${SCORE_ID}/${HIGHLIGHT_ID}.webm`],
      highlightScoreIds: [SCORE_ID],
      avatarPath: `${USER_ID}/avatar.jpg`,
      dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AccountDeleteCleanupError);
      assert.deepEqual(
        error.failures.map((failure) => failure.operation),
        ["storage.candidates.list"],
      );
      return true;
    },
  );

  assert.deepEqual(removedBuckets, ["highlights", "avatars"]);
  assert.equal(authCalls, 1);
});

test("RPC 전에 수집한 avatar 삭제의 { error }도 성공으로 삼지 않는다", async () => {
  const dependencies: AccountDeleteCleanupDependencies = {
    async list() {
      return { data: [], error: null };
    },
    async remove(bucket, paths) {
      return bucket === "avatars"
        ? { data: null, error: new Error("injected avatar remove failure") }
        : {
            data: paths.map((name) => ({ name })),
            error: null,
          };
    },
    exists: absent,
    scrubAuth: scrubbedAuth,
    readAuth: scrubbedAuth,
  };

  await assert.rejects(
    cleanupDeletedAccountAssets({
      userId: USER_ID,
      dollPaths: [],
      highlightPaths: [],
      highlightScoreIds: [],
      avatarPath: `${USER_ID}/avatar.jpg`,
      dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AccountDeleteCleanupError);
      assert.deepEqual(
        error.failures.map((failure) => failure.operation),
        ["storage.avatar.remove"],
      );
      return true;
    },
  );
});

test("auth admin API의 resolved { error }는 계정 삭제 성공으로 처리하지 않는다", async () => {
  const dependencies: AccountDeleteCleanupDependencies = {
    async list() {
      return { data: [], error: null };
    },
    async remove(_bucket, paths) {
      return {
        data: paths.map((name) => ({ name })),
        error: null,
      };
    },
    exists: absent,
    async scrubAuth() {
      return { data: null, error: new Error("injected auth failure") };
    },
    readAuth: scrubbedAuth,
  };

  await assert.rejects(
    cleanupDeletedAccountAssets({
      userId: USER_ID,
      dollPaths: [],
      highlightPaths: [],
      highlightScoreIds: [],
      avatarPath: null,
      dependencies,
    }),
    (error: unknown) => {
      assert.ok(error instanceof AccountDeleteCleanupError);
      assert.deepEqual(
        error.failures.map((failure) => failure.operation),
        ["auth.user_scrub"],
      );
      return true;
    },
  );
});

test("Auth user_metadata는 기존 키마다 null을 보내 실제 삭제한다", async () => {
  let readCalls = 0;
  let scrubKeys: readonly string[] = [];
  const dependencies: AccountDeleteCleanupDependencies = {
    async list() {
      return { data: [], error: null };
    },
    async remove(_bucket, paths) {
      return removed(paths);
    },
    exists: absent,
    async scrubAuth(userMetadataKeys) {
      scrubKeys = userMetadataKeys;
      return scrubbedAuth();
    },
    async readAuth() {
      readCalls += 1;
      if (readCalls === 1) {
        return {
          data: {
            user: {
              id: USER_ID,
              email: "identifying@example.com",
              user_metadata: {
                name: "Identifying Name",
                avatar_url: "https://example.com/identifying.png",
              },
            },
          },
          error: null,
        };
      }
      return scrubbedAuth();
    },
  };

  await cleanupDeletedAccountAssets({
    userId: USER_ID,
    dollPaths: [],
    highlightPaths: [],
    highlightScoreIds: [],
    avatarPath: null,
    dependencies,
  });

  assert.deepEqual(scrubKeys, ["name", "avatar_url"]);
  assert.equal(readCalls, 2);
});

test("Auth scrub ack와 fresh read postcondition은 서로 독립적으로 fail-closed한다", async () => {
  const base = {
    list: async () => ({ data: [], error: null }),
    remove: async (_bucket: string, paths: string[]) => removed(paths),
    exists: absent,
  };
  const input = {
    userId: USER_ID,
    dollPaths: [],
    highlightPaths: [],
    highlightScoreIds: [],
    avatarPath: null,
  } as const;

  await assert.rejects(
    cleanupDeletedAccountAssets({
      ...input,
      dependencies: {
        ...base,
        scrubAuth: async () => ({ data: { user: null }, error: null }),
        readAuth: scrubbedAuth,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AccountDeleteCleanupError);
      assert.deepEqual(
        error.failures.map((failure) => failure.operation),
        ["auth.user_scrub"],
      );
      return true;
    },
  );

  await assert.rejects(
    cleanupDeletedAccountAssets({
      ...input,
      dependencies: {
        ...base,
        scrubAuth: scrubbedAuth,
        readAuth: async () => ({
          data: {
            user: {
              id: USER_ID,
              email: "still-identifying@example.com",
              user_metadata: { name: "still-identifying" },
            },
          },
          error: null,
        }),
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AccountDeleteCleanupError);
      assert.deepEqual(
        error.failures.map((failure) => failure.operation),
        ["auth.user_scrub_verify"],
      );
      return true;
    },
  );
});

test("Storage list entry의 slash/traversal은 prefix 밖 삭제 전에 차단된다", async () => {
  const removeCalls: string[][] = [];
  await assert.rejects(
    cleanupDeletedAccountAssets({
      userId: USER_ID,
      dollPaths: [],
      highlightPaths: [],
      highlightScoreIds: [],
      avatarPath: null,
      dependencies: {
        async list(_bucket, prefix) {
          return {
            data:
              prefix === `${USER_ID}/candidates`
                ? [{ name: "../another-user" }]
                : [],
            error: null,
          };
        },
        async remove(_bucket, paths) {
          removeCalls.push(paths);
          return removed(paths);
        },
        exists: absent,
        scrubAuth: scrubbedAuth,
        readAuth: scrubbedAuth,
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof AccountDeleteCleanupError);
      assert.deepEqual(
        error.failures.map((failure) => failure.operation),
        ["storage.candidates.list"],
      );
      return true;
    },
  );
  assert.equal(removeCalls.flat().length, 0);
});
