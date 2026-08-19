import { NextResponse } from "next/server";
import { requireAuthedNonDeleted, memberGateResponse } from "@/lib/auth-server";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import {
  parseAccountDeletionStart,
  processAccountDeletionCleanupJob,
} from "@/lib/account-delete-cleanup-job";
import {
  requireSupabaseData,
  requireSupabaseSuccess,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { SCRUBBED_PROFILE_DISPLAY_NAME } from "@/lib/oauth-metadata";

export const runtime = "nodejs";
export const maxDuration = 60;

function failureContext(error: unknown) {
  if (error instanceof SupabaseOperationError) {
    return {
      operation: error.operation,
      ...errInfo(error.operationError),
    };
  }
  return errInfo(error);
}

function deletionBlock(error: unknown): "payment_pending" | "financial_cleanup_pending" | null {
  const cause =
    error instanceof SupabaseOperationError
      ? error.operationError
      : error;
  const message =
    cause && typeof cause === "object" && "message" in cause
      ? String((cause as { message?: unknown }).message)
      : String(cause);
  if (message.includes("payment_pending")) return "payment_pending";
  if (
    message.includes("open_refund_blocks_delete") ||
    message.includes("open_issue_blocks_delete")
  ) {
    return "financial_cleanup_pending";
  }
  return null;
}

/**
 * 셀프 계정 탈퇴(soft-delete) — 개인정보 삭제권 대응.
 * DB RPC가 pending/금융 차단 확인 → asset manifest+durable cleanup job 생성 → 금융 quarantine
 * → soft-delete를 한 트랜잭션으로 수행한다. Route는 job을 즉시 처리하되 외부 정리 실패/함수 중단은
 * 202 accepted(cleanup=pending)로 로그아웃을 허용하고 content-maintain 재시도에 맡긴다.
 * 결제기록(orders)은 법령상 보존을 위해 남긴다.
 */
export async function POST(req: Request) {
  // destructive — 최소 same-origin 방어. JSON POST 만(라우트가 POST 전용).
  const origin = req.headers.get("origin");
  const host = req.headers.get("host");
  if (origin && host) {
    try {
      if (new URL(origin).host !== host) {
        return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
      }
    } catch {
      return NextResponse.json({ error: "forbidden_origin" }, { status: 403 });
    }
  }

  // 탈퇴는 "회원기능 사용"이 아니라 "계정 종료 권리" — 로그인만 요구(동의 완료 무관).
  const gate = await requireAuthedNonDeleted();
  if (!gate.ok) return memberGateResponse(gate);
  const userId = gate.user.id;
  const admin = createAdminClient();

  let start;
  try {
    const result = await requireSupabaseSuccess("account.soft_delete", () =>
      admin.rpc("admin_soft_delete_account", {
        p_user_id: userId,
      }),
    );
    start = parseAccountDeletionStart(result.data, userId);

    // The RPC acknowledgement is necessary but not sufficient for a
    // destructive success. Re-read the durable lifecycle state before the UI
    // is allowed to sign out and present deletion as accepted.
    const profile = await requireSupabaseData<{
      id: string;
      deleted_at: string | null;
      display_name: string;
      avatar_url: string | null;
    } | null>("account.soft_delete.profile", () =>
      admin
        .from("profiles")
        .select("id, deleted_at, display_name, avatar_url")
        .eq("id", userId)
        .maybeSingle(),
    );
    const member = await requireSupabaseData<{
      user_id: string;
      email: string | null;
      gen_credits: number;
    } | null>("account.soft_delete.member", () =>
      admin
        .from("member_accounts")
        .select("user_id, email, gen_credits")
        .eq("user_id", userId)
        .maybeSingle(),
    );
    if (
      !profile ||
      !member ||
      profile.id !== userId ||
      typeof profile.deleted_at !== "string" ||
      profile.display_name !== SCRUBBED_PROFILE_DISPLAY_NAME ||
      profile.avatar_url !== null ||
      member.user_id !== userId ||
      member.email !== null ||
      member.gen_credits !== 0
    ) {
      throw new Error("account_soft_delete_postcondition_failed");
    }
  } catch (error) {
    const blocked = deletionBlock(error);
    if (blocked) {
      return NextResponse.json({ error: blocked }, { status: 409 });
    }
    log.error("account.soft_delete_fail", {
      userId,
      ...failureContext(error),
    });
    return NextResponse.json({ error: "delete_failed" }, { status: 500 });
  }

  if (start.cleanupStatus === "completed") {
    log.info("account.delete_completed", { userId, cleanupJobId: start.jobId });
    return NextResponse.json({ ok: true, cleanup: "completed" });
  }

  // SQL이 반환한 pre-delete manifest로 즉시 처리한다. claim/finish RPC 오류나 외부 실패가 나도
  // durable pending/lease가 남으므로 탈퇴 자체를 실패로 되돌려 표현하지 않는다.
  try {
    const outcome = await processAccountDeletionCleanupJob(admin, {
      jobId: start.jobId,
      userId,
      manifest: start.manifest ?? undefined,
    });

    if (outcome.kind === "completed") {
      log.info("account.delete_completed", {
        userId,
        cleanupJobId: outcome.jobId,
        cleanupAttempt: outcome.attemptCount,
      });
      return NextResponse.json({ ok: true, cleanup: "completed" });
    }

    log.warn("account.delete_cleanup_queued", {
      userId,
      cleanupJobId: start.jobId,
      cleanupState: outcome.kind,
      ...(outcome.kind === "pending"
        ? {
            cleanupAttempt: outcome.attemptCount,
            cleanupFailure: outcome.failure,
            retryRecorded: outcome.retryRecorded,
          }
        : {}),
    });
  } catch (error) {
    log.warn("account.delete_cleanup_queued", {
      userId,
      cleanupJobId: start.jobId,
      ...failureContext(error),
    });
  }

  return NextResponse.json(
    { accepted: true, cleanup: "pending" },
    { status: 202 },
  );
}
