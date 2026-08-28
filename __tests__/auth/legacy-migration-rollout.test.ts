import assert from "node:assert/strict";
import crypto from "node:crypto";
import { register } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";

const SERVICE_KEY = "legacy-migration-rollout-test-secret";
const SOURCE_USER_ID =
  "11111111-1111-4111-8111-111111111111";
const TARGET_USER_ID =
  "22222222-2222-4222-8222-222222222222";
const TARGET_SESSION_ID =
  "33333333-3333-4333-8333-333333333333";
const FLOW_ID =
  "44444444-4444-4444-8444-444444444444";
const TARGET_ACCESS_TOKEN_SHA256 = "a".repeat(64);
const TARGET_REFRESH_TOKEN_SHA256 = "b".repeat(64);

process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_KEY;
register(
  "./__tests__/telemetry/node-loader.mjs",
  pathToFileURL(`${process.cwd()}/`),
);

const { migrateAnonData } = await import(
  "../../lib/account-onboard.ts"
);
const { MIGRATE_MAX_AGE } = await import(
  "../../lib/signup-cookie.ts"
);

const PRE_ALIAS_HANDLER_MAX_SECONDS = 300;
const CONSENT_HANDLER_MAX_SECONDS = 300;
const ROLLOUT_CLOCK_MARGIN_SECONDS = 5;
const LEGACY_DRAIN_SECONDS = 1505;

function flowAuthority() {
  return {
    flowId: FLOW_ID,
    sourceUserId: SOURCE_USER_ID,
    targetSessionId: TARGET_SESSION_ID,
    targetAccessTokenSha256: TARGET_ACCESS_TOKEN_SHA256,
    targetRefreshTokenSha256: TARGET_REFRESH_TOKEN_SHA256,
  };
}

function legacyCookie(
  sourceUserId = SOURCE_USER_ID,
  expiresAt = Date.now() + 15 * 60 * 1000,
): string {
  const payload = `${sourceUserId}.${expiresAt}`;
  const signature = crypto
    .createHmac("sha256", SERVICE_KEY)
    .update(payload)
    .digest("hex");
  return `${payload}.${signature}`;
}

type FixtureOptions = {
  targetMember?: boolean;
  rawReassignError?: Error;
  legacyEnvelope?: unknown;
  legacyMigrationResult?: unknown;
  flowEnvelope?: unknown;
  flowError?: Error;
};

function createFixture(options: FixtureOptions = {}) {
  const rpcCalls: Array<{
    operation: string;
    args: Record<string, unknown>;
  }> = [];
  let deleteCalls = 0;
  let authReadCalls = 0;

  const admin = {
    auth: {
      admin: {
        async getUserById(userId: string) {
          authReadCalls += 1;
          return {
            data: {
              user: {
                id: userId,
                is_anonymous: userId === SOURCE_USER_ID,
              },
            },
            error: null,
          };
        },
        async deleteUser(userId: string) {
          deleteCalls += 1;
          assert.equal(userId, SOURCE_USER_ID);
          // 실 GoTrue 계약: 삭제 성공 응답은 user 를 되돌려주지 않는다(빈 응답).
          return {
            data: { user: null },
            error: null,
          };
        },
      },
    },
    from(table: string) {
      return {
        select() {
          return {
            eq(_column: string, userId: string) {
              if (table === "member_accounts") {
                return {
                  async maybeSingle() {
                    return {
                      data:
                        options.targetMember &&
                        userId === TARGET_USER_ID
                          ? { user_id: TARGET_USER_ID }
                          : null,
                      error: null,
                    };
                  },
                };
              }
              return { count: 0, error: null };
            },
          };
        },
      };
    },
    async rpc(
      operation: string,
      args: Record<string, unknown>,
    ) {
      rpcCalls.push({ operation, args });
      if (
        operation ===
        "consume_legacy_signup_migration"
      ) {
        return {
          data: options.rawReassignError
            ? null
            : "legacyEnvelope" in options
              ? options.legacyEnvelope
            : {
                ok: true,
                sourceUserId: SOURCE_USER_ID,
                targetUserId: TARGET_USER_ID,
                targetSessionId: TARGET_SESSION_ID,
                alreadyConsumed: false,
                consumedAt: new Date().toISOString(),
                migrationResult:
                  options.legacyMigrationResult ?? {
                    ok: true,
                    scores: 0,
                    badges: 0,
                    telemetry: 0,
                  },
              },
          error: options.rawReassignError ?? null,
        };
      }
      if (
        operation ===
        "consume_oauth_flow_intent_migration"
      ) {
        return {
          data: options.flowError
            ? null
            : "flowEnvelope" in options
              ? options.flowEnvelope
              : {
                  ok: true,
                  flowId: FLOW_ID,
                  alreadyConsumed: false,
                  migrationConsumedAt:
                    new Date().toISOString(),
                  migrationResult: {
                    ok: true,
                    scores: 0,
                    badges: 0,
                    telemetry: 0,
                  },
                },
          error: options.flowError ?? null,
        };
      }
      throw new Error(`unexpected RPC: ${operation}`);
    },
  };

  return {
    admin:
      admin as unknown as Parameters<
        typeof migrateAnonData
      >[0],
    rpcCalls,
    get deleteCalls() {
      return deleteCalls;
    },
    get authReadCalls() {
      return authReadCalls;
    },
  };
}

test("a valid pre-ledger cookie uses only the session-bound expand bridge", async () => {
  const fixture = createFixture();

  assert.equal(
    await migrateAnonData(
      fixture.admin,
      TARGET_USER_ID,
      null,
      legacyCookie(),
      TARGET_SESSION_ID,
    ),
    "migrated",
  );
  assert.deepEqual(
    fixture.rpcCalls.map(({ operation }) => operation),
    ["consume_legacy_signup_migration"],
  );
  assert.equal(
    fixture.rpcCalls[0]?.args.p_source_user_id,
    SOURCE_USER_ID,
  );
  assert.equal(
    fixture.rpcCalls[0]?.args.p_target_user_id,
    TARGET_USER_ID,
  );
  assert.equal(
    fixture.rpcCalls[0]?.args.p_target_session_id,
    TARGET_SESSION_ID,
  );
  assert.equal(
    typeof fixture.rpcCalls[0]?.args.p_issued_at,
    "string",
  );
  assert.equal(
    typeof fixture.rpcCalls[0]?.args.p_expires_at,
    "string",
  );
  assert.equal(fixture.deleteCalls, 1);
});

test("invalid, expired, tampered, and same-user legacy capabilities cannot start migration", async () => {
  for (const value of [
    undefined,
    legacyCookie(
      SOURCE_USER_ID,
      Date.now() - 1,
    ),
    `${legacyCookie()}tampered`,
    legacyCookie(TARGET_USER_ID),
  ]) {
    const fixture = createFixture();
    assert.equal(
      await migrateAnonData(
        fixture.admin,
        TARGET_USER_ID,
        null,
        value,
        TARGET_SESSION_ID,
      ),
      "skipped",
    );
    assert.equal(fixture.authReadCalls, 0);
    assert.equal(fixture.rpcCalls.length, 0);
    assert.equal(fixture.deleteCalls, 0);
  }
});

test("the contract drain covers both handler tails and the exact cookie-expiry boundary", async () => {
  assert.equal(
    PRE_ALIAS_HANDLER_MAX_SECONDS +
      MIGRATE_MAX_AGE +
      CONSENT_HANDLER_MAX_SECONDS +
      ROLLOUT_CLOCK_MARGIN_SECONDS,
    LEGACY_DRAIN_SECONDS,
  );

  const boundaryNow = 2_000_000_000_000;
  const originalNow = Date.now;
  try {
    Date.now = () => boundaryNow;
    const atBoundary = createFixture();
    assert.equal(
      await migrateAnonData(
        atBoundary.admin,
        TARGET_USER_ID,
        null,
        legacyCookie(SOURCE_USER_ID, boundaryNow),
        TARGET_SESSION_ID,
      ),
      "migrated",
    );
    assert.deepEqual(
      atBoundary.rpcCalls.map(({ operation }) => operation),
      ["consume_legacy_signup_migration"],
    );

    Date.now = () => boundaryNow + 1;
    const afterBoundary = createFixture();
    assert.equal(
      await migrateAnonData(
        afterBoundary.admin,
        TARGET_USER_ID,
        null,
        legacyCookie(SOURCE_USER_ID, boundaryNow),
        TARGET_SESSION_ID,
      ),
      "skipped",
    );
    assert.equal(afterBoundary.authReadCalls, 0);
    assert.equal(afterBoundary.rpcCalls.length, 0);
    assert.equal(afterBoundary.deleteCalls, 0);
  } finally {
    Date.now = originalNow;
  }
});

test("flow-scoped authority can never be downgraded to the legacy raw primitive", async () => {
  const fixture = createFixture();

  assert.equal(
    await migrateAnonData(
      fixture.admin,
      TARGET_USER_ID,
      flowAuthority(),
      legacyCookie(),
    ),
    "migrated",
  );
  assert.deepEqual(
    fixture.rpcCalls.map(({ operation }) => operation),
    ["consume_oauth_flow_intent_migration"],
  );
  assert.equal(fixture.deleteCalls, 1);
});

test("flow transfer+consent ACK loss replays the DB receipt before a now-existing target member", async () => {
  const fixture = createFixture({
    targetMember: true,
    flowEnvelope: {
      ok: true,
      flowId: FLOW_ID,
      alreadyConsumed: true,
      migrationConsumedAt: new Date().toISOString(),
      migrationResult: {
        ok: true,
        scores: 1,
        badges: 2,
        telemetry: 3,
      },
    },
  });

  assert.equal(
    await migrateAnonData(
      fixture.admin,
      TARGET_USER_ID,
      flowAuthority(),
    ),
    "migrated",
  );
  assert.deepEqual(
    fixture.rpcCalls.map(({ operation }) => operation),
    ["consume_oauth_flow_intent_migration"],
  );
  assert.equal(fixture.authReadCalls, 0);
  assert.equal(fixture.deleteCalls, 1);
});

test("flow no-transfer receipts are terminal and never invoke Auth deletion", async () => {
  for (const skipped of [
    "source_already_absent",
    "target_withdrawn",
    "recovery_expired",
  ]) {
    const fixture = createFixture({
      flowEnvelope: {
        ok: true,
        flowId: FLOW_ID,
        alreadyConsumed: false,
        migrationConsumedAt: new Date().toISOString(),
        migrationResult: {
          ok: true,
          skipped,
        },
      },
    });

    assert.equal(
      await migrateAnonData(
        fixture.admin,
        TARGET_USER_ID,
        flowAuthority(),
      ),
      "skipped",
    );
    assert.equal(fixture.deleteCalls, 0);
  }
});

test("malformed or failed flow-first receipts fail closed before Auth deletion", async () => {
  for (const options of [
    { flowEnvelope: { ok: true } },
    { flowError: new Error("flow RPC unavailable") },
  ]) {
    const fixture = createFixture(options);
    assert.equal(
      await migrateAnonData(
        fixture.admin,
        TARGET_USER_ID,
        flowAuthority(),
      ),
      "failed",
    );
    assert.equal(fixture.deleteCalls, 0);
  }
});

test("legacy bridge errors remain retryable and never delete Auth or create a false success", async () => {
  const injected = new Error("legacy raw reassignment unavailable");
  const fixture = createFixture({
    rawReassignError: injected,
  });

  assert.equal(
    await migrateAnonData(
      fixture.admin,
      TARGET_USER_ID,
      null,
      legacyCookie(),
      TARGET_SESSION_ID,
    ),
    "failed",
  );
  assert.deepEqual(
    fixture.rpcCalls.map(({ operation }) => operation),
    ["consume_legacy_signup_migration"],
  );
  assert.equal(fixture.deleteCalls, 0);
});

test("malformed outer bridge ACKs fail closed before Auth deletion", async () => {
  for (const legacyEnvelope of [
    { ok: true },
    {
      ok: true,
      sourceUserId: SOURCE_USER_ID,
      targetUserId: TARGET_USER_ID,
      targetSessionId: TARGET_SESSION_ID,
      alreadyConsumed: false,
      consumedAt: new Date().toISOString(),
      migrationResult: {
        ok: true,
        scores: 0,
        badges: 0,
        telemetry: 0,
      },
      extra: true,
    },
  ]) {
    const fixture = createFixture({ legacyEnvelope });
    assert.equal(
      await migrateAnonData(
        fixture.admin,
        TARGET_USER_ID,
        null,
        legacyCookie(),
        TARGET_SESSION_ID,
      ),
      "failed",
    );
    assert.equal(fixture.deleteCalls, 0);
  }
});

test("durable legacy no-transfer ACKs never call Auth delete", async () => {
  for (const skipped of [
    "source_already_absent",
    "target_already_claimed",
    "source_already_claimed",
  ]) {
    const fixture = createFixture({
      legacyMigrationResult: { ok: true, skipped },
    });
    assert.equal(
      await migrateAnonData(
        fixture.admin,
        TARGET_USER_ID,
        null,
        legacyCookie(),
        TARGET_SESSION_ID,
      ),
      "skipped",
    );
    assert.equal(fixture.deleteCalls, 0);
  }
});

test("a legacy cookie without an exact target session performs zero I/O", async () => {
  const fixture = createFixture();
  assert.equal(
    await migrateAnonData(
      fixture.admin,
      TARGET_USER_ID,
      null,
      legacyCookie(),
    ),
    "skipped",
  );
  assert.equal(fixture.authReadCalls, 0);
  assert.equal(fixture.rpcCalls.length, 0);
  assert.equal(fixture.deleteCalls, 0);
});

test("a concurrent existing target member preserves legacy no-merge policy", async () => {
  const fixture = createFixture({ targetMember: true });

  assert.equal(
    await migrateAnonData(
      fixture.admin,
      TARGET_USER_ID,
      null,
      legacyCookie(),
      TARGET_SESSION_ID,
    ),
    "skipped",
  );
  assert.equal(fixture.rpcCalls.length, 0);
  assert.equal(fixture.deleteCalls, 0);
});
