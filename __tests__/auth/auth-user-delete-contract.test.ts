import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const { deleteAuthUserAcceptingMissing, isMissingAuthUserError } = await import(
  "../../lib/anon-data-migration.ts"
);

/**
 * GoTrue admin 삭제 계약(v1.00 버그의 재발 방지 정본) — 성공 응답은 user 를 되돌려주지
 * 않으므로 판정은 오류 유무로만 한다. mock 은 실계약 형태만 쓴다(자기일관 함정 금지).
 */

type FakeDeleteResult = { data: { user: unknown }; error: unknown };

function fakeAdmin(result: FakeDeleteResult, calls: string[]) {
  return {
    auth: {
      admin: {
        deleteUser: async (id: string) => {
          calls.push(id);
          return result;
        },
      },
    },
  } as unknown as Parameters<typeof deleteAuthUserAcceptingMissing>[0];
}

test("delete succeeds on the real GoTrue success shape — empty user, null error", async () => {
  const calls: string[] = [];
  const outcome = await deleteAuthUserAcceptingMissing(
    fakeAdmin({ data: { user: null }, error: null }, calls),
    "11111111-1111-4111-8111-111111111111",
  );
  assert.deepEqual(outcome, { ok: true });
  assert.deepEqual(calls, ["11111111-1111-4111-8111-111111111111"]);
});

test("missing user is idempotent success; real errors surface unchanged", async () => {
  const missing = await deleteAuthUserAcceptingMissing(
    fakeAdmin(
      {
        data: { user: null },
        error: { code: "user_not_found", message: "User not found" },
      },
      [],
    ),
    "22222222-2222-4222-8222-222222222222",
  );
  assert.deepEqual(missing, { ok: true });

  const boom = { code: "unexpected_failure", message: "boom", status: 500 };
  const failed = await deleteAuthUserAcceptingMissing(
    fakeAdmin({ data: { user: null }, error: boom }, []),
    "33333333-3333-4333-8333-333333333333",
  );
  assert.deepEqual(failed, { ok: false, error: boom });
});

test("isMissingAuthUserError covers both GoTrue missing-user shapes and nothing broader", () => {
  assert.equal(isMissingAuthUserError({ code: "user_not_found" }), true);
  assert.equal(isMissingAuthUserError({ message: "User not found" }), true);
  assert.equal(
    isMissingAuthUserError({ message: "user with id 123 not found" }),
    true,
  );
  assert.equal(isMissingAuthUserError({ message: "not found user" }), false);
  assert.equal(isMissingAuthUserError({ code: "unexpected_failure" }), false);
  assert.equal(isMissingAuthUserError(null), false);
  assert.equal(isMissingAuthUserError("user not found"), false);
});

test("cleanup-job keeps its stronger read-after-delete saga on purpose", () => {
  // 응답 무시+삭제 후 재조회는 헬퍼보다 강한 확정이 필요한 유일한 소비처 —
  // '삭제 계약 단일화' 명목으로 이 saga 를 헬퍼로 약화시키지 않는다.
  const cleanup = readFileSync("lib/oauth-anon-auth-cleanup-job.ts", "utf8");
  assert.match(
    cleanup,
    /await admin\.auth\.admin\.deleteUser\(lease\.sourceUserId\);/,
  );
  assert.match(cleanup, /readFreshAuthUser\(admin, lease\.sourceUserId\)/);
});
