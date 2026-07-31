import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  OAUTH_FLOW_PRUNE_RESULT_KEYS,
  oauthFlowPruneHasBacklog,
  parseOAuthFlowPruneResult,
  type OAuthFlowPruneResult,
} from "../../lib/oauth-flow-prune.ts";
import {
  OAUTH_PRUNE_ACK_KEYS,
} from "../../scripts/qa/apply-oauth-production-rollout.mjs";

const ZERO_RESULT: OAuthFlowPruneResult = {
  expiredPending: 0,
  boundRecoveryConverged: 0,
  prunedTerminal: 0,
  targetAuthorityLossConverged: 0,
  targetAuthorityLossBacklog: 0,
  pendingExpiryBacklog: 0,
  terminalRetentionBacklog: 0,
  unconsumedMigrationBacklog: 0,
  unreleasedContinueBacklog: 0,
  unboundClaimBacklog: 0,
  boundRecoveryBacklog: 0,
};

test("OAuth flow pruning parser keys exactly match the 0093 SQL acknowledgement", () => {
  assert.deepEqual(
    OAUTH_PRUNE_ACK_KEYS,
    OAUTH_FLOW_PRUNE_RESULT_KEYS,
    "the production rollout source gate must share the application contract",
  );
  const migration = readFileSync(
    new URL(
      "../../supabase/migrations/0093_oauth_flow_intents.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const functionBody = migration.match(
    /create or replace function public\.prune_oauth_flow_intents\([\s\S]*?returns jsonb[\s\S]*?as \$\$([\s\S]*?)\$\$;/u,
  )?.[1];
  assert.ok(functionBody, "prune_oauth_flow_intents body must exist");
  const acknowledgement = functionBody.match(
    /return pg_catalog\.jsonb_build_object\(([\s\S]*?)\);\s*end;/u,
  )?.[1];
  assert.ok(acknowledgement, "prune acknowledgement must be explicit");
  const sqlKeys = [
    ...acknowledgement.matchAll(/'([^']+)'\s*,/gu),
  ].map(([, key]) => key);
  assert.deepEqual(
    new Set(sqlKeys),
    new Set(OAUTH_FLOW_PRUNE_RESULT_KEYS),
  );
  assert.equal(sqlKeys.length, OAUTH_FLOW_PRUNE_RESULT_KEYS.length);
});

test("OAuth flow pruning accepts an exact eleven-key non-negative integer acknowledgement", () => {
  assert.deepEqual(parseOAuthFlowPruneResult(ZERO_RESULT), ZERO_RESULT);
  assert.deepEqual(
    parseOAuthFlowPruneResult({
      unboundClaimBacklog: 7,
      boundRecoveryBacklog: 10,
      unreleasedContinueBacklog: 6,
      unconsumedMigrationBacklog: 5,
      terminalRetentionBacklog: 4,
      pendingExpiryBacklog: 3,
      targetAuthorityLossBacklog: 2,
      targetAuthorityLossConverged: 1,
      prunedTerminal: 8,
      expiredPending: 9,
      boundRecoveryConverged: 11,
    }),
    {
      expiredPending: 9,
      boundRecoveryConverged: 11,
      prunedTerminal: 8,
      targetAuthorityLossConverged: 1,
      targetAuthorityLossBacklog: 2,
      pendingExpiryBacklog: 3,
      terminalRetentionBacklog: 4,
      unconsumedMigrationBacklog: 5,
      unreleasedContinueBacklog: 6,
      unboundClaimBacklog: 7,
      boundRecoveryBacklog: 10,
    },
    "wire key order must not affect the acknowledgement",
  );
});

test("OAuth flow pruning rejects every missing or additional response key", () => {
  for (const missingKey of OAUTH_FLOW_PRUNE_RESULT_KEYS) {
    const candidate = { ...ZERO_RESULT } as Record<string, unknown>;
    delete candidate[missingKey];
    assert.equal(
      parseOAuthFlowPruneResult(candidate),
      null,
      `missing ${missingKey}`,
    );
  }

  assert.equal(
    parseOAuthFlowPruneResult({ ...ZERO_RESULT, unexpected: 0 }),
    null,
    "additional keys are schema drift",
  );
});

test("OAuth flow pruning rejects every non-count value at every response key", () => {
  const invalidValues: readonly unknown[] = [
    -1,
    0.5,
    "1",
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    undefined,
    true,
    {},
    [],
  ];

  for (const key of OAUTH_FLOW_PRUNE_RESULT_KEYS) {
    for (const invalidValue of invalidValues) {
      assert.equal(
        parseOAuthFlowPruneResult({
          ...ZERO_RESULT,
          [key]: invalidValue,
        }),
        null,
        `${key} must reject ${String(invalidValue)}`,
      );
    }
  }
});

test("OAuth flow pruning rejects every non-object response shape", () => {
  for (const candidate of [
    null,
    undefined,
    false,
    0,
    1,
    "",
    "object",
    [],
    [0, 0, 0, 0, 0, 0, 0],
  ]) {
    assert.equal(parseOAuthFlowPruneResult(candidate), null);
  }
});

test("only authoritative backlog fields keep OAuth pruning non-green", () => {
  const backlogKeys = [
    "pendingExpiryBacklog",
    "targetAuthorityLossBacklog",
    "terminalRetentionBacklog",
    "unconsumedMigrationBacklog",
    "unreleasedContinueBacklog",
    "unboundClaimBacklog",
    "boundRecoveryBacklog",
  ] as const;
  const workCounterKeys = [
    "expiredPending",
    "prunedTerminal",
    "targetAuthorityLossConverged",
    "boundRecoveryConverged",
  ] as const;

  assert.equal(oauthFlowPruneHasBacklog(ZERO_RESULT), false);
  for (const key of backlogKeys) {
    assert.equal(
      oauthFlowPruneHasBacklog({ ...ZERO_RESULT, [key]: 1 }),
      true,
      `${key} must keep maintenance non-green`,
    );
  }
  for (const key of workCounterKeys) {
    assert.equal(
      oauthFlowPruneHasBacklog({ ...ZERO_RESULT, [key]: 1 }),
      false,
      `${key} is completed work, not an authoritative backlog`,
    );
  }
});
