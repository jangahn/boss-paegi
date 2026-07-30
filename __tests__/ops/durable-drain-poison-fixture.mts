// Executed through the repository's Next-compatible Node loader.
import assert from "node:assert/strict";
import test from "node:test";
import { drainAccountDeletionCleanupJobs } from "../../lib/account-delete-cleanup-job.ts";
import { drainModerationPurgeJobs } from "../../lib/moderation-purge-job.ts";
import { drainReviewerAccountJobs } from "../../lib/reviewer-account-saga.ts";
import {
  drainStorageObjectCleanupJobs,
  drainUploadCleanupJobs,
} from "../../lib/storage-cleanup-jobs.ts";

type Drain = (admin: unknown, limit: number) => Promise<unknown>;

const drains: Array<{
  name: string;
  run: Drain;
  empty: Record<string, number>;
}> = [
  {
    name: "account deletion",
    run: (admin, limit) =>
      drainAccountDeletionCleanupJobs(
        admin as Parameters<typeof drainAccountDeletionCleanupJobs>[0],
        limit,
      ),
    empty: { claimed: 0, completed: 0, pending: 0, claimErrors: 1 },
  },
  {
    name: "moderation purge",
    run: (admin, limit) =>
      drainModerationPurgeJobs(
        admin as Parameters<typeof drainModerationPurgeJobs>[0],
        limit,
      ),
    empty: { claimed: 0, completed: 0, pending: 0, claimErrors: 1 },
  },
  {
    name: "reviewer account",
    run: (admin, limit) =>
      drainReviewerAccountJobs(
        admin as Parameters<typeof drainReviewerAccountJobs>[0],
        limit,
      ),
    empty: {
      claimed: 0,
      completed: 0,
      pending: 0,
      failed: 0,
      claimErrors: 1,
    },
  },
  {
    name: "storage upload",
    run: (admin, limit) =>
      drainUploadCleanupJobs(
        admin as Parameters<typeof drainUploadCleanupJobs>[0],
        limit,
      ),
    empty: { claimed: 0, completed: 0, pending: 0, claimErrors: 1 },
  },
  {
    name: "storage object",
    run: (admin, limit) =>
      drainStorageObjectCleanupJobs(
        admin as Parameters<typeof drainStorageObjectCleanupJobs>[0],
        limit,
      ),
    empty: { claimed: 0, completed: 0, pending: 0, claimErrors: 1 },
  },
];

test("a semantically poisoned leased row cannot starve the next due row", async () => {
  for (const scenario of drains) {
    let calls = 0;
    const admin = {
      rpc: async () => {
        calls += 1;
        return calls === 1
          ? { data: {}, error: null }
          : { data: null, error: null };
      },
    };

    assert.deepEqual(
      await scenario.run(admin, 2),
      scenario.empty,
      scenario.name,
    );
    assert.equal(
      calls,
      2,
      `${scenario.name} must continue after the committed malformed lease`,
    );
  }
});

test("a claim transport/RPC failure stops instead of hammering the dependency", async () => {
  for (const scenario of drains) {
    let calls = 0;
    const admin = {
      rpc: async () => {
        calls += 1;
        return {
          data: null,
          error: { message: "claim dependency unavailable" },
        };
      },
    };

    assert.deepEqual(
      await scenario.run(admin, 50),
      scenario.empty,
      scenario.name,
    );
    assert.equal(
      calls,
      1,
      `${scenario.name} must stop after an uncommitted claim failure`,
    );
  }
});
