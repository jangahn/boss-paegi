import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { randomUUID } from "node:crypto";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { sanitizeHighlightMeta } from "@/lib/highlight";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

const BUCKET = "highlights";
/** hard cap — 클라 목표 ~2MB, tolerance 포함 */
const MAX_BYTES = 4 * 1024 * 1024;
const TTL_MS = 30 * 24 * 3600_000;

function mimeToExt(mime?: string): "mp4" | "webm" | null {
  if (!mime) return null;
  if (mime.startsWith("video/mp4")) return "mp4";
  if (mime.startsWith("video/webm")) return "webm";
  return null;
}

/** POST — 서명 업로드 URL 발급 (클립 바이트는 Vercel 안 거침). */
export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    scoreId?: string;
    mime?: string;
  } | null;
  const scoreId = body?.scoreId;
  const ext = mimeToExt(body?.mime);
  if (!scoreId || !ext) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("scores")
    .select("id, owner_id")
    .eq("id", scoreId)
    .single();
  if (!row || row.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { data: hl } = await admin
    .from("score_highlights")
    .select("highlight_status")
    .eq("score_id", scoreId)
    .maybeSingle();
  if (hl?.highlight_status === "attached") {
    return NextResponse.json({ error: "already_attached" }, { status: 409 });
  }

  const uploadId = randomUUID();
  const path = `${scoreId}/${uploadId}.${ext}`;
  const { data: signed, error } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error || !signed) {
    log.warn("highlight.signed_url_fail", { scoreId, ...errInfo(error) });
    return NextResponse.json({ error: "signed_url_failed" }, { status: 500 });
  }
  return NextResponse.json({ uploadId, ext, path, token: signed.token });
}

/** PATCH — 업로드 완료 후 object metadata 검증 + DB attach (score당 1회). */
export async function PATCH(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = (await req.json().catch(() => null)) as {
    scoreId?: string;
    mode?: string;
    uploadId?: string;
    ext?: string;
    delta?: number;
    windowMs?: number;
  } | null;
  const scoreId = body?.scoreId;
  const mode = body?.mode === "card" ? "card" : "clip";
  if (!scoreId) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row } = await admin
    .from("scores")
    .select("id, owner_id, score")
    .eq("id", scoreId)
    .single();
  if (!row || row.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  // 표시용 메타 검증/클램프 (클라 값 불신) — clip/card 공통
  const meta = sanitizeHighlightMeta(
    { delta: body?.delta, windowMs: body?.windowMs },
    typeof row.score === "number" ? row.score : 0
  );

  const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
  // attach-once 는 score_highlights.score_id PK insert 로 보장 (중복 = 23505 → already_set).
  // upsert 안 씀 — 두 탭/더블클릭/clip-card 경합에서 기존 하이라이트 덮어쓰기 방지.

  // ── card 모드: 클립 없이 급상승 stat 만 저장(녹화 미지원/실패 폴백) ─────
  if (mode === "card") {
    const { error: insErr } = await admin.from("score_highlights").insert({
      score_id: scoreId,
      highlight_status: "card",
      highlight_delta: meta.delta,
      highlight_window_ms: meta.windowMs,
      highlight_expires_at: expiresAt,
    });
    if (insErr) {
      if (insErr.code === "23505")
        return NextResponse.json({ error: "already_set" }, { status: 409 });
      log.error("highlight.card_attach_fail", { scoreId, ...errInfo(insErr) });
      return NextResponse.json({ error: "card_failed" }, { status: 500 });
    }
    revalidatePath(`/share/${scoreId}`);
    log.info("highlight.highlight_card_saved", { scoreId, delta: meta.delta });
    return NextResponse.json({ ok: true });
  }

  // ── clip 모드: 업로드된 object 검증 후 attach ───────────────────────
  const uploadId = body?.uploadId;
  const ext = body?.ext === "mp4" || body?.ext === "webm" ? body.ext : null;
  if (!uploadId || !ext) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const path = `${scoreId}/${uploadId}.${ext}`;

  // 서버측 object metadata 검증 (클라 size/mime 불신)
  const { data: info, error: infoErr } = await admin.storage.from(BUCKET).info(path);
  if (infoErr || !info) {
    log.warn("highlight.upload_missing", { scoreId, ...errInfo(infoErr) });
    return NextResponse.json({ error: "upload_missing" }, { status: 404 });
  }
  const size = info.size ?? 0;
  const mimetype = info.contentType ?? "";
  const mimeOk =
    (ext === "mp4" && mimetype.includes("mp4")) ||
    (ext === "webm" && mimetype.includes("webm"));
  if (size <= 0 || size > MAX_BYTES || !mimeOk) {
    log.warn("highlight.upload_rejected_size", { scoreId, size, mimetype });
    await admin.storage.from(BUCKET).remove([path]).catch(() => {});
    return NextResponse.json({ error: "rejected" }, { status: 400 });
  }

  const { error: insErr } = await admin.from("score_highlights").insert({
    score_id: scoreId,
    highlight_clip_path: path,
    highlight_upload_id: uploadId,
    highlight_status: "attached",
    highlight_clip_mime: mimetype,
    highlight_clip_size: size,
    highlight_delta: meta.delta,
    highlight_window_ms: meta.windowMs,
    highlight_expires_at: expiresAt,
  });
  if (insErr) {
    if (insErr.code === "23505") {
      // 이미 확정 → 이번 업로드는 orphan, 제거
      await admin.storage.from(BUCKET).remove([path]).catch(() => {});
      return NextResponse.json({ error: "already_set" }, { status: 409 });
    }
    log.error("highlight.attach_fail", { scoreId, ...errInfo(insErr) });
    return NextResponse.json({ error: "attach_failed" }, { status: 500 });
  }

  revalidatePath(`/share/${scoreId}`);
  log.info("highlight.upload_success", { scoreId, size, delta: meta.delta });
  return NextResponse.json({ ok: true });
}
