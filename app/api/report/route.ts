import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";
import { rateLimit } from "@/lib/rate-limit";
import { PUBLIC_ENV } from "@/lib/env";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

// 신고 사유 allowlist — DB 는 char_length 만, 의미 검증은 여기서.
const REASONS = new Set(["portrait", "defamation", "obscene", "hate", "other"]);
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function clientIp(req: NextRequest): string {
  const xff = req.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]!.trim();
  return req.headers.get("x-real-ip") ?? "unknown";
}

/**
 * 공개 콘텐츠 신고 — **인증 불요**(피해자는 보통 비가입 제3자). Phase 1 target=doll 만.
 * 흐름: 검증 → rate-limit(IP + IP·target) → 대상 doll 존재/미삭제 확인 →
 *   dedup(insert 전 pending 조회) → content_reports insert(service-role) →
 *   첫 pending 이면 Sentry 알림(자동숨김 없음 → 알림이 SLA). 콘텐츠 자체는 어드민 수동 takedown.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as {
    targetId?: string;
    reason?: string;
    detail?: string;
    contact?: string;
  } | null;

  if (!body?.targetId || !UUID_RE.test(body.targetId) || !body?.reason) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  if (!REASONS.has(body.reason)) {
    return NextResponse.json({ error: "reason_invalid" }, { status: 400 });
  }
  const detail = (body.detail ?? "").trim().slice(0, 2000) || null;
  const contact = (body.contact ?? "").trim().slice(0, 200) || null;

  // rate-limit: IP 5/시간 + 동일 IP·동일 target 2/시간(같은 대상 스팸 방지).
  const ip = clientIp(req);
  if (
    !rateLimit(`report:ip:${ip}`, 5, 3_600_000) ||
    !rateLimit(`report:ip:${ip}:doll:${body.targetId}`, 2, 3_600_000)
  ) {
    return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  }

  const admin = createAdminClient();

  // 대상 doll 존재 + 미삭제 검증(이미 내려갔으면 신고 무의미 → 조용히 ok).
  const { data: doll } = await admin
    .from("dolls")
    .select("id, deleted_at")
    .eq("id", body.targetId)
    .maybeSingle();
  if (!doll) return NextResponse.json({ error: "target_not_found" }, { status: 404 });
  if ((doll as { deleted_at?: string | null }).deleted_at) {
    return NextResponse.json({ ok: true, already_removed: true });
  }

  // 신고자(선택): 세션 있으면 기록(익명 세션 포함), 없으면 null. 인증 강제 아님.
  let reporterUserId: string | null = null;
  try {
    const sb = await createClient();
    const { data: u } = await sb.auth.getUser();
    reporterUserId = u.user?.id ?? null;
  } catch {
    /* 비로그인 — null */
  }

  // dedup: insert **전에** 동일 target pending 존재 여부 조회(방금 넣은 row 로 첫 신고가 skip되는 버그 방지).
  const { count: pendingCount } = await admin
    .from("content_reports")
    .select("id", { count: "exact", head: true })
    .eq("target_type", "doll")
    .eq("target_id", body.targetId)
    .eq("status", "pending");
  const isFirstPending = (pendingCount ?? 0) === 0;

  const { data: inserted, error: insErr } = await admin
    .from("content_reports")
    .insert({
      target_type: "doll",
      target_id: body.targetId,
      reason: body.reason,
      detail,
      reporter_user_id: reporterUserId,
      reporter_contact: contact,
    })
    .select("id")
    .single();
  if (insErr) {
    log.error("report.insert_fail", { dollId: body.targetId, ...errInfo(insErr) });
    return NextResponse.json({ error: "report_failed" }, { status: 500 });
  }

  // 운영자 알림 — 첫 pending 일 때만(타깃별 dedup). 자동숨김 없음 → 이 알림이 takedown SLA 의 트리거.
  //   log.error → Sentry captureMessage(이슈 'report.new') → Sentry 알림룰(occurrence당)로 모바일 푸시.
  //   ctx 는 id·경로만(시크릿/얼굴/서명URL 없음). 인증 없는 one-click 토큰 미포함 — 운영자 로그인 후 조치.
  if (isFirstPending) {
    const base = PUBLIC_ENV.SITE_URL;
    log.error("report.new", {
      reportId: (inserted as { id: string }).id,
      dollId: body.targetId,
      reason: body.reason,
      hasContact: !!contact,
      adminLink: `${base}/admin/moderation?target=doll:${body.targetId}`,
      dollLink: `${base}/doll/${body.targetId}`,
    });
  }

  return NextResponse.json({ ok: true });
}
