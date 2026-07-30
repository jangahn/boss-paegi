import "server-only";

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  parseReviewerJobStart,
  processReviewerAccountJob,
  reviewerCredentialResetRequired,
} from "@/lib/reviewer-account-saga";
import {
  requireSupabaseData,
  requireSupabaseRows,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { requireOkRpcPayload } from "@/lib/rpc-payload";
import { legacyAdminClientRefresh } from "@/lib/admin-client-compat";
import { log, errInfo } from "@/lib/log";
import { ownRecordValue } from "@/lib/own-record";

export const runtime = "nodejs";

const operationId = z.string().uuid();
const postSchema = z
  .object({
    operationId,
    email: z.email().trim().toLowerCase().max(320),
    note: z.string().trim().max(2000).optional(),
  })
  .strict();
const patchSchema = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("set_active"),
      operationId,
      userId: z.string().uuid(),
      active: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal("reset_password"),
      operationId,
      userId: z.string().uuid(),
    })
    .strict(),
  z
    .object({
      action: z.literal("set_note"),
      userId: z.string().uuid(),
      note: z.string().trim().max(2000).optional(),
    })
    .strict(),
]);
const deleteSchema = z
  .object({
    operationId,
    userId: z.string().uuid(),
  })
  .strict();

const KNOWN_RPC_ERRORS: Record<string, { error: string; status: number }> = {
  invalid_email: { error: "invalid_email", status: 400 },
  invalid_note: { error: "invalid_note", status: 400 },
  email_exists: { error: "email_exists", status: 409 },
  provision_in_progress: { error: "create_pending", status: 409 },
  reviewer_not_found: { error: "not_found", status: 404 },
  sync_in_progress: { error: "sync_pending", status: 409 },
  request_conflict: { error: "request_conflict", status: 409 },
  operation_id_required: { error: "invalid_request", status: 400 },
  not_admin: { error: "not_admin", status: 403 },
};

function safeRpcFailure(error: unknown, fallback: string) {
  const source =
    error instanceof SupabaseOperationError ? error.operationError : error;
  const code =
    source && typeof source === "object" && "message" in source
      ? String((source as { message: unknown }).message)
      : "";
  return (
    ownRecordValue(KNOWN_RPC_ERRORS, code) ?? {
      error: fallback,
      status: 500,
    }
  );
}

async function startJob(
  call: () => PromiseLike<{ data: unknown | null; error?: unknown }>,
) {
  const result = await requireSupabaseData("reviewer.job.start", call);
  return parseReviewerJobStart(result);
}

async function completeOrQueue(
  admin: ReturnType<typeof createAdminClient>,
  start: ReturnType<typeof parseReviewerJobStart>,
  pendingError:
    "create_pending" | "sync_pending" | "reset_pending" | "delete_pending",
) {
  if (start.status === "completed") {
    return {
      response: {
        ok: true,
        userId: start.userId,
        credentialResetRequired: reviewerCredentialResetRequired(start.action),
      },
      status: 200,
    };
  }
  if (start.status === "failed") {
    return {
      response: {
        ok: false,
        error:
          start.action === "provision"
            ? "create_failed"
            : start.action === "reset_password"
              ? "reset_failed"
              : start.action === "delete"
                ? "delete_failed"
                : "sync_failed",
        jobId: start.jobId,
      },
      status: 409,
    };
  }

  const outcome = await processReviewerAccountJob(admin, start.jobId);
  if (outcome.kind === "completed") {
    return {
      response: {
        ok: true,
        userId: outcome.userId,
        ...(outcome.issuedPassword ? { password: outcome.issuedPassword } : {}),
        credentialResetRequired: reviewerCredentialResetRequired(
          outcome.action,
          outcome.issuedPassword,
        ),
      },
      status: 200,
    };
  }
  if (outcome.kind === "failed") {
    return {
      response: {
        ok: false,
        error:
          outcome.action === "provision"
            ? outcome.failure === "auth_email_conflict"
              ? "email_exists"
              : "create_failed"
            : outcome.action === "reset_password"
              ? "reset_failed"
              : outcome.action === "delete"
                ? "delete_failed"
                : "sync_failed",
        jobId: outcome.jobId,
      },
      status: 409,
    };
  }
  return {
    response: {
      ok: false,
      error: pendingError,
      jobId: start.jobId,
    },
    status: 202,
  };
}

export async function GET() {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);
  const admin = createAdminClient();
  try {
    const [rows, jobs] = await Promise.all([
      requireSupabaseRows<{
        user_id: string;
        email: string;
        active: boolean;
        auth_sync_pending: boolean;
        note: string | null;
        created_at: string;
      }>("admin.reviewers.list", () =>
        admin
          .from("reviewer_accounts")
          .select("user_id, email, active, auth_sync_pending, note, created_at")
          .order("created_at", { ascending: true }),
      ),
      requireSupabaseRows("admin.reviewers.jobs", () =>
        admin.rpc("admin_list_reviewer_jobs", {
          p_admin_id: gate.user.id,
          p_limit: 50,
        }),
      ),
    ]);
    return NextResponse.json({ rows, jobs });
  } catch (error) {
    log.warn("admin.reviewers_list_fail", errInfo(error));
    return NextResponse.json({ error: "list_failed" }, { status: 500 });
  }
}

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
  const body = requestBody.value;
  const refresh = legacyAdminClientRefresh("reviewersPost", body);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  const parsed = postSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_email" }, { status: 400 });
  }

  const admin = createAdminClient();
  try {
    const start = await startJob(() =>
      admin.rpc("start_reviewer_provision", {
        p_admin_id: gate.user.id,
        p_operation_id: parsed.data.operationId,
        p_email: parsed.data.email,
        p_note: parsed.data.note || null,
      }),
    );
    const result = await completeOrQueue(admin, start, "create_pending");
    if (result.status === 200) {
      log.info("admin.reviewer_provision_completed", {
        operationId: parsed.data.operationId,
        userId: result.response.userId,
        jobId: start.jobId,
        by: gate.user.id,
      });
    } else {
      log.warn("admin.reviewer_provision_not_completed", {
        operationId: parsed.data.operationId,
        jobId: start.jobId,
        status: result.status,
        error: result.response.error,
      });
    }
    return NextResponse.json(result.response, { status: result.status });
  } catch (error) {
    const failure = safeRpcFailure(error, "create_failed");
    log.error("admin.reviewer_provision_start_fail", {
      operationId: parsed.data.operationId,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: failure.error },
      { status: failure.status },
    );
  }
}

export async function PATCH(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);
  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const bodyValue = requestBody.value;
  const refresh = legacyAdminClientRefresh("reviewersPatch", bodyValue);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  const parsed = patchSchema.safeParse(bodyValue);
  if (!parsed.success) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const body = parsed.data;
  const admin = createAdminClient();

  if (body.action === "set_active") {
    try {
      const start = await startJob(() =>
        admin.rpc("start_reviewer_auth_sync", {
          p_admin_id: gate.user.id,
          p_operation_id: body.operationId,
          p_user_id: body.userId,
          p_action: "set_active",
          p_desired_active: body.active,
        }),
      );
      const result = await completeOrQueue(admin, start, "sync_pending");
      return NextResponse.json(result.response, { status: result.status });
    } catch (error) {
      const failure = safeRpcFailure(error, "update_failed");
      log.error("admin.reviewer_set_active_start_fail", {
        userId: body.userId,
        targetActive: body.active,
        ...errInfo(error),
      });
      return NextResponse.json(
        { error: failure.error },
        { status: failure.status },
      );
    }
  }

  if (body.action === "reset_password") {
    try {
      const start = await startJob(() =>
        admin.rpc("start_reviewer_auth_sync", {
          p_admin_id: gate.user.id,
          p_operation_id: body.operationId,
          p_user_id: body.userId,
          p_action: "reset_password",
          p_desired_active: null,
        }),
      );
      const result = await completeOrQueue(admin, start, "reset_pending");
      return NextResponse.json(result.response, { status: result.status });
    } catch (error) {
      const failure = safeRpcFailure(error, "reset_failed");
      log.error("admin.reviewer_reset_password_start_fail", {
        userId: body.userId,
        ...errInfo(error),
      });
      return NextResponse.json(
        { error: failure.error },
        { status: failure.status },
      );
    }
  }

  try {
    const data = await requireSupabaseData("admin.reviewer.note", () =>
      admin.rpc("admin_set_reviewer_note", {
        p_admin_id: gate.user.id,
        p_user_id: body.userId,
        p_note: body.note || null,
      }),
    );
    return NextResponse.json(requireOkRpcPayload(data));
  } catch (error) {
    const failure = safeRpcFailure(error, "update_failed");
    return NextResponse.json(
      { error: failure.error },
      { status: failure.status },
    );
  }
}

export async function DELETE(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);
  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value;
  const refresh = legacyAdminClientRefresh("reviewersDelete", body);
  if (refresh) {
    return NextResponse.json(refresh.body, { status: refresh.status });
  }
  const parsed = deleteSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }

  const admin = createAdminClient();
  try {
    const start = await startJob(() =>
      admin.rpc("start_reviewer_auth_sync", {
        p_admin_id: gate.user.id,
        p_operation_id: parsed.data.operationId,
        p_user_id: parsed.data.userId,
        p_action: "delete",
        p_desired_active: null,
      }),
    );
    const result = await completeOrQueue(admin, start, "delete_pending");
    return NextResponse.json(result.response, { status: result.status });
  } catch (error) {
    const failure = safeRpcFailure(error, "delete_failed");
    log.error("admin.reviewer_delete_start_fail", {
      userId: parsed.data.userId,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: failure.error },
      { status: failure.status },
    );
  }
}
