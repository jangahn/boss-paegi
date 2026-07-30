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
  parseDollPickWebhookPayload,
  validDollPickBinding,
} from "@/lib/character-gen/doll-pick-submit";
import { createAdminClient } from "@/lib/supabase/admin";
import { readBoundedResponseBytes } from "@/lib/http/bounded-response";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
export const maxDuration = 15;

export async function POST(req: NextRequest) {
  const binding = {
    generationId: req.nextUrl.searchParams.get("g"),
    attemptId: req.nextUrl.searchParams.get("a"),
    token: req.nextUrl.searchParams.get("t"),
    payloadHash: req.nextUrl.searchParams.get("p"),
  };
  if (!validDollPickBinding(binding)) {
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
    log.warn("doll.pick_webhook_jwks_unavailable", errInfo(error));
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
      log.warn("doll.pick_webhook_jwks_refresh_unavailable", errInfo(error));
      return NextResponse.json(
        { error: "verification_unavailable" },
        { status: 503 },
      );
    }
  }
  if (!verified.ok) {
    return NextResponse.json({ error: "invalid_signature" }, { status: 401 });
  }
  const payload = parseDollPickWebhookPayload(
    bounded.bytes,
    verified.requestId,
  );
  if (!payload) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data, error } = await admin.rpc(
    "record_generation_pick_webhook_result",
    {
      p_generation_id: binding.generationId,
      p_attempt_id: binding.attemptId,
      p_payload_hash: binding.payloadHash,
      p_callback_token_hash: hashFalCallbackToken(binding.token),
      p_request_id: payload.requestId,
      p_status: payload.status,
      p_result_url: payload.resultUrl,
    },
  );
  if (error) {
    log.warn("doll.pick_webhook_record_unavailable", {
      genId: binding.generationId,
      ...errInfo(error),
    });
    return NextResponse.json({ error: "record_unavailable" }, { status: 503 });
  }
  const row =
    data && typeof data === "object" && !Array.isArray(data)
      ? (data as Record<string, unknown>)
      : null;
  if (
    row?.ok === true &&
    (row.outcome === "provider_done" ||
      row.outcome === "rejected" ||
      row.outcome === "committed")
  ) {
    return NextResponse.json({ ok: true });
  }

  // A valid signed webhook with a stale/mismatched durable binding is
  // permanent. Return 2xx to stop fal's two-hour delivery retries and alert.
  log.error("doll.pick_webhook_reconciliation_required", {
    genId: binding.generationId,
    outcome: typeof row?.outcome === "string" ? row.outcome : "invalid",
  });
  return NextResponse.json({ ok: true, reconciliation: true });
}
