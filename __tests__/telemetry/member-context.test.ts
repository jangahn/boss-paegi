import test from "node:test";
import assert from "node:assert/strict";
import {
  resolveTelemetryActor,
  type TelemetryActorDependencies,
} from "../../lib/telemetry/member-context.ts";

const USER_ID = "00000000-0000-4000-8000-000000000001";

function dependencies(
  overrides: Partial<TelemetryActorDependencies> = {},
): TelemetryActorDependencies {
  return {
    getAuthUser: async () => ({
      data: { id: USER_ID, isAnonymous: false },
      error: null,
    }),
    getProfile: async () => ({
      data: { deletedAt: null },
      error: null,
    }),
    getMember: async () => ({
      data: { userId: USER_ID },
      error: null,
    }),
    ...overrides,
  };
}

test("no session is unbound summary-only", async () => {
  let profileReads = 0;
  const result = await resolveTelemetryActor(
    dependencies({
      getAuthUser: async () => ({ data: null, error: null }),
      getProfile: async () => {
        profileReads += 1;
        return { data: { deletedAt: null }, error: null };
      },
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    isMember: false,
    ownerId: null,
    submitterId: null,
  });
  assert.equal(profileReads, 0);
});

test("anonymous Auth is summary-only but carries an ephemeral binding input", async () => {
  let profileReads = 0;
  const result = await resolveTelemetryActor(
    dependencies({
      getAuthUser: async () => ({
        data: { id: USER_ID, isAnonymous: true },
        error: null,
      }),
      getProfile: async () => {
        profileReads += 1;
        return { data: { deletedAt: null }, error: null };
      },
    }),
  );
  assert.deepEqual(result, {
    ok: true,
    isMember: false,
    ownerId: null,
    submitterId: USER_ID,
  });
  assert.equal(profileReads, 0);
});

test("active member keeps the authenticated owner", async () => {
  assert.deepEqual(await resolveTelemetryActor(dependencies()), {
    ok: true,
    isMember: true,
    ownerId: USER_ID,
    submitterId: USER_ID,
  });
});

test("pre-consent non-member is intentionally summary-only", async () => {
  assert.deepEqual(
    await resolveTelemetryActor(
      dependencies({
        getMember: async () => ({ data: null, error: null }),
      }),
    ),
    {
      ok: true,
      isMember: false,
      ownerId: null,
      submitterId: USER_ID,
    },
  );
});

test("deleted account is rejected before ingest", async () => {
  assert.deepEqual(
    await resolveTelemetryActor(
      dependencies({
        getProfile: async () => ({
          data: { deletedAt: "2026-07-29T00:00:00.000Z" },
          error: null,
        }),
      }),
    ),
    {
      ok: false,
      status: 403,
      error: "account_deleted",
      stage: "profile",
    },
  );
});

test("resolved errors and throws at every identity stage are never downgraded", async () => {
  const stages: {
    stage: "auth" | "profile" | "member";
    operation: keyof TelemetryActorDependencies;
  }[] = [
    { stage: "auth", operation: "getAuthUser" },
    { stage: "profile", operation: "getProfile" },
    { stage: "member", operation: "getMember" },
  ];
  for (const { stage, operation } of stages) {
    for (const mode of ["resolved", "throw"] as const) {
      const injected = new Error(`${stage}-${mode}`);
      const override = async () => {
        if (mode === "throw") throw injected;
        return { data: null, error: injected };
      };
      const result = await resolveTelemetryActor(
        dependencies({
          [operation]: override,
        } as Partial<TelemetryActorDependencies>),
      );
      assert.equal(result.ok, false);
      if (!result.ok) {
        assert.equal(result.status, 503);
        assert.equal(result.error, "identity_unavailable");
        assert.equal(result.stage, stage);
        assert.equal(result.cause, injected);
      }
    }
  }
});

test("missing profile, invalid auth id, and mismatched member are unavailable", async () => {
  const cases = [
    dependencies({
      getProfile: async () => ({ data: null, error: null }),
    }),
    dependencies({
      getAuthUser: async () => ({
        data: { id: "not-a-uuid", isAnonymous: false },
        error: null,
      }),
    }),
    dependencies({
      getMember: async () => ({
        data: {
          userId: "00000000-0000-4000-8000-000000000002",
        },
        error: null,
      }),
    }),
  ];
  for (const deps of cases) {
    const result = await resolveTelemetryActor(deps);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.status, 503);
      assert.equal(result.error, "identity_unavailable");
    }
  }
});
