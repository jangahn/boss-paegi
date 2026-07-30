/**
 * 익명 데이터 이전의 순수 정책 경계.
 *
 * Supabase SDK는 실패를 reject하지 않고 `{ error }`로 resolve할 수 있으므로, 모든 외부 연산을
 * 명시적으로 검사한다. 실제 SDK 어댑터는 `lib/account-onboard.ts`에 두고 이 파일은 fault
 * injection으로 모든 실패 분기를 검증할 수 있게 런타임 의존성을 갖지 않는다.
 */

export type AnonMigrationOperation =
  | "authorization.verify"
  | "auth.get_target_user"
  | "target_member.read"
  | "auth.get_user"
  | "member.read"
  | "dolls.count"
  | "orders.count"
  | "generations.count"
  | "counts.aggregate"
  | "data.reassign"
  | "auth.delete_user";

type ReadResult<T> = {
  data: T | null;
  error: unknown | null;
};

type CountResult = {
  count: number | null;
  error: unknown | null;
};

type MutationResult = {
  error: unknown | null;
};

export type AnonMigrationDependencies = {
  getTargetUser: () => Promise<
    ReadResult<{ userId: string; isAnonymous: boolean }>
  >;
  getTargetMember: () => Promise<ReadResult<{ userId: string }>>;
  getAnonUser: () => Promise<ReadResult<{ isAnonymous: boolean }>>;
  getAnonMember: () => Promise<ReadResult<{ userId: string }>>;
  countDolls: () => Promise<CountResult>;
  countOrders: () => Promise<CountResult>;
  countGenerations: () => Promise<CountResult>;
  reassign: () => Promise<MutationResult & { data: unknown }>;
  deleteAnonUser: () => Promise<MutationResult & { deleted: boolean }>;
};

/**
 * runner를 호출할 수 있는 최소 권한 증거. `signedSourceCookieVerified`는 server-only HMAC/TTL
 * 검증을 통과한 뒤에만 true로 구성하고, target은 현재 인증 gate의 user id를 전달한다.
 */
export type AnonMigrationAuthorization = {
  sourceUserId: string;
  targetUserId: string;
  signedSourceCookieVerified: true;
};

export type AnonMigrationOutcome =
  | { result: "migrated" }
  | {
      result: "skipped";
      reason:
        | "source_not_anonymous"
        | "source_is_member"
        | "target_is_member"
        | "unexpected_data";
      counts?: {
        dolls: number;
        orders: number;
        generations: number;
      };
    }
  | {
      result: "failed";
      operation: AnonMigrationOperation;
      error: unknown;
    };

type Captured<T> =
  | { ok: true; value: T }
  | {
      ok: false;
      failure: Extract<AnonMigrationOutcome, { result: "failed" }>;
    };

function failure(
  operation: AnonMigrationOperation,
  error: unknown,
): Extract<AnonMigrationOutcome, { result: "failed" }> {
  return { result: "failed", operation, error };
}

async function capture<T extends { error: unknown | null }>(
  operation: AnonMigrationOperation,
  run: () => Promise<T>,
): Promise<Captured<T>> {
  try {
    const value = await run();
    if (value.error != null) {
      return { ok: false, failure: failure(operation, value.error) };
    }
    return { ok: true, value };
  } catch (error) {
    return { ok: false, failure: failure(operation, error) };
  }
}

function validCount(
  operation: Extract<
    AnonMigrationOperation,
    "dolls.count" | "orders.count" | "generations.count"
  >,
  count: number | null,
): Captured<number> {
  if (count === null || !Number.isSafeInteger(count) || count < 0) {
    return {
      ok: false,
      failure: failure(operation, new Error("count_missing_or_invalid")),
    };
  }
  return { ok: true, value: count };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `getUserById`는 삭제된 사용자를 `{ data: { user: null }, error: user_not_found }`로 반환한다.
 * 이는 이전 완료 뒤 consent INSERT만 실패한 재시도에서 정상적으로 발생한다. SDK 어댑터는
 * 오직 이 명시적 오류만 성공한 no-row/이미 삭제됨으로 정규화한다. 서명 쿠키가 source 소유
 * 근거이므로 no-row여도 멱등 reassign은 실행해, Auth만 먼저 사라지고 데이터가 남은 경우를 복구한다.
 */
export function isMissingAuthUserError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const value = error as { code?: unknown; message?: unknown };
  if (value.code === "user_not_found") return true;
  return (
    typeof value.message === "string" &&
    /^user(?: with id .+)? not found$/i.test(value.message.trim())
  );
}

/**
 * 익명 source 검증 → 금지 데이터 count → 멱등 reassign → auth user 삭제를 순서대로 수행한다.
 * 어느 단계든 throw 또는 resolved `{ error }`이면 `failed`이며 호출부는 쿠키를 보존해야 한다.
 */
export async function runAnonDataMigration(
  dependencies: AnonMigrationDependencies,
  authorization: AnonMigrationAuthorization,
): Promise<AnonMigrationOutcome> {
  if (
    authorization.signedSourceCookieVerified !== true ||
    !UUID_RE.test(authorization.sourceUserId) ||
    !UUID_RE.test(authorization.targetUserId) ||
    authorization.sourceUserId === authorization.targetUserId
  ) {
    return failure(
      "authorization.verify",
      new Error("migration_authorization_invalid"),
    );
  }

  const targetUser = await capture(
    "auth.get_target_user",
    dependencies.getTargetUser,
  );
  if (!targetUser.ok) return targetUser.failure;
  if (
    targetUser.value.data === null ||
    targetUser.value.data.userId !== authorization.targetUserId ||
    targetUser.value.data.isAnonymous === true
  ) {
    return failure("auth.get_target_user", new Error("target_user_invalid"));
  }

  const targetMember = await capture(
    "target_member.read",
    dependencies.getTargetMember,
  );
  if (!targetMember.ok) return targetMember.failure;
  if (
    targetMember.value.data !== null &&
    targetMember.value.data.userId !== authorization.targetUserId
  ) {
    return failure(
      "target_member.read",
      new Error("target_member_result_invalid"),
    );
  }
  if (targetMember.value.data !== null) {
    return { result: "skipped", reason: "target_is_member" };
  }

  const anonUser = await capture("auth.get_user", dependencies.getAnonUser);
  if (!anonUser.ok) return anonUser.failure;
  if (
    anonUser.value.data !== null &&
    anonUser.value.data.isAnonymous !== true
  ) {
    return {
      result: "skipped",
      reason: "source_not_anonymous",
    };
  }

  const anonMember = await capture("member.read", dependencies.getAnonMember);
  if (!anonMember.ok) return anonMember.failure;
  if (anonMember.value.data !== null) {
    return { result: "skipped", reason: "source_is_member" };
  }

  const [dollsResult, ordersResult, generationsResult] = await Promise.all([
    capture("dolls.count", dependencies.countDolls),
    capture("orders.count", dependencies.countOrders),
    capture("generations.count", dependencies.countGenerations),
  ]);
  if (!dollsResult.ok) return dollsResult.failure;
  if (!ordersResult.ok) return ordersResult.failure;
  if (!generationsResult.ok) return generationsResult.failure;

  const dolls = validCount("dolls.count", dollsResult.value.count);
  if (!dolls.ok) return dolls.failure;
  const orders = validCount("orders.count", ordersResult.value.count);
  if (!orders.ok) return orders.failure;
  const generations = validCount(
    "generations.count",
    generationsResult.value.count,
  );
  if (!generations.ok) return generations.failure;

  const firstTotal = dolls.value + orders.value;
  const unexpected = firstTotal + generations.value;
  if (!Number.isSafeInteger(firstTotal) || !Number.isSafeInteger(unexpected)) {
    return failure("counts.aggregate", new Error("count_total_overflow"));
  }
  if (unexpected > 0) {
    return {
      result: "skipped",
      reason: "unexpected_data",
      counts: {
        dolls: dolls.value,
        orders: orders.value,
        generations: generations.value,
      },
    };
  }

  const reassigned = await capture("data.reassign", dependencies.reassign);
  if (!reassigned.ok) return reassigned.failure;
  if (
    typeof reassigned.value.data !== "object" ||
    reassigned.value.data === null ||
    (reassigned.value.data as { ok?: unknown }).ok !== true
  ) {
    return failure("data.reassign", new Error("reassign_result_invalid"));
  }

  const deleted = await capture(
    "auth.delete_user",
    dependencies.deleteAnonUser,
  );
  if (!deleted.ok) return deleted.failure;
  if (deleted.value.deleted !== true) {
    return failure("auth.delete_user", new Error("delete_result_invalid"));
  }

  return { result: "migrated" };
}
