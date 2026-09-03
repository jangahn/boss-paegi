import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  FAL_WEBHOOK_MAX_BODY_BYTES,
  getFalWebhookKeys,
  refreshFalWebhookKeys,
  verifyFalWebhookSignature,
} from "@/lib/fal-webhook-auth";
import { hashFalCallbackToken } from "@/lib/character-gen/fal-submit-once";
import {
  parseFaceCheckWebhookPayload,
  parseReadyFaceCheckOutputs,
  validFaceCheckWebhookBinding,
} from "@/lib/character-gen/face-check-submit";
import {
  FaceAnalysisUnavailableError,
  buildFaceAnalysis,
} from "@/lib/character-gen/face-analysis";
import { createAdminClient } from "@/lib/supabase/admin";
import { readBoundedResponseBytes } from "@/lib/http/bounded-response";
import { log, errInfo } from "@/lib/log";
import {
  deleteFaceTmp,
  tmpFacePath,
} from "@/lib/character-gen/upload-face";
import { isUuid } from "@/lib/upload-write-safety";
import { selectProvider } from "@/lib/character-gen";
import { continueReservationServerSide } from "@/lib/character-gen/generation-continuation";

export const runtime = "nodejs";
// accepted 면 이 핸들러가 3장 제출까지 이어간다(fal 제출 ~1-3초×3) — 15초는 빠듯해 30초.
export const maxDuration = 30;

export async function POST(req: NextRequest) {
  const binding = {
    reservationId: req.nextUrl.searchParams.get("r"),
    checkKey: req.nextUrl.searchParams.get("k"),
    token: req.nextUrl.searchParams.get("t"),
    payloadHash: req.nextUrl.searchParams.get("p"),
  };
  if (!validFaceCheckWebhookBinding(binding)) {
    return NextResponse.json({ error: "invalid_binding" }, { status: 400 });
  }
  const bounded = await readBoundedResponseBytes(
    req,
    FAL_WEBHOOK_MAX_BODY_BYTES,
  );
  if (!bounded.ok) {
    return NextResponse.json(
      {
        error:
          bounded.error === "too_large" ? "body_too_large" : "invalid_body",
      },
      { status: bounded.error === "too_large" ? 413 : 400 },
    );
  }

  let keys: Awaited<ReturnType<typeof getFalWebhookKeys>>;
  try {
    keys = await getFalWebhookKeys();
  } catch (error) {
    log.warn("gen.face_webhook_jwks_unavailable", errInfo(error));
    return NextResponse.json(
      { error: "verification_unavailable" },
      { status: 503 },
    );
  }
  let verified = verifyFalWebhookSignature({
    headers: req.headers,
    rawBody: bounded.bytes,
    keys,
  });
  if (!verified.ok && verified.reason === "invalid_signature") {
    try {
      verified = verifyFalWebhookSignature({
        headers: req.headers,
        rawBody: bounded.bytes,
        keys: await refreshFalWebhookKeys(),
      });
    } catch (error) {
      log.warn("gen.face_webhook_jwks_refresh_unavailable", errInfo(error));
      return NextResponse.json(
        { error: "verification_unavailable" },
        { status: 503 },
      );
    }
  }
  if (!verified.ok) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  const payload = parseFaceCheckWebhookPayload(
    bounded.bytes,
    verified.requestId,
  );
  if (!payload) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc(
    "record_generation_face_check_webhook",
    {
      p_request_id: binding.reservationId,
      p_check_key: binding.checkKey,
      p_payload_hash: binding.payloadHash,
      p_callback_token_hash: hashFalCallbackToken(binding.token),
      p_external_request_id: payload.requestId,
      p_status: payload.status,
      p_raw_output: payload.rawOutput,
    },
  );
  if (error) {
    log.warn("gen.face_webhook_record_unavailable", {
      check: binding.checkKey,
      ...errInfo(error),
    });
    return NextResponse.json({ error: "record_unavailable" }, { status: 503 });
  }
  const row =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (row?.ok !== true) {
    log.error("gen.face_webhook_reconciliation_required", {
      check: binding.checkKey,
      outcome: typeof row?.outcome === "string" ? row.outcome : "invalid",
    });
    return NextResponse.json({ ok: true, reconciliation: true });
  }
  const ownerId = isUuid(row.owner_id) ? row.owner_id : null;
  const cleanupTerminalInput = async () => {
    if (!ownerId) {
      log.error("gen.face_webhook_cleanup_binding_invalid", {
        check: binding.checkKey,
        outcome: row.outcome,
      });
      return false;
    }
    try {
      await deleteFaceTmp(tmpFacePath(ownerId, binding.reservationId));
      return true;
    } catch (cleanupError) {
      log.warn("gen.face_webhook_cleanup_unavailable", {
        check: binding.checkKey,
        ...errInfo(cleanupError),
      });
      return false;
    }
  };
  if (row.outcome === "rejected") {
    return (await cleanupTerminalInput())
      ? NextResponse.json({ ok: true })
      : NextResponse.json(
          { error: "cleanup_unavailable" },
          { status: 503 },
        );
  }
  if (row.outcome !== "ready") {
    return NextResponse.json({ ok: true });
  }

  const raw = parseReadyFaceCheckOutputs(data);
  if (!raw) {
    log.error("gen.face_webhook_ready_invalid", {
      check: binding.checkKey,
    });
    return NextResponse.json({ error: "record_unavailable" }, { status: 503 });
  }
  let analysis;
  let failureReason: string | null = null;
  try {
    analysis = buildFaceAnalysis(raw);
    // 2026-07-31 제품 결정: QA가 추가한 가림/다인 하드 거부는 일상 사진까지
    // 반려해 정상 사용을 막는다(연속 오탐 실측). 얼굴이 아예 없을 때만
    // 반려하고, 나머지 판정은 분석 결과로만 보존한다(안경은 프롬프트 조건).
    failureReason = !analysis.faceVisible ? "no_face" : null;
    if (!analysis.singlePerson || !analysis.faceClear) {
      log.info("gen.face_check_soft_flag", {
        reservationId: binding.reservationId,
        singlePerson: analysis.singlePerson,
        faceClear: analysis.faceClear,
      });
    }
  } catch (error) {
    analysis = null;
    failureReason =
      error instanceof FaceAnalysisUnavailableError
        ? error.message
        : "face_analysis_invalid";
  }
  const { data: finalizeData, error: finalizeError } = await admin.rpc(
    "finalize_generation_face_checks",
    {
      p_request_id: binding.reservationId,
      p_analysis: analysis,
      p_failure_reason: failureReason,
    },
  );
  const finalized =
    finalizeData &&
    typeof finalizeData === "object" &&
    !Array.isArray(finalizeData)
      ? (finalizeData as Record<string, unknown>)
      : null;
  if (
    finalizeError ||
    finalized?.ok !== true ||
    finalized.outcome !== "accepted" &&
    finalized.outcome !== "rejected" &&
    finalized.outcome !== "failed"
  ) {
    log.warn("gen.face_webhook_finalize_unavailable", {
      check: binding.checkKey,
      ...errInfo(finalizeError),
    });
    return NextResponse.json({ error: "record_unavailable" }, { status: 503 });
  }
  if (finalized.outcome === "accepted") {
    // v1.20: 얼굴검사 통과 → 서버가 곧바로 크레딧 commit + 3장 제출(클라이언트 재요청 불필요).
    // 보존된 원본(tmp/face/{reservationId})은 continuation 이 genId 경로로 복사한 뒤 지운다.
    // 여기서 실패해도 응답은 200 — fal 재전송이 아니라 gen-recover 스윕(5분)이 백스톱이고,
    // 그마저 못 이어가면 release_stale(10분+) 환불·고아 sweep(12분+) 정리로 종결된다.
    try {
      await continueReservationServerSide({
        admin,
        provider: selectProvider(null),
        requestId: binding.reservationId,
        trigger: "face_webhook",
      });
    } catch (error) {
      log.warn("gen.face_webhook_continuation_fail", {
        check: binding.checkKey,
        ...errInfo(error),
      });
    }
    return NextResponse.json({ ok: true });
  }
  if (!(await cleanupTerminalInput())) {
    return NextResponse.json(
      { error: "cleanup_unavailable" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
