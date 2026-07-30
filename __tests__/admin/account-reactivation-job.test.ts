import assert from "node:assert/strict";
import test from "node:test";
import {
  drainAccountReactivationJobs,
  getAccountReactivationStatus,
  parseAccountReactivationLease,
  parseAccountReactivationStatus,
  processAccountReactivationJob,
} from "../../lib/account-reactivation-job.ts";
import { deletedEmailMarker } from "../../lib/oauth-metadata.ts";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_TOKEN = "44444444-4444-4444-8444-444444444444";
const EMAIL = "restored@example.test";
const EXPECTED_DELETED_AT = "2026-07-20T01:02:03.000Z";
const EXPECTED_WITHDRAWAL_GENERATION = 7;

type ProcessAdmin = Parameters<typeof processAccountReactivationJob>[0];
type RpcResult = { data: unknown | null; error: unknown };

const correlation = {
  requestId: REQUEST_ID,
  adminId: ADMIN_ID,
  userId: USER_ID,
};

function lease(options?: {
  requestId?: string;
  adminId?: string;
  userId?: string;
  leaseToken?: string;
  leaseVersion?: number;
  attemptCount?: number;
  action?: "activate" | "cancel";
  preflightError?: string | null;
}) {
  return {
    request_id: options?.requestId ?? REQUEST_ID,
    admin_user_id: options?.adminId ?? ADMIN_ID,
    user_id: options?.userId ?? USER_ID,
    email: EMAIL,
    expected_deleted_at: EXPECTED_DELETED_AT,
    expected_withdrawal_generation:
      EXPECTED_WITHDRAWAL_GENERATION,
    lease_token: options?.leaseToken ?? LEASE_TOKEN,
    lease_version: options?.leaseVersion ?? 1,
    attempt_count: options?.attemptCount ?? 1,
    action: options?.action ?? "activate",
    preflight_error: options?.preflightError ?? null,
  };
}

function completedResult() {
  return {
    ok: true,
    userId: USER_ID,
    accountReactivated: true,
    idempotent: false,
  };
}

function cancelledResult() {
  return {
    ok: true,
    userId: USER_ID,
    accountReactivated: false,
    cancelled: true,
    idempotent: false,
  };
}

function armedResult(options?: {
  leaseToken?: string;
  leaseVersion?: number;
  action?: "activate" | "cancel";
}) {
  return {
    ok: true,
    request_id: REQUEST_ID,
    user_id: USER_ID,
    lease_token: options?.leaseToken ?? LEASE_TOKEN,
    lease_version: options?.leaseVersion ?? 1,
    action: options?.action ?? "activate",
  };
}

function status(
  state: "pending" | "leased" | "completed" | "cancelled",
  options?: {
    requestId?: string;
    adminId?: string;
    userId?: string;
    attemptCount?: number;
  },
) {
  return {
    ok: true,
    request_id: options?.requestId ?? REQUEST_ID,
    admin_user_id: options?.adminId ?? ADMIN_ID,
    user_id: options?.userId ?? USER_ID,
    status: state,
    attempt_count: options?.attemptCount ?? 1,
    next_attempt_at:
      state === "completed" || state === "cancelled"
        ? null
        : "2026-07-20T01:03:03.000Z",
    result: state === "completed"
      ? completedResult()
      : state === "cancelled"
        ? {
            ok: true,
            userId: USER_ID,
            accountReactivated: false,
            cancelled: true,
            idempotent: false,
          }
        : null,
  };
}

function fence(options?: {
  requestId?: string;
  adminId?: string;
  userId?: string;
  leaseToken?: string;
  leaseVersion?: number;
  action?: "activate" | "cancel";
}) {
  return {
    request_id: options?.requestId ?? REQUEST_ID,
    admin_user_id: options?.adminId ?? ADMIN_ID,
    user_id: options?.userId ?? USER_ID,
    lease_token: options?.leaseToken ?? LEASE_TOKEN,
    lease_version: options?.leaseVersion ?? 1,
    action: options?.action ?? "activate",
    expected_deleted_at: EXPECTED_DELETED_AT,
    expected_withdrawal_generation:
      EXPECTED_WITHDRAWAL_GENERATION,
  };
}

function legacyRepairFence(options?: {
  jobId?: string;
  userId?: string;
  leaseToken?: string;
  leaseVersion?: number;
  expectedWithdrawalGeneration?: number;
}) {
  return {
    action: "legacy_repair",
    legacy_repair_job_id: options?.jobId ?? REQUEST_ID,
    user_id: options?.userId ?? USER_ID,
    lease_token: options?.leaseToken ?? LEASE_TOKEN,
    lease_version: options?.leaseVersion ?? 1,
    expected_withdrawal_generation:
      options?.expectedWithdrawalGeneration ?? 0,
  };
}

function legacyRepairArmedResult() {
  return {
    ok: true,
    job_id: REQUEST_ID,
    user_id: USER_ID,
    lease_token: LEASE_TOKEN,
    lease_version: 1,
    action: "legacy_repair",
  };
}

function authUser(
  email: string,
  appMetadata: Record<string, unknown> = {},
) {
  return {
    id: USER_ID,
    email,
    app_metadata: appMetadata,
    user_metadata: {},
  };
}

function adminFrom(options: {
  rpc: (name: string, args?: Record<string, unknown>) => Promise<RpcResult>;
  getUserById?: () => Promise<{
    data: { user: ReturnType<typeof authUser> | null } | null;
    error: unknown;
  }>;
  updateUserById?: (
    userId: string,
    body: Record<string, unknown>,
  ) => Promise<{
    data: { user: ReturnType<typeof authUser> | null } | null;
    error: unknown;
  }>;
}): ProcessAdmin {
  return {
    rpc: options.rpc,
    auth: {
      admin: {
        getUserById:
          options.getUserById ??
          (async () => ({ data: { user: null }, error: null })),
        updateUserById:
          options.updateUserById ??
          (async () => ({ data: { user: null }, error: null })),
      },
    },
  } as unknown as ProcessAdmin;
}

test("strict lease/status parsers reject malformed or contradictory correlation evidence", () => {
  assert.equal(
    parseAccountReactivationLease(lease())?.requestId,
    REQUEST_ID,
  );
  assert.equal(
    parseAccountReactivationStatus(status("completed")).result?.userId,
    USER_ID,
  );

  for (const invalid of [
    undefined,
    { ...lease(), request_id: "not-a-uuid" },
    { ...lease(), email: "not-an-email" },
    { ...lease(), email: deletedEmailMarker(USER_ID) },
    { ...lease(), lease_version: 0 },
    { ...lease(), expected_deleted_at: "not-a-date" },
    { ...lease(), expected_withdrawal_generation: 0 },
    { ...lease(), preflight_error: "UPPER CASE" },
  ]) {
    assert.throws(() => parseAccountReactivationLease(invalid));
  }
  assert.throws(() =>
    parseAccountReactivationStatus({
      ...status("pending"),
      result: completedResult(),
    }),
  );
  assert.throws(() =>
    parseAccountReactivationStatus({
      ...status("completed"),
      result: null,
    }),
  );
});

test("thrown GoTrue response after commit converges from a fresh exact read", async () => {
  const reads = [
    authUser(deletedEmailMarker(USER_ID)),
    authUser(deletedEmailMarker(USER_ID), {
      bp_reactivation_fence: fence(),
    }),
    authUser(EMAIL, { bp_reactivation_fence: fence() }),
  ];
  const updateBodies: Record<string, unknown>[] = [];
  const admin = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_account_reactivation_job") {
        assert.deepEqual(args, {
          p_request_id: REQUEST_ID,
          p_admin_id: ADMIN_ID,
          p_user_id: USER_ID,
          p_lease_seconds: 120,
        });
        return { data: lease(), error: null };
      }
      if (name === "finish_account_reactivation_job") {
        assert.equal(args?.p_success, true);
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "completed",
            result: completedResult(),
          },
          error: null,
        };
      }
      if (name === "arm_account_reactivation_auth_fence") {
        assert.deepEqual(args, {
          p_request_id: REQUEST_ID,
          p_admin_id: ADMIN_ID,
          p_user_id: USER_ID,
          p_lease_token: LEASE_TOKEN,
          p_lease_version: 1,
        });
        return { data: armedResult(), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: { user: reads.shift() ?? null },
      error: null,
    }),
    updateUserById: async (userId, body) => {
      updateBodies.push(body);
      assert.equal(userId, USER_ID);
      assert.deepEqual(body, {
        email: EMAIL,
        email_confirm: true,
      });
      throw new Error("connection reset after GoTrue commit");
    },
  });

  const outcome = await processAccountReactivationJob(admin, correlation);
  assert.equal(outcome.kind, "completed");
  assert.deepEqual(
    updateBodies.map(Object.keys),
    [["email", "email_confirm"]],
  );
  assert.equal(reads.length, 0);
});

test("an orphan with the exact real email never issues a duplicate Auth update", async () => {
  let updates = 0;
  const admin = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_account_reactivation_job") {
        return {
          data: lease({ leaseVersion: 2, attemptCount: 2 }),
          error: null,
        };
      }
      if (name === "finish_account_reactivation_job") {
        assert.equal(args?.p_lease_version, 2);
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "completed",
            result: completedResult(),
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: {
        user: authUser(EMAIL, {
          bp_reactivation_fence: fence({ leaseVersion: 2 }),
        }),
      },
      error: null,
    }),
    updateUserById: async () => {
      updates += 1;
      return { data: { user: authUser(EMAIL) }, error: null };
    },
  });

  const outcome = await processAccountReactivationJob(admin, correlation);
  assert.equal(outcome.kind, "completed");
  assert.equal(updates, 0);
});

test("a different real Auth identity is never overwritten and records backoff", async () => {
  let updates = 0;
  const admin = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_account_reactivation_job") {
        return { data: lease(), error: null };
      }
      if (name === "finish_account_reactivation_job") {
        assert.equal(args?.p_success, false);
        assert.equal(args?.p_error, "auth_identity_conflict");
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "pending",
            result: null,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: { user: authUser("changed-owner@example.test") },
      error: null,
    }),
    updateUserById: async () => {
      updates += 1;
      return { data: { user: authUser(EMAIL) }, error: null };
    },
  });

  const outcome = await processAccountReactivationJob(admin, correlation);
  assert.deepEqual(outcome, {
    kind: "pending",
    requestId: REQUEST_ID,
    adminId: ADMIN_ID,
    userId: USER_ID,
    attemptCount: 1,
    failure: "auth_identity_conflict",
    retryRecorded: true,
  });
  assert.equal(updates, 0);
});

test("lost fenced-finish response recovers only from exact completed status", async () => {
  let statusReads = 0;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_job") {
        return { data: lease(), error: null };
      }
      if (name === "finish_account_reactivation_job") {
        return { data: null, error: { message: "response lost" } };
      }
      if (name === "get_account_reactivation_status") {
        statusReads += 1;
        return { data: status("completed"), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: {
        user: authUser(EMAIL, {
          bp_reactivation_fence: fence(),
        }),
      },
      error: null,
    }),
  });

  const outcome = await processAccountReactivationJob(admin, correlation);
  assert.equal(outcome.kind, "completed");
  assert.equal(statusReads, 1);
});

test("lease loss plus nonterminal status can never become false success", async () => {
  let finishCalls = 0;
  let statusReads = 0;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_job") {
        return { data: lease(), error: null };
      }
      if (name === "finish_account_reactivation_job") {
        finishCalls += 1;
        return { data: null, error: { message: "stale_lease" } };
      }
      if (name === "get_account_reactivation_status") {
        statusReads += 1;
        return { data: status("leased"), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: {
        user: authUser(EMAIL, {
          bp_reactivation_fence: fence(),
        }),
      },
      error: null,
    }),
  });

  const outcome = await processAccountReactivationJob(admin, correlation);
  assert.equal(outcome.kind, "pending");
  assert.equal(
    outcome.kind === "pending" ? outcome.retryRecorded : true,
    false,
  );
  assert.equal(finishCalls, 2);
  assert.equal(statusReads, 1);
});

test("a claim-time semantic poison row is durably deferred without any Auth call", async () => {
  let authReads = 0;
  let authUpdates = 0;
  const admin = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_account_reactivation_job") {
        return {
          data: lease({ preflightError: "reactivation_email_changed" }),
          error: null,
        };
      }
      if (name === "finish_account_reactivation_job") {
        assert.equal(args?.p_success, false);
        assert.equal(args?.p_error, "reactivation_email_changed");
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "pending",
            result: null,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => {
      authReads += 1;
      return { data: { user: authUser(EMAIL) }, error: null };
    },
    updateUserById: async () => {
      authUpdates += 1;
      return { data: { user: authUser(EMAIL) }, error: null };
    },
  });

  const outcome = await processAccountReactivationJob(admin, correlation);
  assert.equal(outcome.kind, "pending");
  assert.equal(
    outcome.kind === "pending" ? outcome.retryRecorded : false,
    true,
  );
  assert.equal(authReads, 0);
  assert.equal(authUpdates, 0);
});

test("a rejected stale Auth fence never becomes success from an old completed receipt", async () => {
  let authReads = 0;
  let finishCalls = 0;
  let statusReads = 0;
  const admin = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_account_reactivation_job") {
        return { data: lease(), error: null };
      }
      if (name === "finish_account_reactivation_job") {
        finishCalls += 1;
        assert.equal(args?.p_success, false);
        return { data: null, error: { message: "stale_lease" } };
      }
      if (name === "get_account_reactivation_status") {
        statusReads += 1;
        return { data: status("completed"), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => {
      authReads += 1;
      return {
        data: {
          user: authUser(deletedEmailMarker(USER_ID), {
            bp_reactivation_fence: fence(),
          }),
        },
        error: null,
      };
    },
    updateUserById: async (_userId, body) => {
      assert.deepEqual(body, {
        email: EMAIL,
        email_confirm: true,
      });
      return {
        data: { user: null },
        error: { message: "stale_reactivation_auth_fence" },
      };
    },
  });

  const outcome = await processAccountReactivationJob(admin, correlation);
  assert.equal(outcome.kind, "pending");
  assert.equal(
    outcome.kind === "pending" ? outcome.retryRecorded : true,
    false,
  );
  assert.equal(authReads, 2);
  assert.equal(finishCalls, 1);
  assert.equal(
    statusReads,
    0,
    "a retry-write failure must not replay an unrelated old completion",
  );
});

test("worker-route status correlation and bounded queue health fail closed", async () => {
  const mismatch = adminFrom({
    rpc: async (name) => {
      assert.equal(name, "get_account_reactivation_status");
      return {
        data: status("completed", {
          adminId: "55555555-5555-4555-8555-555555555555",
        }),
        error: null,
      };
    },
  });
  await assert.rejects(() =>
    getAccountReactivationStatus(mismatch, correlation),
  );

  let claims = 0;
  const bounded = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_legacy_repair") {
        return { data: null, error: null };
      }
      if (name === "claim_account_reactivation_job") {
        claims += 1;
        return {
          data: lease({
            leaseVersion: claims,
            attemptCount: claims,
          }),
          error: null,
        };
      }
      if (name === "finish_account_reactivation_job") {
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "completed",
            result: completedResult(),
          },
          error: null,
        };
      }
      if (name === "get_account_reactivation_queue_health") {
        return {
          data: {
            ok: true,
            retry_pending: 3,
            oldest_pending: {
              request_id: REQUEST_ID,
              user_id: USER_ID,
              status: "pending",
              last_error: "auth_identity_conflict",
              retry_at: "2026-07-20T01:03:03.000Z",
            },
            legacy_repair_pending: 0,
            oldest_legacy_repair: null,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: {
        user: authUser(EMAIL, {
          bp_reactivation_fence: fence({
            leaseVersion: claims,
          }),
        }),
      },
      error: null,
    }),
  });
  assert.deepEqual(await drainAccountReactivationJobs(bounded, 2), {
    claimed: 2,
    completed: 2,
    pending: 0,
    retryBacklog: 3,
    claimErrors: 0,
    healthErrors: 0,
    failures: [],
    claimFailures: [],
    backlogSample: {
      requestId: REQUEST_ID,
      userId: USER_ID,
      status: "pending",
      lastError: "auth_identity_conflict",
      retryAt: "2026-07-20T01:03:03.000Z",
    },
  });
  assert.equal(claims, 2);

  const malformedHealth = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_legacy_repair") {
        return { data: null, error: null };
      }
      if (name === "claim_account_reactivation_job") {
        return { data: null, error: null };
      }
      if (name === "get_account_reactivation_queue_health") {
        return {
          data: {
            ok: true,
            retry_pending: -1,
            oldest_pending: null,
            legacy_repair_pending: 0,
            oldest_legacy_repair: null,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
  });
  assert.deepEqual(
    await drainAccountReactivationJobs(malformedHealth, Number.NaN),
    {
      claimed: 0,
      completed: 0,
      pending: 0,
      retryBacklog: 0,
      claimErrors: 0,
      healthErrors: 1,
      failures: [],
      claimFailures: [],
      backlogSample: null,
    },
  );
});

test("cron drain has a monotonic wall-clock budget and reports timeout non-green", async () => {
  const never = new Promise<RpcResult>(() => undefined);
  const admin = adminFrom({
    rpc: async () => never,
  });
  const started = performance.now();
  const outcome = await drainAccountReactivationJobs(admin, 50, {
    maxDurationMs: 5,
  });
  assert.ok(performance.now() - started < 1_000);
  assert.deepEqual(outcome, {
    claimed: 0,
    completed: 0,
    pending: 0,
    retryBacklog: 0,
    claimErrors: 1,
    healthErrors: 1,
    failures: [],
    claimFailures: ["reactivation_deadline_exceeded"],
    backlogSample: null,
  });
});

test("cancel lease compensates only exact restored email to the fixed marker", async () => {
  let authReads = 0;
  let authEmail = EMAIL;
  let authFence: Record<string, unknown> | undefined;
  const rpcOrder: string[] = [];
  const admin = adminFrom({
    rpc: async (name) => {
      rpcOrder.push(name);
      if (name === "claim_account_reactivation_job") {
        return {
          data: lease({ action: "cancel" }),
          error: null,
        };
      }
      if (name === "arm_account_reactivation_auth_fence") {
        authFence = fence({ action: "cancel" });
        return {
          data: armedResult({ action: "cancel" }),
          error: null,
        };
      }
      if (name === "finish_account_reactivation_job") {
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "cancelled",
            result: cancelledResult(),
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => {
      authReads += 1;
      return {
        data: {
          user: authUser(
            authEmail,
            authFence
              ? { bp_reactivation_fence: authFence }
              : {},
          ),
        },
        error: null,
      };
    },
    updateUserById: async (_userId, body) => {
      assert.deepEqual(body, {
        email: deletedEmailMarker(USER_ID),
        email_confirm: true,
      });
      authEmail = deletedEmailMarker(USER_ID);
      return {
        data: {
          user: authUser(authEmail, {
            bp_reactivation_fence: authFence,
          }),
        },
        error: null,
      };
    },
  });

  const outcome = await processAccountReactivationJob(
    admin,
    correlation,
  );
  assert.equal(outcome.kind, "cancelled");
  assert.equal(authReads, 3);
  assert.deepEqual(rpcOrder, [
    "claim_account_reactivation_job",
    "arm_account_reactivation_auth_fence",
    "finish_account_reactivation_job",
  ]);
});

for (const mode of ["resolved-error", "throw"] as const) {
  test(`cancel lease confirms committed marker after ${mode}`, async () => {
    let authEmail = EMAIL;
    let authFence: Record<string, unknown> | undefined;
    let updates = 0;
    const admin = adminFrom({
      rpc: async (name) => {
        if (name === "claim_account_reactivation_job") {
          return {
            data: lease({ action: "cancel" }),
            error: null,
          };
        }
        if (name === "arm_account_reactivation_auth_fence") {
          authFence = fence({ action: "cancel" });
          return {
            data: armedResult({ action: "cancel" }),
            error: null,
          };
        }
        if (name === "finish_account_reactivation_job") {
          return {
            data: {
              ok: true,
              request_id: REQUEST_ID,
              status: "cancelled",
              result: cancelledResult(),
            },
            error: null,
          };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
      getUserById: async () => ({
        data: {
          user: authUser(
            authEmail,
            authFence
              ? { bp_reactivation_fence: authFence }
              : {},
          ),
        },
        error: null,
      }),
      updateUserById: async (_userId, body) => {
        updates += 1;
        assert.deepEqual(body, {
          email: deletedEmailMarker(USER_ID),
          email_confirm: true,
        });
        authEmail = deletedEmailMarker(USER_ID);
        if (mode === "throw") {
          throw new Error("response_lost_after_commit");
        }
        return {
          data: { user: null },
          error: { message: "response_lost_after_commit" },
        };
      },
    });

    const outcome = await processAccountReactivationJob(
      admin,
      correlation,
    );
    assert.equal(outcome.kind, "cancelled");
    assert.equal(updates, 1);
  });
}

test("cancel lease with an existing marker performs no Auth mutation", async () => {
  let arms = 0;
  let updates = 0;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_job") {
        return {
          data: lease({ action: "cancel" }),
          error: null,
        };
      }
      if (name === "arm_account_reactivation_auth_fence") {
        arms += 1;
        return { data: armedResult({ action: "cancel" }), error: null };
      }
      if (name === "finish_account_reactivation_job") {
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "cancelled",
            result: cancelledResult(),
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: { user: authUser(deletedEmailMarker(USER_ID)) },
      error: null,
    }),
    updateUserById: async () => {
      updates += 1;
      return { data: { user: null }, error: null };
    },
  });
  const outcome = await processAccountReactivationJob(
    admin,
    correlation,
  );
  assert.equal(outcome.kind, "cancelled");
  assert.equal(arms, 0);
  assert.equal(updates, 0);
});

test("cancel finish response loss recovers only cancelled status", async () => {
  let statusReads = 0;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_job") {
        return {
          data: lease({ action: "cancel" }),
          error: null,
        };
      }
      if (name === "finish_account_reactivation_job") {
        return { data: null, error: { message: "response lost" } };
      }
      if (name === "get_account_reactivation_status") {
        statusReads += 1;
        return { data: status("cancelled"), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: { user: authUser(deletedEmailMarker(USER_ID)) },
      error: null,
    }),
  });
  const outcome = await processAccountReactivationJob(
    admin,
    correlation,
  );
  assert.equal(outcome.kind, "cancelled");
  assert.equal(statusReads, 1);
});

test("opposite terminal statuses never recover a stale action", async () => {
  for (
    const scenario of [
      {
        action: "activate" as const,
        authEmail: EMAIL,
        authFence: fence(),
        terminal: "cancelled" as const,
      },
      {
        action: "cancel" as const,
        authEmail: deletedEmailMarker(USER_ID),
        authFence: undefined,
        terminal: "completed" as const,
      },
    ]
  ) {
    let finishCalls = 0;
    const admin = adminFrom({
      rpc: async (name) => {
        if (name === "claim_account_reactivation_job") {
          return {
            data: lease({ action: scenario.action }),
            error: null,
          };
        }
        if (name === "finish_account_reactivation_job") {
          finishCalls += 1;
          return { data: null, error: { message: "stale_lease" } };
        }
        if (name === "get_account_reactivation_status") {
          return {
            data: status(scenario.terminal),
            error: null,
          };
        }
        throw new Error(`unexpected RPC ${name}`);
      },
      getUserById: async () => ({
        data: {
          user: authUser(
            scenario.authEmail,
            scenario.authFence
              ? { bp_reactivation_fence: scenario.authFence }
              : {},
          ),
        },
        error: null,
      }),
    });
    const outcome = await processAccountReactivationJob(
      admin,
      correlation,
    );
    assert.equal(outcome.kind, "pending");
    assert.equal(
      outcome.kind === "pending" ? outcome.retryRecorded : true,
      false,
    );
    assert.equal(finishCalls, 2);
  }
});

test("cancel lease never overwrites a third real Auth identity", async () => {
  let updates = 0;
  const admin = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_account_reactivation_job") {
        return {
          data: lease({ action: "cancel" }),
          error: null,
        };
      }
      if (name === "finish_account_reactivation_job") {
        assert.equal(args?.p_success, false);
        assert.equal(args?.p_error, "auth_identity_conflict");
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "pending",
            result: null,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: { user: authUser("someone-else@example.test") },
      error: null,
    }),
    updateUserById: async () => {
      updates += 1;
      return { data: { user: null }, error: null };
    },
  });
  const outcome = await processAccountReactivationJob(
    admin,
    correlation,
  );
  assert.equal(outcome.kind, "pending");
  assert.equal(updates, 0);
});

test("cancel lease accepts only exact GoTrue user_not_found as missing", async () => {
  let updates = 0;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_job") {
        return {
          data: lease({ action: "cancel" }),
          error: null,
        };
      }
      if (name === "finish_account_reactivation_job") {
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "cancelled",
            result: cancelledResult(),
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: { user: null },
      error: {
        name: "AuthApiError",
        status: 404,
        code: "user_not_found",
      },
    }),
    updateUserById: async () => {
      updates += 1;
      return { data: { user: null }, error: null };
    },
  });
  assert.equal(
    (await processAccountReactivationJob(admin, correlation)).kind,
    "cancelled",
  );
  assert.equal(updates, 0);

  const transportFailure = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_account_reactivation_job") {
        return {
          data: lease({ action: "cancel" }),
          error: null,
        };
      }
      if (name === "finish_account_reactivation_job") {
        assert.equal(args?.p_success, false);
        return {
          data: {
            ok: true,
            request_id: REQUEST_ID,
            status: "pending",
            result: null,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: { user: null },
      error: {
        name: "AuthApiError",
        status: 503,
        code: "upstream_unavailable",
      },
    }),
  });
  assert.equal(
    (await processAccountReactivationJob(
      transportFailure,
      correlation,
    )).kind,
    "pending",
  );
});

function legacyRepairLease() {
  return {
    status: "leased",
    job_id: REQUEST_ID,
    user_id: USER_ID,
    email: EMAIL,
    expected_withdrawal_generation: 0,
    lease_token: LEASE_TOKEN,
    lease_version: 1,
    attempt_count: 1,
    preflight_error: null,
  };
}

function emptyQueueHealth() {
  return {
    ok: true,
    retry_pending: 0,
    oldest_pending: null,
    legacy_repair_pending: 0,
    oldest_legacy_repair: null,
  };
}

test("rolling legacy repair converges marker to exact member email", async () => {
  let authEmail = deletedEmailMarker(USER_ID);
  let authFence: Record<string, unknown> | undefined;
  const rpcOrder: string[] = [];
  const admin = adminFrom({
    rpc: async (name, args) => {
      rpcOrder.push(name);
      if (name === "claim_account_reactivation_legacy_repair") {
        return { data: legacyRepairLease(), error: null };
      }
      if (
        name ===
          "arm_account_reactivation_legacy_repair_auth_fence"
      ) {
        assert.deepEqual(args, {
          p_job_id: REQUEST_ID,
          p_user_id: USER_ID,
          p_lease_token: LEASE_TOKEN,
          p_lease_version: 1,
        });
        authFence = legacyRepairFence();
        return { data: legacyRepairArmedResult(), error: null };
      }
      if (name === "finish_account_reactivation_legacy_repair") {
        assert.equal(args?.p_success, true);
        return {
          data: {
            ok: true,
            job_id: REQUEST_ID,
            status: "completed",
          },
          error: null,
        };
      }
      if (name === "get_account_reactivation_queue_health") {
        return { data: emptyQueueHealth(), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: {
        user: authUser(
          authEmail,
          authFence
            ? { bp_reactivation_fence: authFence }
            : {},
        ),
      },
      error: null,
    }),
    updateUserById: async (_userId, body) => {
      assert.deepEqual(body, {
        email: EMAIL,
        email_confirm: true,
      });
      authEmail = EMAIL;
      return {
        data: {
          user: authUser(authEmail, {
            bp_reactivation_fence: authFence,
          }),
        },
        error: null,
      };
    },
  });
  const result = await drainAccountReactivationJobs(admin, 1);
  assert.equal(result.claimed, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.pending, 0);
  assert.deepEqual(rpcOrder, [
    "claim_account_reactivation_legacy_repair",
    "arm_account_reactivation_legacy_repair_auth_fence",
    "finish_account_reactivation_legacy_repair",
    "get_account_reactivation_queue_health",
  ]);
});

test("rolling legacy repair confirms a committed Auth update after throw", async () => {
  let authEmail = deletedEmailMarker(USER_ID);
  let authFence: Record<string, unknown> | undefined;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_legacy_repair") {
        return { data: legacyRepairLease(), error: null };
      }
      if (
        name ===
          "arm_account_reactivation_legacy_repair_auth_fence"
      ) {
        authFence = legacyRepairFence();
        return { data: legacyRepairArmedResult(), error: null };
      }
      if (name === "finish_account_reactivation_legacy_repair") {
        return {
          data: {
            ok: true,
            job_id: REQUEST_ID,
            status: "completed",
          },
          error: null,
        };
      }
      if (name === "get_account_reactivation_queue_health") {
        return { data: emptyQueueHealth(), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: {
        user: authUser(
          authEmail,
          authFence
            ? { bp_reactivation_fence: authFence }
            : {},
        ),
      },
      error: null,
    }),
    updateUserById: async () => {
      authEmail = EMAIL;
      throw new Error("response_lost_after_commit");
    },
  });
  const result = await drainAccountReactivationJobs(admin, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.pending, 0);
});

test("rolling legacy repair confirms a committed Auth update after resolved error", async () => {
  let authEmail = deletedEmailMarker(USER_ID);
  let authFence: Record<string, unknown> | undefined;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_legacy_repair") {
        return { data: legacyRepairLease(), error: null };
      }
      if (
        name ===
          "arm_account_reactivation_legacy_repair_auth_fence"
      ) {
        authFence = legacyRepairFence();
        return { data: legacyRepairArmedResult(), error: null };
      }
      if (name === "finish_account_reactivation_legacy_repair") {
        return {
          data: {
            ok: true,
            job_id: REQUEST_ID,
            status: "completed",
          },
          error: null,
        };
      }
      if (name === "get_account_reactivation_queue_health") {
        return { data: emptyQueueHealth(), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: {
        user: authUser(
          authEmail,
          authFence
            ? { bp_reactivation_fence: authFence }
            : {},
        ),
      },
      error: null,
    }),
    updateUserById: async () => {
      authEmail = EMAIL;
      return {
        data: { user: null },
        error: { message: "response_lost_after_commit" },
      };
    },
  });
  const result = await drainAccountReactivationJobs(admin, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.pending, 0);
});

test("rolling legacy repair confirms an arm response lost after commit", async () => {
  let authEmail = deletedEmailMarker(USER_ID);
  let authFence: Record<string, unknown> | undefined;
  let updates = 0;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_legacy_repair") {
        return { data: legacyRepairLease(), error: null };
      }
      if (
        name ===
          "arm_account_reactivation_legacy_repair_auth_fence"
      ) {
        authFence = legacyRepairFence();
        return {
          data: null,
          error: { message: "response_lost_after_commit" },
        };
      }
      if (name === "finish_account_reactivation_legacy_repair") {
        return {
          data: {
            ok: true,
            job_id: REQUEST_ID,
            status: "completed",
          },
          error: null,
        };
      }
      if (name === "get_account_reactivation_queue_health") {
        return { data: emptyQueueHealth(), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: {
        user: authUser(
          authEmail,
          authFence
            ? { bp_reactivation_fence: authFence }
            : {},
        ),
      },
      error: null,
    }),
    updateUserById: async () => {
      updates += 1;
      authEmail = EMAIL;
      return {
        data: {
          user: authUser(authEmail, {
            bp_reactivation_fence: authFence,
          }),
        },
        error: null,
      };
    },
  });
  const result = await drainAccountReactivationJobs(admin, 1);
  assert.equal(result.completed, 1);
  assert.equal(updates, 1);
});

test("rolling legacy repair recovers a lost finish from exact durable status", async () => {
  let statusReads = 0;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_legacy_repair") {
        return { data: legacyRepairLease(), error: null };
      }
      if (name === "finish_account_reactivation_legacy_repair") {
        return { data: null, error: { message: "response lost" } };
      }
      if (
        name ===
          "get_account_reactivation_legacy_repair_status"
      ) {
        statusReads += 1;
        return {
          data: {
            ok: true,
            job_id: REQUEST_ID,
            user_id: USER_ID,
            status: "completed",
          },
          error: null,
        };
      }
      if (name === "get_account_reactivation_queue_health") {
        return { data: emptyQueueHealth(), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: { user: authUser(EMAIL) },
      error: null,
    }),
  });
  const result = await drainAccountReactivationJobs(admin, 1);
  assert.equal(result.completed, 1);
  assert.equal(result.pending, 0);
  assert.equal(statusReads, 1);
});

test("rolling legacy repair never overwrites a third email and exposes backlog", async () => {
  let updates = 0;
  const admin = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_account_reactivation_legacy_repair") {
        return { data: legacyRepairLease(), error: null };
      }
      if (name === "finish_account_reactivation_legacy_repair") {
        assert.equal(args?.p_success, false);
        return {
          data: {
            ok: true,
            job_id: REQUEST_ID,
            status: "pending",
          },
          error: null,
        };
      }
      if (name === "get_account_reactivation_queue_health") {
        return {
          data: {
            ...emptyQueueHealth(),
            legacy_repair_pending: 1,
            oldest_legacy_repair: {
              job_id: REQUEST_ID,
              user_id: USER_ID,
              status: "pending",
              last_error:
                "legacy_repair_auth_identity_conflict",
              retry_at: "2026-07-20T01:03:03.000Z",
            },
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => ({
      data: { user: authUser("someone-else@example.test") },
      error: null,
    }),
    updateUserById: async () => {
      updates += 1;
      return { data: { user: null }, error: null };
    },
  });
  const result = await drainAccountReactivationJobs(admin, 1);
  assert.equal(result.pending, 1);
  assert.equal(result.retryBacklog, 1);
  assert.equal(result.backlogSample?.requestId, REQUEST_ID);
  assert.equal(updates, 0);
});

test("rolling legacy repair supersedes a later withdrawal without Auth access", async () => {
  let authReads = 0;
  const admin = adminFrom({
    rpc: async (name) => {
      if (name === "claim_account_reactivation_legacy_repair") {
        return {
          data: {
            status: "superseded",
            job_id: REQUEST_ID,
            user_id: USER_ID,
          },
          error: null,
        };
      }
      if (name === "get_account_reactivation_queue_health") {
        return { data: emptyQueueHealth(), error: null };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    getUserById: async () => {
      authReads += 1;
      return { data: { user: null }, error: null };
    },
  });
  const result = await drainAccountReactivationJobs(admin, 1);
  assert.equal(result.completed, 1);
  assert.equal(authReads, 0);
});
