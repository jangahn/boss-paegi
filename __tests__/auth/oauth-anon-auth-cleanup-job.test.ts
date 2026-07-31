import assert from "node:assert/strict";
import { register } from "node:module";
import test from "node:test";

register("../telemetry/node-loader.mjs", import.meta.url);

const {
  drainOAuthAnonAuthCleanupJobs,
  parseIsoInstantNanoseconds,
  parseOAuthAnonAuthCleanupLease,
  processOAuthAnonAuthCleanupJob,
  sameAuthGenerationCreatedAt,
} = await import("../../lib/oauth-anon-auth-cleanup-job.ts");

const FLOW_ID = "10000000-0000-4000-8000-000000000001";
const SOURCE_USER_ID = "20000000-0000-4000-8000-000000000001";
const EXPECTED_CREATED_AT = "2026-07-31T01:02:03.123456+00:00";
const OBSERVED_CREATED_AT = "2026-07-31T01:02:03.123456Z";

type AuthRead =
  | { data: { user: Record<string, unknown> }; error: null }
  | { data: { user: null }; error: unknown };

function presentUser(
  overrides: Record<string, unknown> = {},
): AuthRead {
  return {
    data: {
      user: {
        id: SOURCE_USER_ID,
        aud: "authenticated",
        app_metadata: {},
        user_metadata: {},
        created_at: OBSERVED_CREATED_AT,
        is_anonymous: true,
        ...overrides,
      },
    },
    error: null,
  };
}

function missingUser(): AuthRead {
  return {
    data: { user: null },
    error: { code: "user_not_found", message: "User not found" },
  };
}

function createAdmin(options: {
  reads: AuthRead[];
  verifications: Array<"absent" | "deletable" | "protected">;
  deleteUser?: () => Promise<unknown>;
  finishFails?: boolean;
  claimIdleAfter?: number;
  idleBacklog?: number;
  claimAttemptCount?: number;
}) {
  const calls: Array<{
    operation: string;
    args?: Record<string, unknown>;
  }> = [];
  let claims = 0;
  let reads = 0;
  let verifications = 0;
  let deletes = 0;
  const admin = {
    rpc: async (
      operation: string,
      args: Record<string, unknown>,
    ) => {
      calls.push({ operation, args });
      if (operation === "claim_oauth_anon_auth_cleanup") {
        claims += 1;
        if (
          options.claimIdleAfter !== undefined &&
          claims > options.claimIdleAfter
        ) {
          return {
            data: {
              ok: true,
              idle: true,
              pendingBacklog: options.idleBacklog ?? 0,
            },
            error: null,
          };
        }
        return {
          data: {
            ok: true,
            cleanupId: FLOW_ID,
            sourceUserId: SOURCE_USER_ID,
            sourceAuthCreatedAt: EXPECTED_CREATED_AT,
            leaseToken: args.p_lease_token,
            leaseVersion:
              options.claimAttemptCount ?? claims,
            attemptCount:
              options.claimAttemptCount ?? claims,
          },
          error: null,
        };
      }
      if (
        operation ===
        "verify_oauth_anon_auth_cleanup_source"
      ) {
        const state = options.verifications[verifications];
        verifications += 1;
        return {
          data: { ok: true, cleanupId: FLOW_ID, state },
          error: null,
        };
      }
      if (operation === "finish_oauth_anon_auth_cleanup") {
        if (options.finishFails) {
          return {
            data: null,
            error: new Error("finish unavailable"),
          };
        }
        const status =
          args.p_outcome === "pending" &&
          options.claimAttemptCount === 2_147_483_647
            ? "protected"
            : args.p_outcome;
        return {
          data: {
            ok: true,
            cleanupId: FLOW_ID,
            status,
            leaseVersion: args.p_lease_version,
            nextAttemptAt:
              status === "pending"
                ? "2026-07-31T01:03:03.123456+00:00"
                : null,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC: ${operation}`);
    },
    auth: {
      admin: {
        getUserById: async () => {
          const result = options.reads[reads];
          reads += 1;
          if (!result) throw new Error("unexpected Auth read");
          return result;
        },
        deleteUser: async () => {
          deletes += 1;
          return options.deleteUser
            ? options.deleteUser()
            : { data: { user: { id: SOURCE_USER_ID } }, error: null };
        },
      },
    },
  };
  return {
    admin: admin as never,
    calls,
    counts: {
      get claims() {
        return claims;
      },
      get reads() {
        return reads;
      },
      get verifications() {
        return verifications;
      },
      get deletes() {
        return deletes;
      },
    },
  };
}

test("Auth generation timestamp comparison preserves microseconds across UTC spellings", () => {
  assert.equal(
    sameAuthGenerationCreatedAt(
      OBSERVED_CREATED_AT,
      EXPECTED_CREATED_AT,
    ),
    true,
  );
  assert.equal(
    sameAuthGenerationCreatedAt(
      "2026-07-31T10:02:03.123456+09:00",
      EXPECTED_CREATED_AT,
    ),
    true,
  );
  assert.equal(
    sameAuthGenerationCreatedAt(
      "2026-07-31T01:02:03.123457Z",
      EXPECTED_CREATED_AT,
    ),
    false,
  );
  assert.equal(
    parseIsoInstantNanoseconds("2026-02-30T00:00:00Z"),
    null,
  );
  assert.equal(
    parseIsoInstantNanoseconds("0099-01-01T00:00:00Z"),
    "-59042995200:000000000",
  );
  assert.equal(parseIsoInstantNanoseconds("not-a-date"), null);
});

test("cleanup lease parser rejects added keys, malformed generations, and weak fences", () => {
  const valid = {
    ok: true,
    cleanupId: FLOW_ID,
    sourceUserId: SOURCE_USER_ID,
    sourceAuthCreatedAt: EXPECTED_CREATED_AT,
    leaseToken: "30000000-0000-4000-8000-000000000001",
    leaseVersion: 1,
    attemptCount: 1,
  };
  assert.deepEqual(parseOAuthAnonAuthCleanupLease(valid), {
    cleanupId: FLOW_ID,
    sourceUserId: SOURCE_USER_ID,
    sourceAuthCreatedAt: EXPECTED_CREATED_AT,
    leaseToken: "30000000-0000-4000-8000-000000000001",
    leaseVersion: 1,
    attemptCount: 1,
  });
  assert.ok(
    parseOAuthAnonAuthCleanupLease({
      ...valid,
      cleanupId:
        "10000000-0000-8000-8000-000000000001",
      sourceUserId:
        "20000000-0000-8000-8000-000000000001",
    }),
  );
  assert.equal(parseOAuthAnonAuthCleanupLease(null), null);
  for (const malformed of [
    { ...valid, extra: true },
    { ...valid, sourceAuthCreatedAt: "invalid" },
    { ...valid, sourceUserId: "not-a-uuid" },
    { ...valid, leaseVersion: 0 },
    { ...valid, attemptCount: 1.5 },
  ]) {
    assert.throws(
      () => parseOAuthAnonAuthCleanupLease(malformed),
      /invalid oauth anonymous Auth cleanup lease/,
    );
  }
});

test("delete throw/response loss completes only after a fresh explicit Auth absence", async () => {
  const fixture = createAdmin({
    reads: [presentUser(), missingUser()],
    verifications: ["deletable", "absent"],
    deleteUser: async () => {
      throw new Error("response lost after commit");
    },
  });

  assert.deepEqual(
    await processOAuthAnonAuthCleanupJob(fixture.admin),
    {
      kind: "completed",
      cleanupId: FLOW_ID,
      sourceUserId: SOURCE_USER_ID,
      attemptCount: 1,
    },
  );
  assert.equal(fixture.counts.reads, 2);
  assert.equal(fixture.counts.deletes, 1);
  assert.deepEqual(
    fixture.calls.map((call) => call.operation),
    [
      "claim_oauth_anon_auth_cleanup",
      "verify_oauth_anon_auth_cleanup_source",
      "verify_oauth_anon_auth_cleanup_source",
      "finish_oauth_anon_auth_cleanup",
    ],
  );
});

test("resolved delete error with the exact source still present is fenced for retry", async () => {
  const fixture = createAdmin({
    reads: [presentUser(), presentUser()],
    verifications: ["deletable", "deletable"],
    deleteUser: async () => ({
      data: { user: null },
      error: new Error("provider unavailable"),
    }),
  });

  const outcome = await processOAuthAnonAuthCleanupJob(
    fixture.admin,
  );
  assert.equal(outcome.kind, "pending");
  if (outcome.kind === "pending") {
    assert.equal(outcome.failure, "auth_delete_not_confirmed");
    assert.equal(outcome.retryRecorded, true);
  }
  assert.equal(fixture.counts.deletes, 1);
  assert.equal(
    fixture.calls.at(-1)?.args?.p_outcome,
    "pending",
  );
});

test("reused or promoted source is protected without calling delete", async () => {
  for (const user of [
    presentUser({ is_anonymous: false }),
    presentUser({
      created_at: "2026-07-31T01:02:03.123457Z",
    }),
  ]) {
    const fixture = createAdmin({
      reads: [user],
      verifications: ["protected"],
    });
    assert.equal(
      (await processOAuthAnonAuthCleanupJob(fixture.admin)).kind,
      "protected",
    );
    assert.equal(fixture.counts.deletes, 0);
    assert.equal(
      fixture.calls.at(-1)?.args?.p_outcome,
      "protected",
    );
  }
});

test("preexisting absence is completed without issuing another delete", async () => {
  const fixture = createAdmin({
    reads: [missingUser()],
    verifications: ["absent"],
  });
  assert.equal(
    (await processOAuthAnonAuthCleanupJob(fixture.admin)).kind,
    "completed",
  );
  assert.equal(fixture.counts.deletes, 0);
});

test("Admin/DB disagreement and unconfirmed post-delete reads remain retryable", async () => {
  const missingButDbPresent = createAdmin({
    reads: [missingUser()],
    verifications: ["deletable"],
  });
  const first = await processOAuthAnonAuthCleanupJob(
    missingButDbPresent.admin,
  );
  assert.equal(first.kind, "pending");
  if (first.kind === "pending") {
    assert.equal(first.failure, "auth_read_db_divergence");
  }
  assert.equal(missingButDbPresent.counts.deletes, 0);

  const confirmationUnavailable = createAdmin({
    reads: [
      presentUser(),
      { data: { user: null }, error: null },
    ],
    verifications: ["deletable"],
  });
  const second = await processOAuthAnonAuthCleanupJob(
    confirmationUnavailable.admin,
  );
  assert.equal(second.kind, "pending");
  if (second.kind === "pending") {
    assert.equal(
      second.failure,
      "auth_delete_confirmation_unavailable",
    );
  }
});

test("finish response loss leaves the lease retryable instead of claiming completion", async () => {
  const fixture = createAdmin({
    reads: [presentUser(), presentUser()],
    verifications: ["deletable", "deletable"],
    finishFails: true,
  });
  const outcome = await processOAuthAnonAuthCleanupJob(
    fixture.admin,
  );
  assert.equal(outcome.kind, "pending");
  if (outcome.kind === "pending") {
    assert.equal(outcome.retryRecorded, false);
  }
});

test("bounded drain reports completed/protected/pending work and stops on idle", async () => {
  const fixture = createAdmin({
    reads: [missingUser()],
    verifications: ["absent"],
    claimIdleAfter: 1,
  });
  assert.deepEqual(
    await drainOAuthAnonAuthCleanupJobs(fixture.admin, 10),
    {
      claimed: 1,
      completed: 1,
      protected: 0,
      failed: 0,
      pending: 0,
      backlog: 0,
      claimErrors: 0,
    },
  );
  assert.equal(fixture.counts.claims, 2);
  await assert.rejects(
    () => drainOAuthAnonAuthCleanupJobs(fixture.admin, 0),
    /invalid oauth anonymous Auth cleanup drain limit/,
  );
});

test("future retry backlog remains visible even when no cleanup lease is due", async () => {
  const fixture = createAdmin({
    reads: [],
    verifications: [],
    claimIdleAfter: 0,
    idleBacklog: 3,
  });
  assert.deepEqual(
    await drainOAuthAnonAuthCleanupJobs(fixture.admin, 10),
    {
      claimed: 0,
      completed: 0,
      protected: 0,
      failed: 0,
      pending: 0,
      backlog: 3,
      claimErrors: 0,
    },
  );
});

test("the final integer lease attempt terminates visibly instead of becoming unclaimable", async () => {
  const fixture = createAdmin({
    reads: [presentUser(), presentUser()],
    verifications: ["deletable", "deletable"],
    claimAttemptCount: 2_147_483_647,
  });

  assert.deepEqual(
    await processOAuthAnonAuthCleanupJob(fixture.admin),
    {
      kind: "failed",
      cleanupId: FLOW_ID,
      sourceUserId: SOURCE_USER_ID,
      attemptCount: 2_147_483_647,
      failure: "cleanup_attempt_limit_exhausted",
    },
  );
  assert.equal(
    fixture.calls.at(-1)?.args?.p_outcome,
    "pending",
  );
});
