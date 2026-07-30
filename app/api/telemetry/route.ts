import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  readTelemetryRequestBody,
  sanitizePayload,
} from "@/lib/telemetry/validate";
import { resolveTelemetryActor } from "@/lib/telemetry/member-context";
import {
  ingestTelemetryBounded,
  isTerminalTelemetryAck,
  telemetryDropAck,
} from "@/lib/telemetry/server-ingest";
import { publicWriteActorKey } from "@/lib/public-write-quota";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";
const TELEMETRY_RETRY_AFTER_SECONDS = 1;

function retryableTelemetryResponse(error: string) {
  return NextResponse.json(
    { ok: false, error },
    {
      status: 503,
      headers: {
        "Cache-Control": "no-store",
        "Retry-After": String(TELEMETRY_RETRY_AFTER_SECONDS),
      },
    },
  );
}

/**
 * 게임플레이 텔레메트리 수신 — **공개**(익명 포착 위해 requireMember 안 씀).
 * 얇은 라우트: byte cap → parse/deep validation → member 판별(서버 결정) → ingest RPC(원자).
 * 회원=풀 timeline, 익명/비회원=요약만(RPC 가 is_anon 으로 timeline 강제 null). 분석 등급(보상 권위 아님).
 */
export async function POST(req: NextRequest) {
  // 1) parse — application/json + sendBeacon(text/plain JSON) 방어 parse, byte cap
  const body = await readTelemetryRequestBody(req);
  if (!body.ok) {
    const status = body.error === "payload_too_large" ? 413 : 400;
    return NextResponse.json({ ok: false, error: body.error }, { status });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const payload = sanitizePayload(raw);
  if (!payload) {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  // 2) member 판별(서버 결정, 클라 불신). Auth/DB 장애를 anonymous로 강등하면
  // owner-less session이 영구 생성되어 이후 회원 delta가 owner_mismatch가 되므로 fail-closed.
  const supabase = await createClient();
  const identityAdmin = createAdminClient();
  const actor = await resolveTelemetryActor({
    getAuthUser: async () => {
      const result = await supabase.auth.getUser();
      return {
        data: result.data.user
          ? {
              id: result.data.user.id,
              isAnonymous: result.data.user.is_anonymous === true,
            }
          : null,
        error: result.error,
      };
    },
    getProfile: async (userId) => {
      const result = await identityAdmin
        .from("profiles")
        .select("deleted_at")
        .eq("id", userId)
        .maybeSingle();
      return {
        data: result.data
          ? { deletedAt: result.data.deleted_at as string | null }
          : null,
        error: result.error,
      };
    },
    getMember: async (userId) => {
      const result = await identityAdmin
        .from("member_accounts")
        .select("user_id")
        .eq("user_id", userId)
        .maybeSingle();
      return {
        data: result.data
          ? { userId: result.data.user_id as string }
          : null,
        error: result.error,
      };
    },
  });
  if (!actor.ok) {
    log.warn("telemetry.identity_rejected", {
      sessionId: payload.sessionId,
      stage: actor.stage,
      ...(actor.cause ? errInfo(actor.cause) : {}),
    });
    return NextResponse.json(
      { ok: false, error: actor.error },
      { status: actor.status },
    );
  }

  // 3) DB-authoritative bounded ingest. Auth UUID/IP is converted in memory to
  // an opaque HMAC actor key; the raw address is never stored or logged.
  const actorKey = publicWriteActorKey(
    req.headers,
    actor.submitterId,
    actor.isMember,
  );
  if (!actorKey) {
    return retryableTelemetryResponse("quota_unavailable");
  }
  const result = await ingestTelemetryBounded({
    sessionId: payload.sessionId,
    submitterId: actor.submitterId,
    isMember: actor.isMember,
    actorKey,
    payload,
  });
  if (!result.ok) {
    log.warn("telemetry.ingest_fail", {
      sessionId: payload.sessionId,
      stage: result.reason,
      ...(result.cause ? errInfo(result.cause) : {}),
    });
    return retryableTelemetryResponse("ingest_unavailable");
  }
  if (!isTerminalTelemetryAck(result.ack)) {
    log.warn("telemetry.ingest_retryable", {
      sessionId: payload.sessionId,
      reason: result.ack.reason ?? "invalid_ack_semantics",
    });
    return retryableTelemetryResponse("ingest_unavailable");
  }
  const ack = result.ack.ok
    ? result.ack
    : telemetryDropAck(payload.summary.seqHigh, result.ack.reason!);
  return NextResponse.json({
    ok: ack.ok,
    mode: ack.mode,
    reason: ack.reason,
    lastSeq: ack.lastSeq,
  });
}
