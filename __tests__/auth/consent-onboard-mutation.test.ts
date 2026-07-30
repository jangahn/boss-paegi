import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { register } from "node:module";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  ConsentCompatibilityError,
  isMissingConsentWithProfileRpcError,
  runConsentOnboardMutation,
  syncLegacyOAuthProfileStrict,
} = await import("../../lib/consent-onboard-mutation.ts");

const USER_ID = "11111111-1111-4111-8111-111111111111";
const EMAIL = "qa@example.com";
const EXPECTED = {
  displayName: "QA",
  avatarUrl: "https://example.com/avatar.png",
  email: EMAIL,
};
const ACTIVE_PROFILE = {
  id: USER_ID,
  deleted_at: null,
  display_name: EXPECTED.displayName,
  avatar_url: EXPECTED.avatarUrl,
};
const MEMBER_EMAIL = { user_id: USER_ID, email: EMAIL };
const MISSING_ATOMIC = {
  code: "PGRST202",
  message:
    "Could not find the function public.create_or_update_member_consent_with_profile(p_user_id, p_email) in the schema cache",
};

function successOps(overrides = {}) {
  return {
    writeActiveProfile: async () => ({
      data: ACTIVE_PROFILE,
      error: null,
    }),
    writeMemberEmail: async () => ({ data: MEMBER_EMAIL, error: null }),
    readProfile: async () => ({ data: ACTIVE_PROFILE, error: null }),
    readMemberEmail: async () => ({ data: MEMBER_EMAIL, error: null }),
    scrubMemberEmail: async () => ({
      data: { user_id: USER_ID, email: null },
      error: null,
    }),
    ...overrides,
  };
}

test("fallback은 exact PGRST202 + exact public RPC 이름에서만 열린다", () => {
  assert.equal(isMissingConsentWithProfileRpcError(MISSING_ATOMIC), true);

  for (const error of [
    {
      code: "PGRST202",
      message:
        "Could not find the function public.create_or_update_member_consent(p_user_id) in the schema cache",
    },
    {
      code: "42883",
      message:
        "function public.create_or_update_member_consent_with_profile(...) does not exist",
    },
    {
      code: "42501",
      message:
        "permission denied for public.create_or_update_member_consent_with_profile(...)",
    },
    {
      code: "PGRST202",
      message: "Could not find another function in the schema cache",
    },
    new Error(
      "Could not find public.create_or_update_member_consent_with_profile(...)",
    ),
    null,
  ]) {
    assert.equal(
      isMissingConsentWithProfileRpcError(error),
      false,
      JSON.stringify(error),
    );
  }
});

test("modern exact boolean 성공은 legacy 경로를 전혀 호출하지 않는다", async () => {
  for (const isNew of [true, false]) {
    let legacyCalls = 0;
    let syncCalls = 0;
    let verifyCalls = 0;
    const result = await runConsentOnboardMutation({
      atomic: async () => ({ data: isNew, error: null }),
      legacy: async () => {
        legacyCalls += 1;
        return { data: false, error: null };
      },
      syncLegacyProfile: async () => {
        syncCalls += 1;
      },
      verifyLegacyCommit: async () => {
        verifyCalls += 1;
      },
    });
    assert.deepEqual(result, { ok: true, isNew, mode: "atomic" });
    assert.deepEqual({ legacyCalls, syncCalls, verifyCalls }, {
      legacyCalls: 0,
      syncCalls: 0,
      verifyCalls: 0,
    });
  }
});

test("권한·timeout·malformed modern 응답은 legacy로 강등하지 않는다", async () => {
  for (const atomic of [
    async () => ({
      data: true,
      error: { code: "42501", message: "permission denied" },
    }),
    async () => ({
      data: true,
      error: { code: "57014", message: "statement timeout" },
    }),
    async () => ({ data: null, error: null }),
    async () => {
      throw new Error("transport unavailable");
    },
  ]) {
    let legacyCalls = 0;
    const result = await runConsentOnboardMutation({
      atomic,
      legacy: async () => {
        legacyCalls += 1;
        return { data: false, error: null };
      },
      syncLegacyProfile: async () => undefined,
      verifyLegacyCommit: async () => undefined,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.phase, "atomic");
      assert.equal(result.legacyCommitted, false);
    }
    assert.equal(legacyCalls, 0);
  }
});

test("exact missing modern RPC만 legacy exact boolean + sync + verify 순서로 완료한다", async () => {
  const calls: string[] = [];
  const result = await runConsentOnboardMutation({
    atomic: async () => {
      calls.push("atomic");
      return { data: null, error: MISSING_ATOMIC };
    },
    legacy: async () => {
      calls.push("legacy");
      return { data: true, error: null };
    },
    syncLegacyProfile: async () => {
      calls.push("sync");
    },
    verifyLegacyCommit: async () => {
      calls.push("verify");
    },
  });
  assert.deepEqual(result, { ok: true, isNew: true, mode: "legacy" });
  assert.deepEqual(calls, ["atomic", "legacy", "sync", "verify"]);
});

test("legacy도 boolean 외 응답·resolved error·throw를 commit으로 인정하지 않는다", async () => {
  for (const legacy of [
    async () => ({ data: null, error: null }),
    async () => ({ data: 1, error: null }),
    async () => ({
      data: true,
      error: { code: "XX000", message: "legacy failed" },
    }),
    async () => {
      throw new Error("legacy transport failed");
    },
  ]) {
    let syncCalls = 0;
    const result = await runConsentOnboardMutation({
      atomic: async () => ({ data: null, error: MISSING_ATOMIC }),
      legacy,
      syncLegacyProfile: async () => {
        syncCalls += 1;
      },
      verifyLegacyCommit: async () => undefined,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.phase, "legacy_consent");
      assert.equal(result.legacyCommitted, false);
    }
    assert.equal(syncCalls, 0);
  }
});

test("legacy partial commit 뒤 sync/verify 실패는 retryable이며 재시도가 완결한다", async () => {
  let syncAttempts = 0;
  const invoke = () =>
    runConsentOnboardMutation({
      atomic: async () => ({ data: null, error: MISSING_ATOMIC }),
      // 첫 요청에서 이미 insert가 commit됐으므로 재시도는 false가 정상이다.
      legacy: async () => ({ data: false, error: null }),
      syncLegacyProfile: async () => {
        syncAttempts += 1;
        if (syncAttempts === 1) throw new Error("profile dependency down");
      },
      verifyLegacyCommit: async () => undefined,
    });

  const first = await invoke();
  assert.equal(first.ok, false);
  if (!first.ok) {
    assert.equal(first.phase, "legacy_profile_sync");
    assert.equal(first.legacyCommitted, true);
  }

  const retry = await invoke();
  assert.deepEqual(retry, {
    ok: true,
    isNew: false,
    mode: "legacy",
  });
  assert.equal(syncAttempts, 2);

  const verifyFailure = await runConsentOnboardMutation({
    atomic: async () => ({ data: null, error: MISSING_ATOMIC }),
    legacy: async () => ({ data: false, error: null }),
    syncLegacyProfile: async () => undefined,
    verifyLegacyCommit: async () => {
      throw new Error("legal_version_changed");
    },
  });
  assert.equal(verifyFailure.ok, false);
  if (!verifyFailure.ok) {
    assert.equal(verifyFailure.phase, "legacy_verify");
    assert.equal(verifyFailure.legacyCommitted, true);
  }
});

test("legacy profile/email sync는 모든 exact row postcondition이 맞아야 성공한다", async () => {
  await syncLegacyOAuthProfileStrict(
    successOps(),
    USER_ID,
    EXPECTED,
  );

  // Null OAuth fields mean preserve existing profile values, not clear them.
  await syncLegacyOAuthProfileStrict(
    successOps({
      writeActiveProfile: async () => ({
        data: {
          ...ACTIVE_PROFILE,
          display_name: "existing",
          avatar_url: "https://existing.example/avatar.png",
        },
        error: null,
      }),
      readProfile: async () => ({
        data: {
          ...ACTIVE_PROFILE,
          display_name: "existing",
          avatar_url: "https://existing.example/avatar.png",
        },
        error: null,
      }),
    }),
    USER_ID,
    { displayName: null, avatarUrl: null, email: EMAIL },
  );
});

test("활성 profile 조건부 write가 실패하면 email write를 시작하지 않는다", async () => {
  for (const writeActiveProfile of [
    async () => ({ data: null, error: null }),
    async () => ({
      data: { ...ACTIVE_PROFILE, deleted_at: "2026-07-29T00:00:00Z" },
      error: null,
    }),
    async () => ({
      data: ACTIVE_PROFILE,
      error: new Error("profile write resolved error"),
    }),
    async () => {
      throw new Error("profile write transport error");
    },
  ]) {
    let emailWrites = 0;
    let scrubs = 0;
    await assert.rejects(
      syncLegacyOAuthProfileStrict(
        successOps({
          writeActiveProfile,
          writeMemberEmail: async () => {
            emailWrites += 1;
            return { data: MEMBER_EMAIL, error: null };
          },
          scrubMemberEmail: async () => {
            scrubs += 1;
            return {
              data: { user_id: USER_ID, email: null },
              error: null,
            };
          },
        }),
        USER_ID,
        EXPECTED,
      ),
      ConsentCompatibilityError,
    );
    assert.equal(emailWrites, 0);
    assert.equal(scrubs, 0);
  }
});

test("email write의 resolved/throw/malformed/ack mismatch는 모두 scrub 보상 후 실패한다", async () => {
  for (const writeMemberEmail of [
    async () => ({
      data: MEMBER_EMAIL,
      error: new Error("email write resolved error"),
    }),
    async () => {
      throw new Error("email write transport error");
    },
    async () => ({ data: null, error: null }),
    async () => ({
      data: { user_id: USER_ID, email: "wrong@example.com" },
      error: null,
    }),
    async () => undefined,
  ]) {
    let scrubs = 0;
    await assert.rejects(
      syncLegacyOAuthProfileStrict(
        successOps({
          writeMemberEmail,
          scrubMemberEmail: async () => {
            scrubs += 1;
            return {
              data: { user_id: USER_ID, email: null },
              error: null,
            };
          },
        }),
        USER_ID,
        EXPECTED,
      ),
      ConsentCompatibilityError,
    );
    assert.equal(scrubs, 1);
  }
});

test("email write 뒤 삭제 경합을 최종 profile read가 잡고 email을 scrub한다", async () => {
  let persistedEmail: string | null = EMAIL;
  await assert.rejects(
    syncLegacyOAuthProfileStrict(
      successOps({
        readProfile: async () => ({
          data: {
            ...ACTIVE_PROFILE,
            deleted_at: "2026-07-29T00:00:00Z",
            display_name: "탈퇴한 사용자",
            avatar_url: null,
          },
          error: null,
        }),
        scrubMemberEmail: async () => {
          persistedEmail = null;
          return {
            data: { user_id: USER_ID, email: persistedEmail },
            error: null,
          };
        },
      }),
      USER_ID,
      EXPECTED,
    ),
    /invalid_account/,
  );
  assert.equal(persistedEmail, null);
});

test("최종 profile/email read 오류·mismatch도 false success 없이 scrub한다", async () => {
  for (const override of [
    {
      readProfile: async () => ({
        data: ACTIVE_PROFILE,
        error: new Error("profile read error"),
      }),
    },
    {
      readProfile: async () => {
        throw new Error("profile read throw");
      },
    },
    {
      readMemberEmail: async () => ({
        data: { user_id: USER_ID, email: "wrong@example.com" },
        error: null,
      }),
    },
    {
      readMemberEmail: async () => undefined,
    },
  ]) {
    let scrubs = 0;
    await assert.rejects(
      syncLegacyOAuthProfileStrict(
        successOps({
          ...override,
          scrubMemberEmail: async () => {
            scrubs += 1;
            return {
              data: { user_id: USER_ID, email: null },
              error: null,
            };
          },
        }),
        USER_ID,
        EXPECTED,
      ),
      ConsentCompatibilityError,
    );
    assert.equal(scrubs, 1);
  }
});

test("scrub 자체의 resolved/throw/malformed postcondition 실패도 원 오류와 함께 노출한다", async () => {
  for (const scrubMemberEmail of [
    async () => ({
      data: { user_id: USER_ID, email: EMAIL },
      error: null,
    }),
    async () => ({
      data: { user_id: "22222222-2222-4222-8222-222222222222", email: null },
      error: null,
    }),
    async () => ({
      data: null,
      error: new Error("scrub resolved error"),
    }),
    async () => {
      throw new Error("scrub transport error");
    },
    async () => undefined,
  ]) {
    await assert.rejects(
      syncLegacyOAuthProfileStrict(
        successOps({
          writeMemberEmail: async () => ({
            data: null,
            error: new Error("ambiguous email write"),
          }),
          scrubMemberEmail,
        }),
        USER_ID,
        EXPECTED,
      ),
      (error) => {
        assert.ok(error instanceof ConsentCompatibilityError);
        assert.notEqual(error.cleanupError, null);
        assert.match(error.message, /cleanup=/);
        return true;
      },
    );
  }
});

test("route는 no-missing partial retry에서도 mutation을 실행하고 실패 전에 cookie를 지우지 않는다", () => {
  const source = readFileSync(
    new URL("../../app/api/account/consent/route.ts", import.meta.url),
    "utf8",
  );
  const required = source.indexOf(
    "const required = missingConsentItems(member, curr)",
  );
  const mutation = source.indexOf("await runConsentOnboardMutation", required);
  const failure = source.indexOf("if (!mutation.ok)", mutation);
  const finalClear = source.lastIndexOf(
    "return clearCookie(NextResponse.json({ ok: true }))",
  );
  assert.ok(required >= 0);
  assert.ok(mutation > required);
  assert.ok(failure > mutation);
  assert.ok(finalClear > failure);
  assert.doesNotMatch(
    source.slice(required, mutation),
    /return clearCookie\(/,
  );
  assert.doesNotMatch(
    source.slice(failure, finalClear),
    /clearCookie\(/,
  );
});
