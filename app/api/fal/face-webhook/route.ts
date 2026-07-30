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

export const runtime = "nodejs";
export const maxDuration = 15;

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
    failureReason = !analysis.faceVisible
      ? "no_face"
      : !analysis.singlePerson
        ? "multiple_people"
        : !analysis.faceClear
          ? "face_obstructed"
          : null;
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
  if (!(await cleanupTerminalInput())) {
    return NextResponse.json(
      { error: "cleanup_unavailable" },
      { status: 503 },
    );
  }
  return NextResponse.json({ ok: true });
}
