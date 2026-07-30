import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { adminRpcErrorCode } from "@/lib/admin-rpc";
import {
  moderationPurgeHttpStatus,
  parseModerationPurgeStart,
  parseModerationPurgeStatus,
  processModerationPurgeJob,
  type ModerationPurgeStatus,
} from "@/lib/moderation-purge-job";
import { isOperationRequestId } from "@/lib/admin-mutation";
import { legacyAdminClientRefresh } from "@/lib/admin-client-compat";
import { log, errInfo } from "@/lib/log";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";

export const runtime = "nodejs";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A durable begin/claim/delete/finish saga. The begin RPC atomically snapshots
 * every Storage target and fences restore. A failed request or worker never
 * loses the manifest; content-maintain retries it after the lease/backoff.
 */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as
    | {
        dollId?: unknown;
        reason?: unknown;
        expectedState?: unknown;
        expectedVersion?: unknown;
        requestId?: unknown;
      }
    | null;
  const refresh = legacyAdminClientRefresh("moderationPermanentDelete", body);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  if (
    !body ||
    typeof body.dollId !== "string" ||
    !UUID_RE.test(body.dollId) ||
    typeof body.reason !== "string" ||
    body.expectedState !== "hidden" ||
    !Number.isSafeInteger(body.expectedVersion) ||
    (body.expectedVersion as number) < 0 ||
    !isOperationRequestId(body.requestId)
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const reason = body.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc(
    "admin_begin_doll_purge_idempotent",
    {
      p_admin_id: gate.user.id,
      p_doll_id: body.dollId,
      p_reason: reason,
      p_expected_state: body.expectedState,
      p_expected_version: body.expectedVersion as number,
      p_request_id: body.requestId,
    },
  );
  if (error) {
    const code = adminRpcErrorCode(error);
    log.warn("admin.purge_begin_fail", {
      dollId: body.dollId,
      code,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: code },
      {
        status:
          code === "doll_not_found"
            ? 404
            : code === "state_conflict" ||
                code === "idempotency_conflict" ||
                code === "request_aborted"
              ? 409
              : code === "action_failed"
                ? 500
                : 400,
      },
    );
  }

  let start;
  try {
    start = parseModerationPurgeStart(data);
  } catch (parseError) {
    log.error("admin.purge_begin_invalid", {
      dollId: body.dollId,
      ...errInfo(parseError),
    });
    return NextResponse.json({ error: "purge_start_failed" }, { status: 500 });
  }
  if (start.alreadyPurged) {
    return NextResponse.json({ ok: true, already_purged: true });
  }
  const jobId = start.jobId;
  if (!jobId) {
    log.error("admin.purge_begin_missing_job", { dollId: body.dollId });
    return NextResponse.json({ error: "purge_start_failed" }, { status: 500 });
  }

  let outcome;
  try {
    outcome = await processModerationPurgeJob(admin, jobId);
  } catch (processError) {
    log.error("admin.purge_claim_fail", {
      dollId: body.dollId,
      jobId,
      ...errInfo(processError),
    });
    return NextResponse.json(
      { accepted: true, purge: "pending", jobId },
      { status: 202 },
    );
  }

  let authoritativeStatus: ModerationPurgeStatus | null = null;
  if (outcome.kind === "idle") {
    let statusData: unknown;
    try {
      const statusCall = await admin.rpc("get_moderation_purge_status", {
        p_admin_id: gate.user.id,
        p_job_id: jobId,
        p_doll_id: body.dollId,
      });
      if (statusCall.error) throw statusCall.error;
      statusData = statusCall.data;
    } catch (statusError) {
      log.error("admin.purge_status_fail", {
        dollId: body.dollId,
        jobId,
        ...errInfo(statusError),
      });
      return NextResponse.json(
        { error: "purge_status_failed" },
        { status: 500 },
      );
    }
    try {
      authoritativeStatus = parseModerationPurgeStatus(
        statusData,
        jobId,
        body.dollId,
      );
    } catch (statusError) {
      log.error("admin.purge_status_invalid", {
        dollId: body.dollId,
        jobId,
        ...errInfo(statusError),
      });
      return NextResponse.json(
        { error: "purge_status_failed" },
        { status: 500 },
      );
    }
  }

  revalidatePath("/admin/moderation");
  if (moderationPurgeHttpStatus(outcome, authoritativeStatus) === 200) {
    log.info("admin.purge_ok", {
      dollId: body.dollId,
      adminId: gate.user.id,
      jobId,
      attemptCount:
        outcome.kind === "completed"
          ? outcome.attemptCount
          : authoritativeStatus?.attemptCount,
      recoveredTerminal: outcome.kind === "idle",
    });
    return NextResponse.json({ ok: true, purged: true, failed: 0 });
  }

  log.error("admin.purge_pending", {
    dollId: body.dollId,
    adminId: gate.user.id,
    jobId,
    outcome,
    authoritativeStatus,
  });
  return NextResponse.json(
    { accepted: true, purge: "pending", jobId },
    { status: 202 },
  );
}
