import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sanitizePayload } from "@/lib/telemetry/validate";
import { MAX_PAYLOAD_BYTES } from "@/lib/telemetry/budget";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 게임플레이 텔레메트리 수신 — **공개**(익명 포착 위해 requireMember 안 씀).
 * 얇은 라우트: parse → member 판별(서버 결정) → deep validation → ingest_telemetry_delta RPC(원자).
 * 회원=풀 timeline, 익명/비회원=요약만(RPC 가 is_anon 으로 timeline 강제 null). 분석 등급(보상 권위 아님).
 */
export async function POST(req: NextRequest) {
  // 1) parse — application/json + sendBeacon(text/plain JSON) 방어 parse, byte cap
  let text: string;
  try {
    text = await req.text();
  } catch {
    return NextResponse.json({ ok: false, error: "bad_body" }, { status: 400 });
  }
  if (text.length > MAX_PAYLOAD_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "bad_json" }, { status: 400 });
  }

  const payload = sanitizePayload(raw);
  if (!payload) {
    return NextResponse.json({ ok: false, error: "invalid_payload" }, { status: 400 });
  }

  // 2) member 판별(서버 결정, 클라 불신) — anonymous Supabase user 도 auth 엔 잡히므로 member_accounts 기준.
  let isMember = false;
  let ownerId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user && !user.is_anonymous) {
      const admin = createAdminClient();
      const { data: member } = await admin
        .from("member_accounts")
        .select("user_id")
        .eq("user_id", user.id)
        .maybeSingle();
      if (member) {
        isMember = true;
        ownerId = user.id;
      }
    }
  } catch {
    // 인증 조회 실패 → 익명으로 취급(요약만). 게임/수집 흐름 무영향.
  }

  // 3) ingest RPC(service_role, 원자: lock·budget·merge·clamp)
  try {
    const admin = createAdminClient();
    const { data, error } = await admin.rpc("ingest_telemetry_delta", {
      p_session_id: payload.sessionId,
      p_owner_id: ownerId,
      p_is_member: isMember,
      p_payload: payload,
    });
    if (error) {
      log.warn("telemetry.ingest_fail", { sessionId: payload.sessionId, ...errInfo(error) });
      return NextResponse.json({ ok: false, error: "ingest_failed" }, { status: 500 });
    }
    const ack = (data ?? {}) as { ok?: boolean; mode?: string; reason?: string; lastSeq?: number };
    return NextResponse.json({
      ok: ack.ok ?? true,
      mode: ack.mode ?? "full",
      reason: ack.reason,
      lastSeq: ack.lastSeq,
    });
  } catch (e) {
    log.warn("telemetry.error", { sessionId: payload.sessionId, ...errInfo(e) });
    return NextResponse.json({ ok: false, error: "server_error" }, { status: 500 });
  }
}
