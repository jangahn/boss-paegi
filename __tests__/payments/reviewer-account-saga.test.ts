import test from "node:test";
import assert from "node:assert/strict";
import {
  drainReviewerAccountJobs,
  generateReviewerPassword,
  parseReviewerJobStart,
  processReviewerAccountJob,
  reviewerCredentialResetRequired,
} from "../../lib/reviewer-account-saga.ts";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OPERATION_ID = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const LEASE_ONE = "44444444-4444-4444-8444-444444444444";
const LEASE_TWO = "55555555-5555-4555-8555-555555555555";
const EMAIL = "reviewer@example.test";

type ProcessAdmin = Parameters<typeof processReviewerAccountJob>[0];
type RpcResult = { data: unknown | null; error: unknown };

function lease(options?: {
  action?: "provision" | "set_active" | "reset_password" | "delete";
  userId?: string | null;
  desiredActive?: boolean | null;
  leaseToken?: string;
  leaseVersion?: number;
  attemptCount?: number;
}) {
  return {
    job_id: JOB_ID,
    operation_id: OPERATION_ID,
    action: options?.action ?? "provision",
    user_id: options?.userId ?? null,
    email: EMAIL,
    desired_active: options?.desiredActive ?? null,
    lease_token: options?.leaseToken ?? LEASE_ONE,
    lease_version: options?.leaseVersion ?? 1,
    attempt_count: options?.attemptCount ?? 1,
  };
}

function reviewerUser(options?: {
  appMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
  bannedUntil?: string | null;
}) {
  return {
    id: USER_ID,
    email: EMAIL,
    app_metadata: options?.appMetadata ?? {
      reviewer: true,
      reviewer_job_id: JOB_ID,
    },
    user_metadata: options?.userMetadata ?? {},
    banned_until: options?.bannedUntil ?? null,
  };
}

function adminFrom(options: {
  rpc: (name: string, args: Record<string, unknown>) => Promise<RpcResult>;
  listUsers?: () => Promise<{
    data: { users: ReturnType<typeof reviewerUser>[] } | null;
    error: unknown;
  }>;
  createUser?: (
    body: Record<string, unknown>,
  ) => Promise<{
    data: { user: ReturnType<typeof reviewerUser> | null } | null;
    error: unknown;
  }>;
  getUserById?: () => Promise<{
    data: { user: ReturnType<typeof reviewerUser> | null } | null;
    error: unknown;
  }>;
  updateUserById?: (
    userId: string,
    body: Record<string, unknown>,
  ) => Promise<{
    data: { user: ReturnType<typeof reviewerUser> | null } | null;
    error: unknown;
  }>;
}): ProcessAdmin {
  return {
    rpc: options.rpc,
    auth: {
      admin: {
        listUsers:
          options.listUsers ??
          (async () => ({ data: { users: [] }, error: null })),
        createUser:
          options.createUser ??
          (async () => ({ data: { user: null }, error: null })),
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

test("reviewer job start parser rejects malformed, missing, and impossible states", () => {
  const valid = parseReviewerJobStart({
    ok: true,
    job_id: JOB_ID,
    action: "provision",
    status: "pending",
    user_id: null,
    replayed: false,
  });
  assert.equal(valid.jobId, JOB_ID);
  assert.equal(valid.userId, null);

  for (const invalid of [
    null,
    "pending",
    {},
    {
      ok: true,
      job_id: JOB_ID,
      action: "provision",
      status: "completed",
      user_id: null,
      replayed: true,
    },
    {
      ok: true,
      job_id: "not-a-uuid",
      action: "delete",
      status: "pending",
      user_id: USER_ID,
      replayed: false,
    },
    {
      ok: true,
      job_id: JOB_ID,
      action: "unknown",
      status: "pending",
      user_id: USER_ID,
      replayed: false,
    },
  ]) {
    assert.throws(() => parseReviewerJobStart(invalid));
  }
});

test("generated reviewer password is secret-only, bounded, and unambiguous", () => {
  const short = generateReviewerPassword(1);
  const long = generateReviewerPassword(10_000);
  assert.equal(short.length, 16);
  assert.equal(long.length, 128);
  assert.match(
    short,
    /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]+$/,
  );
  assert.match(
    long,
    /^[ABCDEFGHJKLMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789]+$/,
  );
  assert.notEqual(short, generateReviewerPassword(16));
  assert.equal(generateReviewerPassword(Number.NaN).length, 16);
  assert.equal(generateReviewerPassword(Number.POSITIVE_INFINITY).length, 16);
});

test("Auth create followed by DB checkpoint failure stays durable and recovers the orphan without duplicate create", async () => {
  const createdUser = reviewerUser();
  const firstFinishArgs: Record<string, unknown>[] = [];
  let createCount = 0;
  const first = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_reviewer_account_job") {
        return { data: lease(), error: null };
      }
      if (name === "record_reviewer_provision_auth") {
        return { data: null, error: { message: "checkpoint unavailable" } };
      }
      if (name === "finish_reviewer_account_job") {
        firstFinishArgs.push(args);
        return {
          data: { ok: true, job_id: JOB_ID, status: "pending" },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    createUser: async (body) => {
      createCount += 1;
      assert.equal(body.email, EMAIL);
      assert.equal(
        (body.app_metadata as Record<string, unknown>).reviewer_job_id,
        JOB_ID,
      );
      assert.equal(typeof body.password, "string");
      return { data: { user: createdUser }, error: null };
    },
  });

  const firstOutcome = await processReviewerAccountJob(first, JOB_ID);
  assert.deepEqual(firstOutcome, {
    kind: "pending",
    jobId: JOB_ID,
    action: "provision",
    attemptCount: 1,
    failure: "reviewer.provision.record_auth",
    retryRecorded: true,
  });
  assert.equal(createCount, 1);
  assert.equal(firstFinishArgs.length, 1);
  assert.equal(firstFinishArgs[0].p_success, false);

  let listCount = 0;
  const second = adminFrom({
    rpc: async (name) => {
      if (name === "claim_reviewer_account_job") {
        return {
          data: lease({
            leaseToken: LEASE_TWO,
            leaseVersion: 2,
            attemptCount: 2,
          }),
          error: null,
        };
      }
      if (name === "record_reviewer_provision_auth") {
        return {
          data: { ok: true, job_id: JOB_ID, user_id: USER_ID },
          error: null,
        };
      }
      if (name === "finalize_reviewer_provision") {
        return {
          data: {
            ok: true,
            job_id: JOB_ID,
            status: "completed",
            user_id: USER_ID,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    listUsers: async () => {
      listCount += 1;
      return { data: { users: [createdUser] }, error: null };
    },
    createUser: async () => {
      createCount += 1;
      throw new Error("orphan recovery must not create another Auth user");
    },
  });

  const recovered = await processReviewerAccountJob(second, JOB_ID);
  assert.equal(recovered.kind, "completed");
  assert.equal(recovered.userId, USER_ID);
  assert.equal(
    recovered.kind === "completed" ? recovered.issuedPassword : "unexpected",
    undefined,
  );
  assert.equal(listCount, 1);
  assert.equal(createCount, 1);
});

test("thrown Auth create response loss is durably retried and recovers only the exact app-metadata job orphan", async () => {
  const committedOrphan = reviewerUser();
  const first = adminFrom({
    rpc: async (name) => {
      if (name === "claim_reviewer_account_job") {
        return { data: lease(), error: null };
      }
      if (name === "finish_reviewer_account_job") {
        return {
          data: { ok: true, job_id: JOB_ID, status: "pending" },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    createUser: async () => {
      // Simulates GoTrue committing the user but the HTTP client throwing.
      throw new Error("connection reset after commit");
    },
  });
  const uncertain = await processReviewerAccountJob(first, JOB_ID);
  assert.equal(uncertain.kind, "pending");
  assert.equal(
    uncertain.kind === "pending" ? uncertain.failure : "unexpected",
    "auth_create_threw",
  );

  let duplicateCreates = 0;
  const recovery = adminFrom({
    rpc: async (name) => {
      if (name === "claim_reviewer_account_job") {
        return {
          data: lease({
            leaseToken: LEASE_TWO,
            leaseVersion: 2,
            attemptCount: 2,
          }),
          error: null,
        };
      }
      if (name === "record_reviewer_provision_auth") {
        return {
          data: { ok: true, job_id: JOB_ID, user_id: USER_ID },
          error: null,
        };
      }
      if (name === "finalize_reviewer_provision") {
        return {
          data: {
            ok: true,
            job_id: JOB_ID,
            status: "completed",
            user_id: USER_ID,
          },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    listUsers: async () => ({
      data: { users: [committedOrphan] },
      error: null,
    }),
    createUser: async () => {
      duplicateCreates += 1;
      return { data: { user: committedOrphan }, error: null };
    },
  });
  const converged = await processReviewerAccountJob(recovery, JOB_ID);
  assert.equal(converged.kind, "completed");
  assert.equal(duplicateCreates, 0);
});

test("lost DB finish response after a confirmed ban is retried under a new fence", async () => {
  const futureBan = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  const updateBodies: Record<string, unknown>[] = [];
  let finishCalls = 0;
  const first = adminFrom({
    rpc: async (name) => {
      if (name === "claim_reviewer_account_job") {
        return {
          data: lease({
            action: "set_active",
            userId: USER_ID,
            desiredActive: false,
          }),
          error: null,
        };
      }
      if (name === "finish_reviewer_account_job") {
        finishCalls += 1;
        return { data: null, error: { message: "response lost" } };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    updateUserById: async (userId, body) => {
      assert.equal(userId, USER_ID);
      updateBodies.push(body);
      return {
        data: { user: reviewerUser({ bannedUntil: futureBan }) },
        error: null,
      };
    },
  });

  const uncertain = await processReviewerAccountJob(first, JOB_ID);
  assert.deepEqual(uncertain, {
    kind: "pending",
    jobId: JOB_ID,
    action: "set_active",
    attemptCount: 1,
    failure: "reviewer.job.finish",
    retryRecorded: false,
  });
  assert.equal(finishCalls, 2);

  const second = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_reviewer_account_job") {
        return {
          data: lease({
            action: "set_active",
            userId: USER_ID,
            desiredActive: false,
            leaseToken: LEASE_TWO,
            leaseVersion: 2,
            attemptCount: 2,
          }),
          error: null,
        };
      }
      if (name === "finish_reviewer_account_job") {
        assert.equal(args.p_success, true);
        return {
          data: { ok: true, job_id: JOB_ID, status: "completed" },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    updateUserById: async (_userId, body) => {
      updateBodies.push(body);
      return {
        data: { user: reviewerUser({ bannedUntil: futureBan }) },
        error: null,
      };
    },
  });
  const converged = await processReviewerAccountJob(second, JOB_ID);
  assert.equal(converged.kind, "completed");
  assert.deepEqual(updateBodies, [
    { ban_duration: "876000h" },
    { ban_duration: "876000h" },
  ]);
});

test("password reset response loss never pretends the plaintext is recoverable and a new fence safely reissues it", async () => {
  const writtenPasswords: string[] = [];
  let finishCalls = 0;
  const first = adminFrom({
    rpc: async (name) => {
      if (name === "claim_reviewer_account_job") {
        return {
          data: lease({
            action: "reset_password",
            userId: USER_ID,
          }),
          error: null,
        };
      }
      if (name === "finish_reviewer_account_job") {
        finishCalls += 1;
        return { data: null, error: { message: "finish response lost" } };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    updateUserById: async (_userId, body) => {
      writtenPasswords.push(String(body.password));
      return { data: { user: reviewerUser() }, error: null };
    },
  });
  const uncertain = await processReviewerAccountJob(first, JOB_ID);
  assert.equal(uncertain.kind, "pending");
  assert.equal(finishCalls, 2);
  assert.equal("issuedPassword" in uncertain, false);
  assert.equal(
    reviewerCredentialResetRequired("reset_password"),
    true,
    "a completed receipt replay has no stored plaintext and must demand reissue",
  );

  const second = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_reviewer_account_job") {
        return {
          data: lease({
            action: "reset_password",
            userId: USER_ID,
            leaseToken: LEASE_TWO,
            leaseVersion: 2,
            attemptCount: 2,
          }),
          error: null,
        };
      }
      if (name === "finish_reviewer_account_job") {
        assert.equal(args.p_success, true);
        return {
          data: { ok: true, job_id: JOB_ID, status: "completed" },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    updateUserById: async (_userId, body) => {
      writtenPasswords.push(String(body.password));
      return { data: { user: reviewerUser() }, error: null };
    },
  });
  const reissued = await processReviewerAccountJob(second, JOB_ID);
  assert.equal(reissued.kind, "completed");
  assert.equal(
    reissued.kind === "completed" ? reissued.issuedPassword : null,
    writtenPasswords[1],
  );
  assert.notEqual(writtenPasswords[0], writtenPasswords[1]);
  assert.equal(
    reviewerCredentialResetRequired(
      "reset_password",
      reissued.kind === "completed" ? reissued.issuedPassword : undefined,
    ),
    false,
  );
});

test("ordinary Auth email collision is terminal and never overwritten or duplicated", async () => {
  let createCount = 0;
  let terminal = false;
  const admin = adminFrom({
    rpc: async (name, args) => {
      if (name === "claim_reviewer_account_job") {
        return { data: lease(), error: null };
      }
      if (name === "finish_reviewer_account_job") {
        terminal = args.p_terminal === true;
        return {
          data: { ok: true, job_id: JOB_ID, status: "failed" },
          error: null,
        };
      }
      throw new Error(`unexpected RPC ${name}`);
    },
    listUsers: async () => ({
      data: {
        users: [
          reviewerUser({
            appMetadata: {},
            userMetadata: {
              reviewer: true,
              reviewer_job_id: JOB_ID,
            },
          }),
        ],
      },
      error: null,
    }),
    createUser: async () => {
      createCount += 1;
      return { data: { user: reviewerUser() }, error: null };
    },
  });
  const outcome = await processReviewerAccountJob(admin, JOB_ID);
  assert.equal(outcome.kind, "failed");
  assert.equal(
    outcome.kind === "failed" ? outcome.failure : "unexpected",
    "auth_email_conflict",
  );
  assert.equal(terminal, true);
  assert.equal(createCount, 0);
});

test("malformed claims fail closed while idle and bounded drain remain explicit", async () => {
  const malformed = adminFrom({
    rpc: async () => ({
      data: {
        ...lease(),
        lease_version: -1,
      },
      error: null,
    }),
  });
  await assert.rejects(() => processReviewerAccountJob(malformed, JOB_ID));

  let claims = 0;
  const idle = adminFrom({
    rpc: async (name) => {
      assert.equal(name, "claim_reviewer_account_job");
      claims += 1;
      return { data: null, error: null };
    },
  });
  assert.deepEqual(await processReviewerAccountJob(idle), { kind: "idle" });
  assert.deepEqual(await drainReviewerAccountJobs(idle, 10_000), {
    claimed: 0,
    completed: 0,
    pending: 0,
    failed: 0,
    claimErrors: 0,
  });
  assert.equal(claims, 2);
});
