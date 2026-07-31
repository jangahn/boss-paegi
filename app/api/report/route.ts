import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { readCurrentAuthSessionState } from "@/lib/auth-session-live";
import { rateLimit } from "@/lib/rate-limit";
import { PUBLIC_ENV } from "@/lib/env";
import { log, errInfo } from "@/lib/log";
import {
  contentReportRpcErrorCode,
  parseContentReportInput,
  parseContentReportSubmission,
} from "@/lib/content-report";
import { readBoundedJsonRequest } from "@/lib/http/bounded-json-request";
import { publicWriteNetworkActorKey } from "@/lib/public-write-quota";
import {
  parsePublicWriteAttemptFailure,
  parsePublicWriteAttemptReservation,
} from "@/lib/public-write-attempt";

export const runtime = "nodejs";
export const CONTENT_REPORT_MAX_BODY_BYTES = 32 * 1024;

function reportWriteErrorResponse(code: string | null): NextResponse | null {
  if (code === "target_not_found") {
    return NextResponse.json({ error: "target_not_found" }, { status: 404 });
  }
  if (
    code === "rate_limited" ||
    code === "report_write_global_request_quota" ||
    code === "report_write_network_request_quota"
  ) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }
  if (code === "report_write_quota_busy" || code === "quota_busy") {
    return NextResponse.json(
      { error: "report_unavailable" },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }
  if (code === "submission_conflict") {
    return NextResponse.json(
      { error: "submission_conflict", retryable: false },
      { status: 409 },
    );
  }
  return null;
}

/**
 * 공개 콘텐츠 신고 — **인증 불요**(피해자는 보통 비가입 제3자). Phase 1 target=doll 만.
 * 흐름: 검증 → rate-limit(IP + IP·target) → operation/quota 별도 commit →
 * submit_content_report(0080)가 대상 잠금+존재/삭제 판정+pending wave 첫 신고
 * 선출+insert를 한 트랜잭션으로 수행 →
 * 첫 pending 이면 Sentry 알림(자동숨김 없음 → 알림이 SLA). 콘텐츠 자체는 어드민 수동 takedown.
 */
export async function POST(req: NextRequest) {
  const requestBody = await readBoundedJsonRequest(
    req,
    CONTENT_REPORT_MAX_BODY_BYTES,
  );
  if (!requestBody.ok) {
    return NextResponse.json(
      {
        error:
          requestBody.error === "too_large"
            ? "payload_too_large"
            : "invalid_body",
      },
      { status: requestBody.error === "too_large" ? 413 : 400 },
    );
  }
  const parsed = parseContentReportInput(requestBody.value);
  if (!parsed.ok) {
    return NextResponse.json(
      {
        error: parsed.error,
        ...(parsed.error === "client_upgrade_required"
          ? { reload: true, retryable: false }
          : {}),
      },
      { status: parsed.error === "client_upgrade_required" ? 409 : 400 },
    );
  }
  const { submissionId, targetId, reason, detail, contact } = parsed.value;

  // rate-limit: IP 5/시간 + 동일 IP·동일 target 2/시간(같은 대상 스팸 방지).
  // The RPC still runs when a limiter is exhausted: an exact durable receipt
  // may be replayed, while a new submission is rejected transactionally.
  const networkActorKey = publicWriteNetworkActorKey(req.headers);
  if (!networkActorKey) {
    return NextResponse.json(
      { error: "report_unavailable" },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }
  const ipAllowed = rateLimit(
    `report:network:${networkActorKey}`,
    5,
    3_600_000,
  );
  const targetAllowed = rateLimit(
    `report:network:${networkActorKey}:doll:${targetId}`,
    2,
    3_600_000,
  );
  const rateAllowed = ipAllowed && targetAllowed;

  const admin = createAdminClient();

  // Commit quota + operation identity before target/core validation. This
  // survives a later core rejection and makes an exact failed retry cheap.
  const reservationRpc = await admin.rpc("reserve_report_write_attempt", {
    p_submission_id: submissionId,
    p_target_id: targetId,
    p_reason: reason,
    p_detail: detail,
    p_reporter_contact: contact,
    p_network_actor_key: networkActorKey,
  });
  if (reservationRpc.error) {
    const code = contentReportRpcErrorCode(reservationRpc.error);
    const mapped = reportWriteErrorResponse(code);
    if (mapped) return mapped;
    log.error("report.reserve_fail", {
      dollId: targetId,
      ...errInfo(reservationRpc.error),
    });
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }
  const reservation = parsePublicWriteAttemptReservation(reservationRpc.data);
  if (!reservation) {
    log.error("report.reserve_invalid_response", { dollId: targetId });
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }
  if (reservation.kind === "error") {
    const mapped = reportWriteErrorResponse(reservation.errorCode);
    if (mapped) return mapped;
    log.error("report.reserve_rejected", {
      dollId: targetId,
      errorCode: reservation.errorCode,
    });
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }

  let rpcData: unknown = null;
  if (reservation.kind === "replay") {
    rpcData = reservation.result;
  } else {
    // 신고자(선택): 세션 있으면 기록(익명 세션 포함), 없으면 null.
    let reporterUserId: string | null = null;
    try {
      const sb = await createClient();
      const { data, error } = await sb.auth.getUser();
      if (error) {
        log.warn("report.reporter_auth_unavailable", errInfo(error));
      } else if (data.user) {
        const sessionState = await readCurrentAuthSessionState(() =>
          sb.rpc("oauth_current_auth_session_live"),
        );
        if (sessionState.kind === "unavailable") {
          log.warn(
            "report.reporter_session_unavailable",
            errInfo(sessionState.error),
          );
        } else if (sessionState.kind === "live") {
          reporterUserId = data.user.id;
        }
      }
    } catch (error) {
      // 공개 보호수단이므로 세션 판별 장애가 접수를 막아서는 안 된다.
      log.warn("report.reporter_auth_unavailable", errInfo(error));
    }

    let rpcResult: Awaited<ReturnType<typeof admin.rpc>>;
    try {
      rpcResult = await admin.rpc("submit_content_report", {
        p_submission_id: submissionId,
        p_target_id: targetId,
        p_reason: reason,
        p_detail: detail,
        p_reporter_user_id: reporterUserId,
        p_reporter_contact: contact,
        p_rate_allowed: rateAllowed,
        p_network_actor_key: networkActorKey,
      });
    } catch (error) {
      log.error("report.insert_fail", {
        dollId: targetId,
        ...errInfo(error),
      });
      return NextResponse.json({ error: "report_failed" }, { status: 500 });
    }
    if (rpcResult.error) {
      const code = contentReportRpcErrorCode(rpcResult.error);
      const mapped = reportWriteErrorResponse(code);
      if (mapped) return mapped;
      log.error("report.insert_fail", {
        dollId: targetId,
        ...errInfo(rpcResult.error),
      });
      return NextResponse.json({ error: "report_failed" }, { status: 500 });
    }
    rpcData = rpcResult.data;
  }

  const attemptError = parsePublicWriteAttemptFailure(rpcData);
  if (attemptError) {
    const mapped = reportWriteErrorResponse(attemptError);
    if (mapped) return mapped;
    log.error("report.insert_attempt_failed", {
      dollId: targetId,
      errorCode: attemptError,
    });
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }
  const submission = parseContentReportSubmission(rpcData);
  if (!submission) {
    log.error("report.invalid_rpc_response", { dollId: targetId });
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }
  if (submission.kind === "already_removed") {
    return NextResponse.json({
      ok: true,
      already_removed: true,
      duplicate: submission.duplicate,
    });
  }

  // 운영자 알림 — 첫 pending 일 때만(타깃별 dedup). 자동숨김 없음 → 이 알림이 takedown SLA 의 트리거.
  //   log.error → Sentry captureMessage(이슈 'report.new') → Sentry 알림룰(occurrence당)로 모바일 푸시.
  //   ctx 는 id·경로만(시크릿/얼굴/서명URL 없음). 인증 없는 one-click 토큰 미포함 — 운영자 로그인 후 조치.
  if (
    submission.kind === "inserted" &&
    submission.wasFirst &&
    !submission.duplicate
  ) {
    const base = PUBLIC_ENV.SITE_URL;
    log.error("report.new", {
      reportId: submission.reportId,
      dollId: targetId,
      reason,
      hasContact: !!contact,
      adminLink: `${base}/admin/moderation?target=doll:${targetId}`,
      dollLink: `${base}/doll/${targetId}`,
    });
  }

  return NextResponse.json({
    ok: true,
    duplicate: submission.duplicate,
  });
}
