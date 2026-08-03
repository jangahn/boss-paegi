// delete-cleanup.test.ts — 외부 서비스 없이 계정 탈퇴 정리 라이브 계약
// (manifest 검증·storage remove·auth scrub)의 `{ error }` silent failure
// 회귀를 fault injection으로 검증한다.
// 실행: node --test __tests__/account/delete-cleanup.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  AccountDeleteCleanupError,
  parseAccountDeletionCleanupManifest,
  removeAccountDeletionCleanupTargets,
  scrubDeletedAccountAuth,
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

test("cleanup target remove는 실패를 모아 던지되 다른 버킷을 끝까지 시도한다", async () => {
  const removedBuckets: string[] = [];
  await assert.rejects(
    removeAccountDeletionCleanupTargets(
      [
        { bucket: "dolls", path: `${USER_ID}/${DOLL_ID}.png` },
        { bucket: "dolls", path: `${USER_ID}/${DOLL_ID}.png` },
        { bucket: "highlights", path: `${SCORE_ID}/${HIGHLIGHT_ID}.webm` },
        { bucket: "avatars", path: `${USER_ID}/avatar.jpg` },
      ],
      {
        async remove(bucket, paths) {
          removedBuckets.push(bucket);
          if (bucket === "dolls") {
            return {
              data: null,
              error: new Error("injected dolls failure"),
            };
          }
          return removed(paths);
        },
        exists: absent,
      },
    ),
    (error: unknown) => {
      assert.ok(error instanceof AccountDeleteCleanupError);
      assert.deepEqual(
        error.failures.map((failure) => failure.operation),
        ["account.cleanup.storage_remove"],
      );
      return true;
    },
  );
  // 중복 target은 버킷당 1회로 dedup되고, dolls 실패 후에도 나머지 버킷을 시도한다.
  assert.deepEqual(removedBuckets, ["dolls", "highlights", "avatars"]);
});

test("auth admin API의 resolved { error }는 scrub 성공으로 처리하지 않는다", async () => {
  await assert.rejects(
    scrubDeletedAccountAuth(USER_ID, {
      scrubAuth: async () => ({
        data: null,
        error: new Error("injected auth failure"),
      }),
      readAuth: scrubbedAuth,
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

  await scrubDeletedAccountAuth(USER_ID, {
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
  });

  assert.deepEqual(scrubKeys, ["name", "avatar_url"]);
  assert.equal(readCalls, 2);
});

test("Auth scrub ack와 fresh read postcondition은 서로 독립적으로 fail-closed한다", async () => {
  await assert.rejects(
    scrubDeletedAccountAuth(USER_ID, {
      scrubAuth: async () => ({ data: { user: null }, error: null }),
      readAuth: scrubbedAuth,
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
    scrubDeletedAccountAuth(USER_ID, {
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
