import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { drainAccountDeletionCleanupJobs } from "@/lib/account-delete-cleanup-job";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import { isDeletedMarker } from "@/lib/oauth-metadata";
import { log, errInfo } from "@/lib/log";
import {
  deterministicAdminRequestId,
  parseExactTimestampFence,
} from "@/lib/admin-operation-id";
import { parseAccountReactivationBeginResult } from "@/lib/admin-mutation";
import {
  createAccountReactivationDeadline,
  getAccountReactivationStatus,
  processAccountReactivationJob,
  runAccountReactivationBeforeDeadline,
  type AccountReactivationCorrelation,
} from "@/lib/account-reactivation-job";
import { legacyAdminClientRefresh } from "@/lib/admin-client-compat";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";

export const runtime = "nodejs";
export const maxDuration = 60;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mutationErrorStatus(code: string): number {
  if (
    code === "state_conflict" ||
    code === "idempotency_conflict" ||
    code === "reactivation_in_progress" ||
    code === "reactivation_cancellation_in_progress" ||
    code === "reactivation_already_completed"
  ) {
    return 409;
  }
  return code === "action_failed" ? 500 : 400;
}

/**
 * Durable DB -> GoTrue reactivation saga.
 *
 * Begin atomically creates the pending receipt and its durable external-sync
 * job while the profile remains deleted. The request path opportunistically
 * claims that job; content-maintain resumes it after a crash or response loss.
 * Only the receipt-bound marker -> exact-email mutation is permitted, and the
 * fenced finish verifies the Auth row before atomically activating the DB
 * account, audit row, receipt, and job.
 */
export async function POST(req: NextRequest) {
  // Leave headroom inside the platform's 60-second route ceiling. Every
  // worker RPC/Auth read/write shares this one monotonic budget.
  const workerDeadline = createAccountReactivationDeadline(50_000);
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as {
    userId?: string;
    reason?: string;
    emailOverride?: string;
    expectedDeletedAt?: string;
    expectedWithdrawalGeneration?: number;
    action?: "activate" | "cancel";
    operationRequestId?: string;
  } | null;
  const refresh = legacyAdminClientRefresh("reactivate", body);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  const reason = body?.reason?.trim() ?? "";
  const action = body?.action ?? "activate";
  const emailOverride = body?.emailOverride?.trim() || null;
  // PostgreSQL timestamptz carries microseconds. Date#toISOString truncates
  // those to milliseconds and would turn a valid exact lifecycle fence into
  // state_conflict, so validate with Date.parse but pass the trimmed DB text
  // through unchanged.
  const expectedDeletedAt = parseExactTimestampFence(
    body?.expectedDeletedAt,
  );
  const expectedWithdrawalGeneration =
    Number.isSafeInteger(body?.expectedWithdrawalGeneration) &&
      (body?.expectedWithdrawalGeneration as number) >= 1
      ? (body?.expectedWithdrawalGeneration as number)
      : null;
  if (
    !body?.userId ||
    !UUID_RE.test(body.userId) ||
    reason.length < 5 ||
    reason.length > 500 ||
    expectedDeletedAt === null ||
    expectedWithdrawalGeneration === null ||
    (action !== "activate" && action !== "cancel") ||
    (action === "cancel" &&
      (
        !body?.operationRequestId ||
        !UUID_RE.test(body.operationRequestId)
      )) ||
    (emailOverride !== null &&
      (emailOverride.length > 320 || isDeletedMarker(emailOverride)))
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const admin = createAdminClient();

  if (action === "cancel") {
    const operationRequestId = body.operationRequestId as string;
    let cancelCall: Awaited<ReturnType<typeof admin.rpc>>;
    try {
      cancelCall = await runAccountReactivationBeforeDeadline(
        workerDeadline,
        () =>
          Promise.resolve(
            admin.rpc(
              "request_account_reactivation_cancellation",
              {
                p_request_id: operationRequestId,
                p_user_id: body.userId,
                p_cancel_admin: gate.user.id,
                p_reason: reason,
                p_expected_deleted_at: expectedDeletedAt,
                p_expected_withdrawal_generation:
                  expectedWithdrawalGeneration,
              },
            ),
          ),
      );
    } catch (error) {
      log.error("admin.reactivate_cancel_request_throw", {
        userId: body.userId,
        operationRequestId,
        ...errInfo(error),
      });
      return NextResponse.json(
        {
          error: "reactivation_cancellation_pending",
          operationRequestId,
        },
        { status: 503 },
      );
    }
    if (cancelCall.error) {
      const code = adminRpcErrorCode(cancelCall.error);
      return NextResponse.json(
        { error: code, operationRequestId },
        { status: mutationErrorStatus(code) },
      );
    }
    const cancelRow =
      cancelCall.data &&
      typeof cancelCall.data === "object" &&
      !Array.isArray(cancelCall.data)
        ? cancelCall.data as Record<string, unknown>
        : null;
    if (
      cancelRow?.ok !== true ||
      (
        cancelRow.status !== "cancel_requested" &&
        cancelRow.status !== "cancelled"
      ) ||
      cancelRow.request_id !== operationRequestId ||
      cancelRow.user_id !== body.userId ||
      typeof cancelRow.admin_user_id !== "string" ||
      !UUID_RE.test(cancelRow.admin_user_id)
    ) {
      return NextResponse.json(
        { error: "action_failed", operationRequestId },
        { status: 500 },
      );
    }
    const correlation: AccountReactivationCorrelation = {
      requestId: operationRequestId,
      adminId: cancelRow.admin_user_id,
      userId: body.userId,
    };
    let outcome;
    try {
      outcome = await processAccountReactivationJob(
        admin,
        correlation,
        workerDeadline,
      );
    } catch (error) {
      log.error("admin.reactivate_cancel_job_throw", {
        userId: body.userId,
        operationRequestId,
        ...errInfo(error),
      });
      return NextResponse.json(
        {
          error: "reactivation_cancellation_pending",
          operationRequestId,
        },
        { status: 503 },
      );
    }
    if (outcome.kind === "cancelled") {
      return NextResponse.json(outcome.result);
    }
    if (outcome.kind === "completed") {
      return NextResponse.json(
        { error: "reactivation_already_completed", operationRequestId },
        { status: 409 },
      );
    }
    try {
      const status = await getAccountReactivationStatus(
        admin,
        correlation,
        workerDeadline,
      );
      if (status.status === "cancelled" && status.result) {
        return NextResponse.json(status.result);
      }
      if (status.status === "completed") {
        return NextResponse.json(
          {
            error: "reactivation_already_completed",
            operationRequestId,
          },
          { status: 409 },
        );
      }
    } catch (error) {
      log.error("admin.reactivate_cancel_status_fail", {
        userId: body.userId,
        operationRequestId,
        ...errInfo(error),
      });
    }
    return NextResponse.json(
      {
        error: "reactivation_cancellation_pending",
        operationRequestId,
      },
      { status: 503 },
    );
  }

  const requestId = deterministicAdminRequestId(
    "account_reactivate",
    gate.user.id,
    body.userId,
    {
      emailOverride,
      expectedDeletedAt,
      expectedWithdrawalGeneration,
      reason,
      userId: body.userId,
    },
  );

  let beginCall: Awaited<ReturnType<typeof admin.rpc>>;
  try {
    beginCall = await runAccountReactivationBeforeDeadline(
      workerDeadline,
      () =>
        Promise.resolve(
          admin.rpc("admin_begin_account_reactivation", {
            p_user_id: body.userId,
            p_admin: gate.user.id,
            p_reason: reason,
            p_email_override: emailOverride,
            p_expected_deleted_at: expectedDeletedAt,
            p_expected_withdrawal_generation:
              expectedWithdrawalGeneration,
            p_request_id: requestId,
          }),
        ),
    );
  } catch (error) {
    log.error("admin.reactivate_begin_throw", {
      userId: body.userId,
      ...errInfo(error),
    });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  if (
    beginCall.error &&
    (beginCall.error as { message?: string }).message ===
      "account_cleanup_pending"
  ) {
    // 탈퇴 정리 미완 게이트 — 크론을 기다리지 않고 이 자리에서 정리를
    // 한 차례 드레인한 뒤 재시도한다(U3). final_sweep 경과 후에는 이
    // 인라인 패스가 곧바로 게이트를 연다. 드레인은 skip-locked lease 라
    // 크론과 경합해도 안전하다.
    try {
      await drainAccountDeletionCleanupJobs(admin, 3);
    } catch (drainError) {
      log.warn("admin.reactivate_inline_drain_fail", {
        userId: body.userId,
        ...errInfo(drainError),
      });
    }
    try {
      beginCall = await runAccountReactivationBeforeDeadline(
        workerDeadline,
        () =>
          Promise.resolve(
            admin.rpc("admin_begin_account_reactivation", {
              p_user_id: body.userId,
              p_admin: gate.user.id,
              p_reason: reason,
              p_email_override: emailOverride,
              p_expected_deleted_at: expectedDeletedAt,
              p_expected_withdrawal_generation:
                expectedWithdrawalGeneration,
              p_request_id: requestId,
            }),
          ),
      );
    } catch (error) {
      log.error("admin.reactivate_begin_throw", {
        userId: body.userId,
        ...errInfo(error),
      });
      return NextResponse.json({ error: "action_failed" }, { status: 500 });
    }
    if (
      beginCall.error &&
      (beginCall.error as { message?: string }).message ===
        "account_cleanup_pending"
    ) {
      // 여전히 정리 대기(자산 보유 계정의 final_sweep 미도래 등) —
      // 맹목 재시도를 유도하는 일반 오류가 아니라 상태 충돌로 명시한다(U4).
      log.warn("admin.reactivate_begin_fail", {
        userId: body.userId,
        code: "account_cleanup_pending",
        ...errInfo(beginCall.error),
      });
      return NextResponse.json(
        { error: "account_cleanup_pending" },
        { status: 409 },
      );
    }
  }
  if (beginCall.error) {
    const code = adminRpcErrorCode(beginCall.error);
    log.warn("admin.reactivate_begin_fail", {
      userId: body.userId,
      code,
      ...errInfo(beginCall.error),
    });
    return NextResponse.json(
      { error: code },
      { status: mutationErrorStatus(code) },
    );
  }

  const begin = parseAccountReactivationBeginResult(beginCall.data);
  if (!begin) {
    log.error("admin.reactivate_begin_invalid_result", {
      userId: body.userId,
    });
    return NextResponse.json({ error: "action_failed" }, { status: 500 });
  }
  if (!begin.pending) {
    if (!begin.accountReactivated) {
      return NextResponse.json(
        {
          error: "reactivation_cancelled",
          operationRequestId:
            begin.operationRequestId ?? requestId,
        },
        { status: 409 },
      );
    }
    log.info("admin.reactivate_replay_complete", {
      userId: body.userId,
      adminId: gate.user.id,
    });
    return NextResponse.json({
      ok: true,
      userId: body.userId,
      accountReactivated: true,
      idempotent: true,
    });
  }
  if (isDeletedMarker(begin.email)) {
    log.error("admin.reactivate_begin_marker_email", {
      userId: body.userId,
    });
    return NextResponse.json(
      {
        error: "auth_email_restore_failed",
        operationRequestId: begin.operationRequestId,
      },
      { status: 500 },
    );
  }

  const correlation: AccountReactivationCorrelation = {
    requestId: begin.operationRequestId,
    adminId: gate.user.id,
    userId: body.userId,
  };
  let outcome;
  try {
    outcome = await processAccountReactivationJob(
      admin,
      correlation,
      workerDeadline,
    );
  } catch (error) {
    log.error("admin.reactivate_job_throw", {
      userId: body.userId,
      operationRequestId: begin.operationRequestId,
      ...errInfo(error),
    });
    return NextResponse.json(
      {
        error: "reactivation_pending",
        accountReactivated: false,
        operationRequestId: begin.operationRequestId,
      },
      { status: 503 },
    );
  }

  if (outcome.kind === "completed") {
    log.info("admin.reactivate_success", {
      userId: body.userId,
      adminId: gate.user.id,
      attemptCount: outcome.attemptCount,
    });
    return NextResponse.json(outcome.result);
  }
  if (outcome.kind === "cancelled") {
    return NextResponse.json(
      {
        error: "reactivation_cancelled",
        operationRequestId: begin.operationRequestId,
      },
      { status: 409 },
    );
  }

  // A route and cron worker can race, or the fenced finish response can be
  // lost. Read the exact admin+target+request status before deciding that this
  // delivery is still pending; never turn generic idle into a false 200.
  try {
    const status = await getAccountReactivationStatus(
      admin,
      correlation,
      workerDeadline,
    );
    if (status.status === "completed" && status.result) {
      log.info("admin.reactivate_status_recovered", {
        userId: body.userId,
        adminId: gate.user.id,
        operationRequestId: begin.operationRequestId,
      });
      return NextResponse.json(status.result);
    }
    if (status.status === "cancelled") {
      return NextResponse.json(
        {
          error: "reactivation_cancelled",
          operationRequestId: begin.operationRequestId,
        },
        { status: 409 },
      );
    }
  } catch (error) {
    log.error("admin.reactivate_status_fail", {
      userId: body.userId,
      operationRequestId: begin.operationRequestId,
      ...errInfo(error),
    });
    return NextResponse.json(
      {
        error: "reactivation_pending",
        accountReactivated: false,
        operationRequestId: begin.operationRequestId,
      },
      { status: 503 },
    );
  }

  log.warn("admin.reactivate_queued", {
    userId: body.userId,
    operationRequestId: begin.operationRequestId,
    outcome: outcome.kind,
    ...(outcome.kind === "pending"
      ? {
          attemptCount: outcome.attemptCount,
          failure: outcome.failure,
          retryRecorded: outcome.retryRecorded,
        }
      : {}),
  });
  return NextResponse.json(
    {
      error: "reactivation_pending",
      accountReactivated: false,
      operationRequestId: begin.operationRequestId,
    },
    { status: 503 },
  );
}
