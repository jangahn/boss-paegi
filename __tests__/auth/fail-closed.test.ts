// fail-closed.test.ts — Auth/consent DB read와 익명 migration 재시도 정책의 순수 fault-injection 회귀.
// 실행: node --test __tests__/auth/fail-closed.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  isInvalidSessionReadError,
  prepareAnonMigration,
  resolveAdminAuthorityRead,
  resolveAuthUserRead,
  resolveConsentMutation,
  resolveDbRead,
  resolveRequiredDbRead,
} from "../../lib/auth-read-policy.ts";
import { resolveSignupBonusStrict } from "../../lib/signup-bonus.ts";
import type { ConsentMember } from "../../lib/consent.ts";

const CONSENTED_MEMBER: Exclude<ConsentMember, null> = {
  age_confirmed_at: "2026-07-29T00:00:00.000Z",
  terms_agreed_at: "2026-07-29T00:00:00.000Z",
  privacy_agreed_at: "2026-07-29T00:00:00.000Z",
};

test("auth.getUser missing/invalid session만 unauthorized이고 dependency 오류는 unavailable이다", () => {
  assert.deepEqual(
    resolveAuthUserRead({
      data: { user: null },
      error: { name: "AuthSessionMissingError", __isAuthError: true },
    }),
    {
      ok: false,
      kind: "unauthorized",
      error: { name: "AuthSessionMissingError", __isAuthError: true },
    },
  );
  const invalidJwt = { name: "AuthInvalidJwtError", code: "invalid_jwt" };
  assert.deepEqual(
    resolveAuthUserRead({ data: { user: null }, error: invalidJwt }),
    { ok: false, kind: "unauthorized", error: invalidJwt },
  );
  const dependency = { code: "request_timeout", status: 503 };
  assert.deepEqual(
    resolveAuthUserRead({ data: { user: null }, error: dependency }),
    { ok: false, kind: "unavailable", error: dependency },
  );
});

test("auth session rejection은 exact code/error_code만 인정하고 retryable HTTP는 보존한다", () => {
  for (const error of [
    { code: "session_not_found", status: 401 },
    { error_code: "invalid_jwt", status: 400 },
    { code: "user_banned", status: 403 },
    { error_code: "refresh_token_not_found", status: 422 },
  ]) {
    assert.equal(isInvalidSessionReadError(error), true);
    const resolved = resolveAuthUserRead({
      data: { user: null },
      error,
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) {
      throw new Error("expected_unauthorized_auth_read");
    }
    assert.equal(resolved.kind, "unauthorized");
  }

  for (const error of [
    { code: "session_not_found", status: 503 },
    { error_code: "invalid_jwt", status: 429 },
    {
      name: "AuthSessionMissingError",
      __isAuthError: true,
      status: 503,
    },
    { code: "session_not_found", status: "503" },
    { code: "request_timeout", status: 408 },
    new TypeError("network unavailable"),
  ]) {
    assert.equal(isInvalidSessionReadError(error), false);
    const resolved = resolveAuthUserRead({
      data: { user: null },
      error,
    });
    assert.equal(resolved.ok, false);
    if (resolved.ok) {
      throw new Error("expected_unavailable_auth_read");
    }
    assert.equal(resolved.kind, "unavailable");
  }
});

test("auth.getUser가 data와 error를 함께 resolve해도 dependency error가 이긴다", () => {
  const user = { id: "user" };
  const error = new Error("gateway failure");
  assert.deepEqual(
    resolveAuthUserRead({ data: { user }, error }),
    { ok: false, kind: "unavailable", error },
  );
  assert.deepEqual(
    resolveAuthUserRead({ data: { user }, error: null }),
    { ok: true, user },
  );
});

test("signup bonus config throw는 회원 INSERT 전에 fail-closed한다", async () => {
  await assert.rejects(
    () =>
      resolveSignupBonusStrict(
      "google",
      async () => {
        throw new Error("injected config cache failure");
      },
    ),
    /injected config cache failure/,
  );
  assert.equal(
    await resolveSignupBonusStrict(
      "email",
      async () => ({ signupBonusCredits: 9 }),
    ),
    0,
  );
});

test("successful no-row와 resolved { error }를 구분한다", () => {
  const noRow = resolveDbRead("profile", { data: null, error: null });
  assert.deepEqual(noRow, { ok: true, data: null });

  const injected = new Error("injected profile read failure");
  const failed = resolveDbRead("profile", { data: null, error: injected });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.source, "profile");
    assert.equal(failed.error, injected);
  }
});

test("필수 profile read의 성공+no-row도 삭제 판정 불가로 차단한다", () => {
  const missing = resolveRequiredDbRead("profile", {
    data: null,
    error: null,
  });
  assert.equal(missing.ok, false);
  if (!missing.ok) {
    assert.equal(missing.source, "profile");
    assert.match(String((missing.error as Error).message), /profile_row_missing/);
  }
});

test("member read가 data를 함께 돌려줘도 { error }가 있으면 fail-closed다", () => {
  const injected = new Error("injected member read failure");
  const failed = resolveDbRead("member", {
    data: CONSENTED_MEMBER,
    error: injected,
  });
  assert.equal(failed.ok, false);
  if (!failed.ok) {
    assert.equal(failed.source, "member");
    assert.equal(failed.error, injected);
  }
});

test("admin authority는 exact boolean false만 비관리자이고 오류·no-row·손상은 unavailable이다", () => {
  assert.deepEqual(
    resolveAdminAuthorityRead({
      data: { is_admin: true },
      error: null,
    }),
    { ok: true, isAdmin: true },
  );
  assert.deepEqual(
    resolveAdminAuthorityRead({
      data: { is_admin: false },
      error: null,
    }),
    { ok: true, isAdmin: false },
  );

  const injected = new Error("admin authority read unavailable");
  for (const result of [
    { data: { is_admin: true }, error: injected },
    { data: null, error: null },
    { data: {}, error: null },
    { data: { is_admin: "true" }, error: null },
  ]) {
    const resolved = resolveAdminAuthorityRead(result);
    assert.equal(resolved.ok, false);
    if (!resolved.ok) assert.equal(resolved.source, "member");
  }
});

test("신규 후보 migration 실패는 member INSERT 진행을 막고 다음 POST에서 재시도된다", async () => {
  let attempts = 0;
  let memberInsertCalls = 0;
  const migrate = async () => {
    attempts += 1;
    return attempts === 1 ? ("failed" as const) : ("migrated" as const);
  };

  const first = await prepareAnonMigration(null, migrate);
  if (first.ok) memberInsertCalls += 1;
  assert.deepEqual(first, {
    ok: false,
    attempted: true,
    result: "failed",
  });
  assert.equal(memberInsertCalls, 0);

  const retry = await prepareAnonMigration(null, migrate);
  if (retry.ok) memberInsertCalls += 1;
  assert.deepEqual(retry, {
    ok: true,
    attempted: true,
    result: "migrated",
  });
  assert.equal(attempts, 2);
  assert.equal(memberInsertCalls, 1);
});

test("migration throw도 retryable 실패이며 기존 member 재로그인은 migration을 호출하지 않는다", async () => {
  const thrown = await prepareAnonMigration(null, async () => {
    throw new Error("injected migration transport failure");
  });
  assert.equal(thrown.ok, false);
  if (!thrown.ok) {
    assert.equal(thrown.result, "failed");
    assert.match(String((thrown.error as Error).message), /injected migration/);
  }

  let existingMigrationCalls = 0;
  const existing = await prepareAnonMigration(CONSENTED_MEMBER, async () => {
    existingMigrationCalls += 1;
    return "migrated";
  });
  assert.deepEqual(existing, {
    ok: true,
    attempted: false,
    result: "not_applicable",
  });
  assert.equal(existingMigrationCalls, 0);

  const converged = await prepareAnonMigration(
    CONSENTED_MEMBER,
    async () => {
      existingMigrationCalls += 1;
      return "skipped";
    },
    true,
  );
  assert.deepEqual(converged, {
    ok: true,
    attempted: true,
    result: "skipped",
  });
  assert.equal(existingMigrationCalls, 1);
});

test("consent mutation은 exact boolean commit 증거만 성공으로 인정한다", async () => {
  assert.deepEqual(
    await resolveConsentMutation(async () => ({ data: true, error: null })),
    { ok: true, isNew: true },
  );
  assert.deepEqual(
    await resolveConsentMutation(async () => ({ data: false, error: null })),
    { ok: true, isNew: false },
  );

  for (const data of [null, undefined, 0, 1, "false", {}, []]) {
    const result = await resolveConsentMutation(async () => ({
      data,
      error: null,
    }));
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(
        String((result.error as Error).message),
        /invalid_consent_mutation_response/,
      );
    }
  }
});

test("consent mutation resolved error와 throw는 성공 data보다 우선하며 재시도 상태다", async () => {
  const resolvedError = new Error("database unavailable");
  assert.deepEqual(
    await resolveConsentMutation(async () => ({
      data: true,
      error: resolvedError,
    })),
    { ok: false, error: resolvedError },
  );

  const thrown = new Error("transport unavailable");
  assert.deepEqual(
    await resolveConsentMutation(async () => {
      throw thrown;
    }),
    { ok: false, error: thrown },
  );
});

test("consent route는 mutation 검증 실패에서 MIGRATE cookie를 지우지 않는다", () => {
  const source = readFileSync(
    new URL("../../app/api/account/consent/route.ts", import.meta.url),
    "utf8",
  );
  const resolution = source.indexOf("await resolveConsentMutation");
  const failureGuard = source.indexOf("if (!mutation.ok)", resolution);
  const finalClear = source.lastIndexOf(
    "return clearCookie(",
  );
  assert.ok(resolution >= 0);
  assert.ok(failureGuard > resolution);
  assert.ok(finalClear > failureGuard);
  assert.match(
    source.slice(failureGuard, finalClear),
    /return NextResponse\.json\([\s\S]*?consent_failed/,
  );
});
