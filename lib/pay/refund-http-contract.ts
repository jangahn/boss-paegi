import {
  parseAdminRefundAttemptResult,
  parseExternalCancellationResolutionResult,
  parseReconciliationIssueResolutionResult,
  type AdminRefundAttemptAction,
} from "./refund-mutation-result.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => expected.includes(key))
  );
}

function boundedText(value: unknown, max: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= max &&
    value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

export type RefundPreviewPlan = {
  qty: number;
  amount: number;
  rateBps: 9000 | 10000;
  lotAvailable: number;
  orderRemainingQty: number;
  remainingCash: number;
  paidAt: string;
  deadline: string;
};

export function parseRefundPreviewHttpAck(
  value: unknown,
  expectedQty: number,
): RefundPreviewPlan | null {
  const outer = record(value);
  if (
    !outer ||
    !exactKeys(outer, ["ok", "plan"]) ||
    outer.ok !== true
  ) {
    return null;
  }
  const plan = record(outer.plan);
  if (
    !plan ||
    !exactKeys(plan, [
      "qty",
      "amount",
      "rateBps",
      "lotAvailable",
      "orderRemainingQty",
      "remainingCash",
      "paidAt",
      "deadline",
    ]) ||
    !Number.isSafeInteger(expectedQty) ||
    expectedQty <= 0 ||
    plan.qty !== expectedQty ||
    !Number.isSafeInteger(plan.amount) ||
    (plan.amount as number) <= 0 ||
    (plan.rateBps !== 9000 && plan.rateBps !== 10000) ||
    !Number.isSafeInteger(plan.lotAvailable) ||
    (plan.lotAvailable as number) < expectedQty ||
    !Number.isSafeInteger(plan.orderRemainingQty) ||
    (plan.orderRemainingQty as number) < expectedQty ||
    !Number.isSafeInteger(plan.remainingCash) ||
    (plan.remainingCash as number) < (plan.amount as number) ||
    typeof plan.paidAt !== "string" ||
    typeof plan.deadline !== "string"
  ) {
    return null;
  }
  const paidAtMs = Date.parse(plan.paidAt);
  const deadlineMs = Date.parse(plan.deadline);
  if (
    !Number.isFinite(paidAtMs) ||
    !Number.isFinite(deadlineMs) ||
    deadlineMs <= paidAtMs
  ) {
    return null;
  }
  return plan as RefundPreviewPlan;
}

export type RefundProcessHttpAck = {
  ok: true;
  outcome:
    | "processed"
    | "pending"
    | "manual_review"
    | "blocked"
    | "no_op"
    | "outstanding";
  attemptId: string;
  detail?: string;
  cancellationId?: string;
  issuesOpened?: number;
};

export function parseRefundProcessHttpAck(
  value: unknown,
  expectedAttemptId: string,
): RefundProcessHttpAck | null {
  const row = record(value);
  const allowed = new Set([
    "ok",
    "outcome",
    "attemptId",
    "detail",
    "cancellationId",
    "issuesOpened",
  ]);
  if (
    !UUID_RE.test(expectedAttemptId) ||
    !row ||
    Object.keys(row).some((key) => !allowed.has(key)) ||
    row.ok !== true ||
    ![
      "processed",
      "pending",
      "manual_review",
      "blocked",
      "no_op",
      "outstanding",
    ].includes(typeof row.outcome === "string" ? row.outcome : "") ||
    row.attemptId !== expectedAttemptId ||
    (row.detail !== undefined && !boundedText(row.detail, 1000)) ||
    (row.cancellationId !== undefined &&
      !boundedText(row.cancellationId, 256)) ||
    (row.issuesOpened !== undefined &&
      (!Number.isSafeInteger(row.issuesOpened) ||
        (row.issuesOpened as number) < 0))
  ) {
    return null;
  }
  return row as RefundProcessHttpAck;
}

export function parseAdminRefundAttemptHttpAck(
  value: unknown,
  expected: {
    action: AdminRefundAttemptAction;
    attemptId: string;
  },
): "applied" | "no_op" | null {
  const row = record(value);
  if (!row || row.attempt_id !== expected.attemptId) return null;
  const parsed = parseAdminRefundAttemptResult(row, expected);
  if (!parsed) return null;
  const expectedKeys =
    parsed === "no_op"
      ? ["ok", "outcome", "idempotent", "attempt_id"]
      : expected.action === "replan_pre_pg" ||
          expected.action === "replan_after_pg"
        ? ["ok", "outcome", "release_reason", "attempt_id"]
        : ["ok", "outcome", "attempt_id"];
  return exactKeys(row, expectedKeys) ? parsed : null;
}

export function parseReconciliationIssueHttpAck(
  value: unknown,
  expected: {
    issueId: string;
    state: "resolved" | "ignored";
  },
): "applied" | "no_op" | null {
  const row = record(value);
  if (!row || row.issue_id !== expected.issueId) return null;
  const parsed = parseReconciliationIssueResolutionResult(
    row,
    expected.state,
  );
  if (!parsed) return null;
  return exactKeys(
    row,
    parsed === "no_op"
      ? ["ok", "outcome", "idempotent", "issue_id"]
      : ["ok", "outcome", "issue_id"],
  )
    ? parsed
    : null;
}

export function parseExternalCancellationHttpAck(
  value: unknown,
  expected: {
    cancellationId: string;
    economicQty: number | null;
  },
): "resolved" | "no_op" | null {
  const row = record(value);
  if (!row || row.cancellation_id !== expected.cancellationId) return null;
  const parsed = parseExternalCancellationResolutionResult(
    row,
    expected.economicQty,
  );
  if (!parsed) return null;
  return exactKeys(
    row,
    parsed.kind === "no_op"
      ? ["ok", "outcome", "idempotent", "cancellation_id"]
      : ["ok", "outcome", "result", "cancellation_id"],
  )
    ? parsed.kind
    : null;
}
