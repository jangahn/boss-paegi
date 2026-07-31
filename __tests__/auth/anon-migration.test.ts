// anon-migration.test.ts — 익명 이전의 모든 외부 연산에 resolved error/throw를 주입한다.
// 실행: node --test __tests__/auth/anon-migration.test.ts

import test from "node:test";
import assert from "node:assert/strict";
import {
  isMissingAuthUserError,
  runAnonDataMigration,
  type AnonMigrationAuthorization,
  type AnonMigrationDependencies,
  type AnonMigrationOperation,
} from "../../lib/anon-data-migration.ts";

type InjectableOperation = Exclude<
  AnonMigrationOperation,
  "counts.aggregate" | "authorization.verify"
>;

const SOURCE_USER_ID = "11111111-1111-4111-8111-111111111111";
const TARGET_USER_ID = "22222222-2222-4222-8222-222222222222";
const AUTHORIZATION: AnonMigrationAuthorization = {
  sourceUserId: SOURCE_USER_ID,
  targetUserId: TARGET_USER_ID,
  sourceAuthorityVerified: true,
};
const REASSIGN_SUCCESS = {
  ok: true,
  scores: 0,
  badges: 0,
  telemetry: 0,
} as const;

function successfulDependencies(): AnonMigrationDependencies {
  return {
    getTargetUser: async () => ({
      data: { userId: TARGET_USER_ID, isAnonymous: false },
      error: null,
    }),
    getTargetMember: async () => ({ data: null, error: null }),
    getAnonUser: async () => ({
      data: { isAnonymous: true },
      error: null,
    }),
    getAnonMember: async () => ({ data: null, error: null }),
    countDolls: async () => ({ count: 0, error: null }),
    countOrders: async () => ({ count: 0, error: null }),
    countGenerations: async () => ({ count: 0, error: null }),
    reassign: async () => ({ data: REASSIGN_SUCCESS, error: null }),
    deleteAnonUser: async () => ({ deleted: true, error: null }),
  };
}

function runMigration(
  dependencies: AnonMigrationDependencies,
  authorization: AnonMigrationAuthorization = AUTHORIZATION,
) {
  return runAnonDataMigration(dependencies, authorization);
}

function injectResolvedError(
  dependencies: AnonMigrationDependencies,
  operation: InjectableOperation,
  error: Error,
): void {
  switch (operation) {
    case "auth.get_target_user":
      dependencies.getTargetUser = async () => ({
        data: { userId: TARGET_USER_ID, isAnonymous: false },
        error,
      });
      return;
    case "target_member.read":
      dependencies.getTargetMember = async () => ({ data: null, error });
      return;
    case "auth.get_user":
      dependencies.getAnonUser = async () => ({
        data: { isAnonymous: true },
        error,
      });
      return;
    case "member.read":
      dependencies.getAnonMember = async () => ({ data: null, error });
      return;
    case "dolls.count":
      dependencies.countDolls = async () => ({ count: 0, error });
      return;
    case "orders.count":
      dependencies.countOrders = async () => ({ count: 0, error });
      return;
    case "generations.count":
      dependencies.countGenerations = async () => ({ count: 0, error });
      return;
    case "data.reassign":
      dependencies.reassign = async () => ({ data: REASSIGN_SUCCESS, error });
      return;
    case "auth.delete_user":
      dependencies.deleteAnonUser = async () => ({ deleted: true, error });
      return;
  }
}

function injectThrow(
  dependencies: AnonMigrationDependencies,
  operation: InjectableOperation,
  error: Error,
): void {
  const throwing = async () => {
    throw error;
  };
  switch (operation) {
    case "auth.get_target_user":
      dependencies.getTargetUser = throwing;
      return;
    case "target_member.read":
      dependencies.getTargetMember = throwing;
      return;
    case "auth.get_user":
      dependencies.getAnonUser = throwing;
      return;
    case "member.read":
      dependencies.getAnonMember = throwing;
      return;
    case "dolls.count":
      dependencies.countDolls = throwing;
      return;
    case "orders.count":
      dependencies.countOrders = throwing;
      return;
    case "generations.count":
      dependencies.countGenerations = throwing;
      return;
    case "data.reassign":
      dependencies.reassign = throwing;
      return;
    case "auth.delete_user":
      dependencies.deleteAnonUser = throwing;
      return;
  }
}

const OPERATIONS: InjectableOperation[] = [
  "auth.get_target_user",
  "target_member.read",
  "auth.get_user",
  "member.read",
  "dolls.count",
  "orders.count",
  "generations.count",
  "data.reassign",
  "auth.delete_user",
];

for (const operation of OPERATIONS) {
  test(`${operation}의 resolved { error }는 성공/skip으로 강등되지 않는다`, async () => {
    const dependencies = successfulDependencies();
    const injected = new Error(`injected resolved error: ${operation}`);
    injectResolvedError(dependencies, operation, injected);

    const outcome = await runMigration(dependencies);

    assert.equal(outcome.result, "failed");
    if (outcome.result === "failed") {
      assert.equal(outcome.operation, operation);
      assert.equal(outcome.error, injected);
    }
  });

  test(`${operation}의 throw는 같은 연산의 retryable 실패다`, async () => {
    const dependencies = successfulDependencies();
    const injected = new Error(`injected throw: ${operation}`);
    injectThrow(dependencies, operation, injected);

    const outcome = await runMigration(dependencies);

    assert.equal(outcome.result, "failed");
    if (outcome.result === "failed") {
      assert.equal(outcome.operation, operation);
      assert.equal(outcome.error, injected);
    }
  });
}

test("모든 연산 성공 뒤에만 migrated다", async () => {
  assert.deepEqual(await runMigration(successfulDependencies()), {
    result: "migrated",
  });
});

test("DB가 원자적으로 확정한 no-transfer receipt는 Auth 삭제 없이 exact skip으로 수렴한다", async () => {
  for (const [skipped, reason] of [
    ["target_already_member", "target_is_member"],
    ["source_not_anonymous", "source_not_anonymous"],
    ["source_is_member", "source_is_member"],
    ["unexpected_source_data", "unexpected_data"],
    ["source_generation_changed", "source_generation_changed"],
  ] as const) {
    const dependencies = successfulDependencies();
    let deleteCalls = 0;
    dependencies.reassign = async () => ({
      data: { ok: true, skipped },
      error: null,
    });
    dependencies.deleteAnonUser = async () => {
      deleteCalls += 1;
      return { deleted: true, error: null };
    };

    assert.deepEqual(await runMigration(dependencies), {
      result: "skipped",
      reason,
    });
    assert.equal(deleteCalls, 0);
  }
});

test("unknown 또는 extra-key skip receipt는 Auth 삭제 성공으로 강등하지 않는다", async () => {
  for (const data of [
    { ok: true, skipped: "unknown" },
    {
      ok: true,
      skipped: "target_already_member",
      extra: true,
    },
  ]) {
    const dependencies = successfulDependencies();
    let deleteCalls = 0;
    dependencies.reassign = async () => ({ data, error: null });
    dependencies.deleteAnonUser = async () => {
      deleteCalls += 1;
      return { deleted: true, error: null };
    };

    const outcome = await runMigration(dependencies);
    assert.equal(outcome.result, "failed");
    if (outcome.result === "failed") {
      assert.equal(outcome.operation, "data.reassign");
    }
    assert.equal(deleteCalls, 0);
  }
});

test("서명 source 권한·UUID·source≠target 불변식이 없으면 외부 연산 전에 차단한다", async () => {
  const dependencies = successfulDependencies();
  let targetCalls = 0;
  dependencies.getTargetUser = async () => {
    targetCalls += 1;
    return {
      data: { userId: TARGET_USER_ID, isAnonymous: false },
      error: null,
    };
  };

  const unsigned = await runMigration(dependencies, {
    ...AUTHORIZATION,
    sourceAuthorityVerified: false,
  } as unknown as AnonMigrationAuthorization);
  assert.equal(unsigned.result, "failed");
  if (unsigned.result === "failed") {
    assert.equal(unsigned.operation, "authorization.verify");
  }

  const sameUser = await runMigration(dependencies, {
    ...AUTHORIZATION,
    targetUserId: SOURCE_USER_ID,
  });
  assert.equal(sameUser.result, "failed");
  assert.equal(targetCalls, 0);
});

test("source missing 허용 전 target Auth 비익명·identity를 독립 재검증한다", async () => {
  for (const data of [
    null,
    { userId: SOURCE_USER_ID, isAnonymous: false },
    { userId: TARGET_USER_ID, isAnonymous: true },
  ]) {
    const dependencies = successfulDependencies();
    dependencies.getAnonUser = async () => ({ data: null, error: null });
    dependencies.getTargetUser = async () => ({ data, error: null });

    const outcome = await runMigration(dependencies);

    assert.equal(outcome.result, "failed");
    if (outcome.result === "failed") {
      assert.equal(outcome.operation, "auth.get_target_user");
      assert.match(
        String((outcome.error as Error).message),
        /target_user_invalid/,
      );
    }
  }
});

test("명시적 Auth user_not_found만 이전 완료 재시도의 source 없음으로 식별한다", () => {
  assert.equal(isMissingAuthUserError({ code: "user_not_found" }), true);
  assert.equal(isMissingAuthUserError({ message: "User not found" }), true);
  assert.equal(
    isMissingAuthUserError({ message: "User with id abc not found" }),
    true,
  );
  assert.equal(
    isMissingAuthUserError({ code: "request_timeout", message: "timed out" }),
    false,
  );
  assert.equal(isMissingAuthUserError({ status: 404, message: "gateway" }), false);
});

test("source Auth가 이미 없어도 orphan 데이터 복구를 위해 reassign/delete 검증까지 수행한다", async () => {
  const missing = successfulDependencies();
  let reassignCalls = 0;
  let deleteCalls = 0;
  missing.getAnonUser = async () => ({ data: null, error: null });
  missing.reassign = async () => {
    reassignCalls += 1;
    return { data: REASSIGN_SUCCESS, error: null };
  };
  missing.deleteAnonUser = async () => {
    deleteCalls += 1;
    return { deleted: true, error: null };
  };
  assert.deepEqual(await runMigration(missing), {
    result: "migrated",
  });
  assert.equal(reassignCalls, 1);
  assert.equal(deleteCalls, 1);
});

test("비익명 source·기존 member만 의도적으로 skipped다", async () => {
  const notAnonymous = successfulDependencies();
  notAnonymous.getAnonUser = async () => ({
    data: { isAnonymous: false },
    error: null,
  });
  assert.deepEqual(await runMigration(notAnonymous), {
    result: "skipped",
    reason: "source_not_anonymous",
  });

  const sourceMember = successfulDependencies();
  sourceMember.getAnonMember = async () => ({
    data: { userId: "anon-id" },
    error: null,
  });
  assert.deepEqual(await runMigration(sourceMember), {
    result: "skipped",
    reason: "source_is_member",
  });

  const targetMember = successfulDependencies();
  targetMember.getTargetMember = async () => ({
    data: { userId: TARGET_USER_ID },
    error: null,
  });
  assert.deepEqual(await runMigration(targetMember), {
    result: "skipped",
    reason: "target_is_member",
  });

  const corruptTargetMember = successfulDependencies();
  corruptTargetMember.getTargetMember = async () => ({
    data: { userId: SOURCE_USER_ID },
    error: null,
  });
  const corruptOutcome = await runMigration(corruptTargetMember);
  assert.equal(corruptOutcome.result, "failed");
  if (corruptOutcome.result === "failed") {
    assert.equal(corruptOutcome.operation, "target_member.read");
  }
});

test("익명 금지 데이터가 있으면 수량을 보존해 skipped하고 reassign/delete하지 않는다", async () => {
  const dependencies = successfulDependencies();
  let reassignCalls = 0;
  let deleteCalls = 0;
  dependencies.countDolls = async () => ({ count: 2, error: null });
  dependencies.countOrders = async () => ({ count: 3, error: null });
  dependencies.countGenerations = async () => ({ count: 5, error: null });
  dependencies.reassign = async () => {
    reassignCalls += 1;
    return { data: { ok: true }, error: null };
  };
  dependencies.deleteAnonUser = async () => {
    deleteCalls += 1;
    return { deleted: true, error: null };
  };

  assert.deepEqual(await runMigration(dependencies), {
    result: "skipped",
    reason: "unexpected_data",
    counts: { dolls: 2, orders: 3, generations: 5 },
  });
  assert.equal(reassignCalls, 0);
  assert.equal(deleteCalls, 0);
});

for (const [name, count] of [
  ["null", null],
  ["negative", -1],
  ["fraction", 0.5],
  ["NaN", Number.NaN],
] as const) {
  test(`손상된 dolls count(${name})는 0으로 강등하지 않는다`, async () => {
    const dependencies = successfulDependencies();
    dependencies.countDolls = async () => ({ count, error: null });

    const outcome = await runMigration(dependencies);

    assert.equal(outcome.result, "failed");
    if (outcome.result === "failed") {
      assert.equal(outcome.operation, "dolls.count");
      assert.match(String((outcome.error as Error).message), /count_missing_or_invalid/);
    }
  });
}

test("유효한 개별 count의 합이 안전 정수 범위를 넘으면 차단한다", async () => {
  const dependencies = successfulDependencies();
  dependencies.countDolls = async () => ({
    count: Number.MAX_SAFE_INTEGER,
    error: null,
  });
  dependencies.countOrders = async () => ({ count: 1, error: null });

  const outcome = await runMigration(dependencies);

  assert.equal(outcome.result, "failed");
  if (outcome.result === "failed") {
    assert.equal(outcome.operation, "counts.aggregate");
    assert.match(String((outcome.error as Error).message), /count_total_overflow/);
  }
});

test("resolved error가 없어도 reassign/delete 성공 증거가 없으면 migrated로 오인하지 않는다", async () => {
  for (const data of [
    null,
    { ok: true },
    { ...REASSIGN_SUCCESS, extra: true },
    { ...REASSIGN_SUCCESS, scores: -1 },
    { ...REASSIGN_SUCCESS, badges: 0.5 },
    { ...REASSIGN_SUCCESS, telemetry: "0" },
    { ...REASSIGN_SUCCESS, scores: 2_147_483_648 },
    { ...REASSIGN_SUCCESS, badges: Number.NaN },
    { ...REASSIGN_SUCCESS, telemetry: Number.POSITIVE_INFINITY },
    { ...REASSIGN_SUCCESS, ok: 1 },
  ]) {
    const invalidReassign = successfulDependencies();
    let deleteCalls = 0;
    invalidReassign.reassign = async () => ({ data, error: null });
    invalidReassign.deleteAnonUser = async () => {
      deleteCalls += 1;
      return { deleted: true, error: null };
    };
    const reassignOutcome = await runMigration(invalidReassign);
    assert.equal(reassignOutcome.result, "failed");
    if (reassignOutcome.result === "failed") {
      assert.equal(reassignOutcome.operation, "data.reassign");
      assert.match(
        String((reassignOutcome.error as Error).message),
        /reassign_result_invalid/,
      );
    }
    assert.equal(deleteCalls, 0);
  }

  const invalidDelete = successfulDependencies();
  invalidDelete.deleteAnonUser = async () => ({
    deleted: false,
    error: null,
  });
  const deleteOutcome = await runMigration(invalidDelete);
  assert.equal(deleteOutcome.result, "failed");
  if (deleteOutcome.result === "failed") {
    assert.equal(deleteOutcome.operation, "auth.delete_user");
    assert.match(
      String((deleteOutcome.error as Error).message),
      /delete_result_invalid/,
    );
  }
});
