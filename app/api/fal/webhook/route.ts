import "server-only";
import { NextRequest, NextResponse } from "next/server";
import {
  FAL_WEBHOOK_MAX_BODY_BYTES,
  getFalWebhookKeys,
  parseFalWebhookPayload,
  refreshFalWebhookKeys,
  verifyFalWebhookSignature,
} from "@/lib/fal-webhook-auth";
import { hashFalCallbackToken } from "@/lib/character-gen/fal-submit-once";
import { parseSubmitRecordResult } from "@/lib/character-gen/generation-submit-saga";
import {
  fluxPulidResultEvidence,
  parseFluxPulidWebhookResult,
} from "@/lib/character-gen/flux-pulid-result-contract";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import { readBoundedResponseBytes } from "@/lib/http/bounded-response";
import {
  deleteFaceTmp,
  tmpFacePath,
} from "@/lib/character-gen/upload-face";
import { isUuid } from "@/lib/upload-write-safety";

export const runtime = "nodejs";
export const maxDuration = 15;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const HASH_RE = /^[0-9a-f]{64}$/;

export async function POST(req: NextRequest) {
  const generationId = req.nextUrl.searchParams.get("g");
  const candidateRaw = req.nextUrl.searchParams.get("c");
  const callbackToken = req.nextUrl.searchParams.get("t");
  const payloadHash = req.nextUrl.searchParams.get("p");
  if (
    !generationId ||
    !UUID_RE.test(generationId) ||
    !candidateRaw ||
    !/^[0-2]$/.test(candidateRaw) ||
    !callbackToken ||
    !TOKEN_RE.test(callbackToken) ||
    !payloadHash ||
    !HASH_RE.test(payloadHash)
  ) {
    return NextResponse.json({ error: "invalid_binding" }, { status: 400 });
  }
  const boundedBody = await readBoundedResponseBytes(
    req,
    FAL_WEBHOOK_MAX_BODY_BYTES,
  );
  if (!boundedBody.ok) {
    return NextResponse.json(
      {
        error:
          boundedBody.error === "too_large"
            ? "body_too_large"
            : "invalid_body",
      },
      { status: boundedBody.error === "too_large" ? 413 : 400 },
    );
  }
  const rawBody = boundedBody.bytes;

  let keys: Awaited<ReturnType<typeof getFalWebhookKeys>>;
  try {
    keys = await getFalWebhookKeys();
  } catch (error) {
    log.warn("gen.webhook_jwks_unavailable", errInfo(error));
    return NextResponse.json(
      { error: "verification_unavailable" },
      { status: 503 },
    );
  }
  let verified = verifyFalWebhookSignature({
    headers: req.headers,
    rawBody,
    keys,
  });
  if (!verified.ok && verified.reason === "invalid_signature") {
    try {
      const refreshedKeys = await refreshFalWebhookKeys();
      verified = verifyFalWebhookSignature({
        headers: req.headers,
        rawBody,
        keys: refreshedKeys,
      });
    } catch (error) {
      log.warn("gen.webhook_jwks_refresh_unavailable", errInfo(error));
      return NextResponse.json(
        { error: "verification_unavailable" },
        { status: 503 },
      );
    }
  }
  if (!verified.ok) {
    log.warn("gen.webhook_signature_rejected", {
      reason: verified.reason,
    });
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  const payload = parseFalWebhookPayload(rawBody, verified.requestId);
  if (!payload) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }
  const providerResult = parseFluxPulidWebhookResult(
    rawBody,
    verified.requestId,
  );
  if (!providerResult || providerResult.status !== payload.status) {
    return NextResponse.json(
      { error: "invalid_provider_result" },
      { status: 400 },
    );
  }

  const callbackTokenHash = hashFalCallbackToken(callbackToken);
  const admin = createAdminClient();
  const { data, error } = await admin.rpc(
    "record_generation_submit_outcome",
    {
      p_gen_id: generationId,
      p_candidate_index: Number(candidateRaw),
      p_payload_hash: payloadHash,
      p_callback_token_hash: callbackTokenHash,
      p_outcome: "acknowledged",
      p_request_id: payload.requestId,
      p_http_status: null,
      p_webhook_status: payload.status,
    },
  );
  if (error) {
    log.warn("gen.webhook_ack_record_fail", {
      genId: generationId,
      index: Number(candidateRaw),
      ...errInfo(error),
    });
    return NextResponse.json({ error: "record_unavailable" }, { status: 503 });
  }

  const outcome = parseSubmitRecordResult(data);
  if (
    providerResult.status === "OK" &&
    (outcome === "acknowledged" || outcome === "already_acknowledged")
  ) {
    const { data: outputData, error: outputError } = await admin.rpc(
      "record_generation_submit_provider_output",
      {
        p_gen_id: generationId,
        p_candidate_index: Number(candidateRaw),
        p_payload_hash: payloadHash,
        p_callback_token_hash: callbackTokenHash,
        p_request_id: payload.requestId,
        p_output: fluxPulidResultEvidence(providerResult.result),
      },
    );
    const outputRecord =
      outputData &&
      typeof outputData === "object" &&
      !Array.isArray(outputData)
        ? (outputData as Record<string, unknown>)
        : null;
    if (
      outputError ||
      outputRecord?.ok !== true ||
      (outputRecord.outcome !== "recorded" &&
        outputRecord.outcome !== "already_recorded" &&
        outputRecord.outcome !== "already_scrubbed")
    ) {
      log.warn("gen.webhook_output_record_fail", {
        genId: generationId,
        index: Number(candidateRaw),
        outcome:
          typeof outputRecord?.outcome === "string"
            ? outputRecord.outcome
            : "invalid",
        ...(outputError ? errInfo(outputError) : {}),
      });
      return NextResponse.json(
        { error: "record_unavailable" },
        { status: 503 },
      );
    }
  }

  // Persist a successful provider output before releasing the raw face. ERROR
  // has no reusable output, while conflict/late states remain operator-visible.
  const { data: cleanupData, error: cleanupReadError } = await admin.rpc(
    "get_generation_face_cleanup_readiness",
    { p_generation_id: generationId },
  );
  const cleanup =
    cleanupData &&
    typeof cleanupData === "object" &&
    !Array.isArray(cleanupData)
      ? (cleanupData as Record<string, unknown>)
      : null;
  if (
    cleanupReadError ||
    cleanup?.ok !== true ||
    typeof cleanup.ready !== "boolean" ||
    !isUuid(cleanup.owner_id)
  ) {
    log.warn("gen.webhook_cleanup_read_unavailable", {
      genId: generationId,
      index: Number(candidateRaw),
      ...errInfo(cleanupReadError),
    });
    return NextResponse.json({ error: "record_unavailable" }, { status: 503 });
  }
  if (cleanup.ready) {
    try {
      await deleteFaceTmp(tmpFacePath(cleanup.owner_id, generationId));
    } catch (cleanupError) {
      log.warn("gen.webhook_face_cleanup_unavailable", {
        genId: generationId,
        index: Number(candidateRaw),
        ...errInfo(cleanupError),
      });
      return NextResponse.json(
        { error: "cleanup_unavailable" },
        { status: 503 },
      );
    }
  }

  if (outcome === "acknowledged" || outcome === "already_acknowledged") {
    log.info("gen.webhook_acknowledged", {
      genId: generationId,
      index: Number(candidateRaw),
      status: payload.status,
      idempotent: outcome === "already_acknowledged",
    });
    return NextResponse.json({ ok: true });
  }
  if (outcome === "request_id_conflict" || outcome === "late_acknowledged") {
    // Retrying the identical webhook cannot resolve these durable operator
    // states; acknowledge delivery and alert without reflecting identifiers.
    log.error("gen.webhook_reconciliation_required", {
      genId: generationId,
      index: Number(candidateRaw),
      outcome,
      status: payload.status,
    });
    return NextResponse.json({ ok: true, reconciliation: true });
  }

  log.warn("gen.webhook_binding_rejected", {
    genId: generationId,
    index: Number(candidateRaw),
  });
  // Signature is valid but the durable binding is terminal/mismatched. This is
  // a permanent result; a 2xx stops fal's 2-hour retry amplification.
  return NextResponse.json({ ok: true, ignored: true });
}
