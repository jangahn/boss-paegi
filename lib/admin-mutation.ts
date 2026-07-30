export const ADMIN_MUTATION_OPERATIONS = [
  "config_update",
  "event_save",
  "event_publish",
  "event_unpublish",
  "event_delete",
  "moderation_takedown",
  "moderation_dismiss",
  "moderation_restore",
  "moderation_permanent_delete",
  "integrity_clear",
  "integrity_void",
  "integrity_ban",
  "integrity_unban",
  "account_reactivate",
  "order_settle",
] as const;

export type AdminMutationOperation =
  (typeof ADMIN_MUTATION_OPERATIONS)[number];

export const GENERIC_ADMIN_MUTATION_RECEIPT_OPERATIONS = [
  "config_update",
  "event_save",
  "event_publish",
  "event_unpublish",
  "event_delete",
  "moderation_takedown",
  "moderation_dismiss",
  "moderation_restore",
  "moderation_permanent_delete",
  "integrity_clear",
  "integrity_void",
  "integrity_ban",
  "integrity_unban",
] as const satisfies readonly AdminMutationOperation[];

export type GenericAdminMutationReceiptOperation =
  (typeof GENERIC_ADMIN_MUTATION_RECEIPT_OPERATIONS)[number];

export function isAdminMutationOperation(
  value: unknown,
): value is AdminMutationOperation {
  return (
    typeof value === "string" &&
    (ADMIN_MUTATION_OPERATIONS as readonly string[]).includes(value)
  );
}

export function isGenericAdminMutationReceiptOperation(
  value: unknown,
): value is GenericAdminMutationReceiptOperation {
  return (
    typeof value === "string" &&
    (
      GENERIC_ADMIN_MUTATION_RECEIPT_OPERATIONS as readonly string[]
    ).includes(value)
  );
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isOperationRequestId(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export type AdminMutationReceipt =
  | { ok: true; state: "aborted"; result: null }
  | { ok: true; state: "pending"; result: null }
  | { ok: true; state: "completed"; result: Record<string, unknown> };

export function parseAdminMutationReceipt(
  value: unknown,
): AdminMutationReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true) return null;
  if (row.state === "aborted" || row.state === "pending") {
    return row.result === null
      ? ({ ok: true, state: row.state, result: null } as AdminMutationReceipt)
      : null;
  }
  if (
    row.state === "completed" &&
    row.result !== null &&
    typeof row.result === "object" &&
    !Array.isArray(row.result) &&
    (row.result as { ok?: unknown }).ok === true
  ) {
    return {
      ok: true,
      state: "completed",
      result: row.result as Record<string, unknown>,
    };
  }
  return null;
}

export type AdminIntegrityMutationResult = {
  ok: true;
  previousStatus: string;
  nextStatus: string;
  version: number;
  noOp: boolean;
  idempotent: boolean;
};

export function parseAdminIntegrityMutationResult(
  value: unknown,
): AdminIntegrityMutationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true ||
    typeof row.previousStatus !== "string" ||
    typeof row.nextStatus !== "string" ||
    !Number.isSafeInteger(row.version) ||
    (row.version as number) < 0 ||
    typeof row.noOp !== "boolean" ||
    typeof row.idempotent !== "boolean"
  ) {
    return null;
  }
  return row as AdminIntegrityMutationResult;
}

export type AdminModerationMutationResult = {
  ok: true;
  previousState: string;
  nextState: string;
  version: number;
  dismissed: number;
  noOp: boolean;
  idempotent: boolean;
};

export function parseAdminModerationMutationResult(
  value: unknown,
): AdminModerationMutationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true ||
    typeof row.previousState !== "string" ||
    typeof row.nextState !== "string" ||
    !Number.isSafeInteger(row.version) ||
    (row.version as number) < 0 ||
    !Number.isSafeInteger(row.dismissed) ||
    (row.dismissed as number) < 0 ||
    typeof row.noOp !== "boolean" ||
    typeof row.idempotent !== "boolean"
  ) {
    return null;
  }
  return row as AdminModerationMutationResult;
}

export type AdminEventMutationResult = {
  ok: true;
  id: string;
  version: number;
  state?: string;
  noOp: boolean;
  idempotent: boolean;
};

export function parseAdminEventMutationResult(
  value: unknown,
): AdminEventMutationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true ||
    !isOperationRequestId(row.id) ||
    !Number.isSafeInteger(row.version) ||
    (row.version as number) < 0 ||
    (row.state !== undefined && typeof row.state !== "string") ||
    typeof row.noOp !== "boolean" ||
    typeof row.idempotent !== "boolean"
  ) {
    return null;
  }
  return row as AdminEventMutationResult;
}

export type AccountReactivationBeginResult =
  | {
      ok: true;
      pending: true;
      operationRequestId: string;
      email: string;
      idempotent: boolean;
    }
  | {
      ok: true;
      pending: false;
      operationRequestId?: string;
      idempotent: boolean;
      accountReactivated: true;
    }
  | {
      ok: true;
      pending: false;
      operationRequestId?: string;
      idempotent: boolean;
      accountReactivated: false;
      cancelled: true;
    };

export function parseAccountReactivationBeginResult(
  value: unknown,
): AccountReactivationBeginResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true || typeof row.idempotent !== "boolean") return null;
  if (row.pending === true) {
    if (
      !isOperationRequestId(row.operationRequestId) ||
      typeof row.email !== "string" ||
      row.email.trim().length < 3 ||
      row.email.length > 320
    ) {
      return null;
    }
    return row as AccountReactivationBeginResult;
  }
  if (
    row.accountReactivated === true &&
    (row.operationRequestId === undefined ||
      isOperationRequestId(row.operationRequestId))
  ) {
    return {
      ok: true,
      pending: false,
      operationRequestId: row.operationRequestId as string | undefined,
      idempotent: row.idempotent,
      accountReactivated: true,
    };
  }
  if (
    row.accountReactivated === false &&
    row.cancelled === true &&
    (row.operationRequestId === undefined ||
      isOperationRequestId(row.operationRequestId))
  ) {
    return {
      ok: true,
      pending: false,
      operationRequestId: row.operationRequestId as string | undefined,
      idempotent: row.idempotent,
      accountReactivated: false,
      cancelled: true,
    };
  }
  return null;
}

export type PendingAccountReactivation =
  | { ok: true; found: false }
  | {
      ok: true;
      found: true;
      operationRequestId: string;
      adminUserId: string;
      userId: string;
      expectedDeletedAt: string;
      expectedWithdrawalGeneration: number;
      jobStatus: "pending" | "leased";
      cancelRequested: boolean;
    };

/**
 * 관리자 상세 새로고침 뒤에도 durable reactivation correlation을 복구한다.
 * SQL RPC는 snake_case를 반환하지만 UI에는 검증된 camelCase 값만 전달한다.
 */
export function parsePendingAccountReactivation(
  value: unknown,
  expectedUserId: string,
): PendingAccountReactivation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true || typeof row.found !== "boolean") return null;
  if (row.found === false) {
    return { ok: true, found: false };
  }

  const deletedAt = row.expected_deleted_at;
  const generation = row.expected_withdrawal_generation;
  const jobStatus = row.job_status;
  if (
    !isOperationRequestId(row.request_id) ||
    !isOperationRequestId(row.admin_user_id) ||
    !isOperationRequestId(row.user_id) ||
    row.user_id !== expectedUserId ||
    typeof deletedAt !== "string" ||
    !Number.isFinite(Date.parse(deletedAt)) ||
    !Number.isSafeInteger(generation) ||
    (generation as number) < 1 ||
    (jobStatus !== "pending" && jobStatus !== "leased") ||
    typeof row.cancel_requested !== "boolean"
  ) {
    return null;
  }

  return {
    ok: true,
    found: true,
    operationRequestId: row.request_id,
    adminUserId: row.admin_user_id,
    userId: row.user_id,
    expectedDeletedAt: deletedAt,
    expectedWithdrawalGeneration: generation as number,
    jobStatus,
    cancelRequested: row.cancel_requested,
  };
}

export type AccountReactivationCompleteResult = {
  ok: true;
  userId: string;
  accountReactivated: true;
  idempotent: boolean;
};

export function parseAccountReactivationCompleteResult(
  value: unknown,
): AccountReactivationCompleteResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true ||
    !isOperationRequestId(row.userId) ||
    row.accountReactivated !== true ||
    typeof row.idempotent !== "boolean"
  ) {
    return null;
  }
  return row as AccountReactivationCompleteResult;
}

export type AccountReactivationCancelledResult = {
  ok: true;
  userId: string;
  accountReactivated: false;
  cancelled: true;
  idempotent: boolean;
};

export function parseAccountReactivationCancelledResult(
  value: unknown,
): AccountReactivationCancelledResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true ||
    !isOperationRequestId(row.userId) ||
    row.accountReactivated !== false ||
    row.cancelled !== true ||
    typeof row.idempotent !== "boolean"
  ) {
    return null;
  }
  return row as AccountReactivationCancelledResult;
}

export type AccountReactivationTerminalResult =
  | AccountReactivationCompleteResult
  | AccountReactivationCancelledResult;

type AdminSettlementMutationResultBase = {
  ok: true;
  before: number;
  after: number;
  requestedCredits: number;
  noOp: boolean;
  idempotent: boolean;
};

export type AdminSettlementMutationResult =
  | (AdminSettlementMutationResultBase & {
      credits: number;
      quarantined: false;
    })
  | (AdminSettlementMutationResultBase & {
      credits: 0;
      quarantined: true;
    });

export function parseAdminSettlementMutationResult(
  value: unknown,
): AdminSettlementMutationResult | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (
    row.ok !== true ||
    !Number.isSafeInteger(row.before) ||
    (row.before as number) < 0 ||
    !Number.isSafeInteger(row.after) ||
    (row.after as number) < 0 ||
    !Number.isSafeInteger(row.credits) ||
    (row.credits as number) < 0 ||
    !Number.isSafeInteger(row.requestedCredits) ||
    (row.requestedCredits as number) <= 0 ||
    (row.after as number) - (row.before as number) !== row.credits ||
    typeof row.quarantined !== "boolean" ||
    typeof row.noOp !== "boolean" ||
    typeof row.idempotent !== "boolean"
  ) {
    return null;
  }
  if (
    (row.quarantined === true &&
      (row.credits !== 0 || row.after !== row.before)) ||
    (row.quarantined === false &&
      (row.credits !== row.requestedCredits || row.credits === 0))
  ) {
    return null;
  }
  return {
    ok: true,
    before: row.before as number,
    after: row.after as number,
    credits: row.credits as number,
    requestedCredits: row.requestedCredits as number,
    quarantined: row.quarantined,
    noOp: row.noOp,
    idempotent: row.idempotent,
  } as AdminSettlementMutationResult;
}

export type AdminSettlementReceipt =
  | { ok: true; found: false }
  | {
      ok: true;
      found: true;
      result: AdminSettlementMutationResult;
    };

export function parseAdminSettlementReceipt(
  value: unknown,
): AdminSettlementReceipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (row.ok !== true) return null;
  if (row.found === false && row.result === undefined) {
    return { ok: true, found: false };
  }
  if (row.found === true) {
    const result = parseAdminSettlementMutationResult(row.result);
    return result?.idempotent === true
      ? { ok: true, found: true, result }
      : null;
  }
  return null;
}

export function isAdminSettlementReceiptProof(
  receipt: AdminSettlementReceipt,
  result: AdminSettlementMutationResult,
): boolean {
  return (
    receipt.found === true &&
    receipt.result.before === result.before &&
    receipt.result.after === result.after &&
    receipt.result.credits === result.credits &&
    receipt.result.requestedCredits === result.requestedCredits &&
    receipt.result.quarantined === result.quarantined &&
    receipt.result.noOp === result.noOp &&
    receipt.result.idempotent === true
  );
}
