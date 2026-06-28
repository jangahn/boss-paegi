import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { EVENTS_BUCKET } from "@/lib/storage-path";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/** 이벤트/공지 이미지(커버·본문 인라인) — public events 버킷. 어드민 전용. avatars 라우트 패턴 복제. */
const MAX_BYTES = 5 * 1024 * 1024; // 커버·인라인 각 5MB

// SVG 금지(public SVG = XSS/추적). jpeg/png/webp/gif 만.
function mimeToExt(mime?: string): "png" | "jpg" | "webp" | "gif" | null {
  if (!mime) return null;
  if (mime.startsWith("image/png")) return "png";
  if (mime.startsWith("image/jpeg")) return "jpg";
  if (mime.startsWith("image/webp")) return "webp";
  if (mime.startsWith("image/gif")) return "gif";
  return null;
}

const PATH_RE = /^\d{6}\/[0-9a-f-]{36}\.(png|jpg|webp|gif)$/;

/** YYYYMM (KST). */
function kstYearMonth(): string {
  const d = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD
  return d.slice(0, 4) + d.slice(5, 7);
}

/** POST — 서명 업로드 URL 발급(바이트는 Vercel 안 거침). 어드민 전용. */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as { mime?: string } | null;
  const ext = mimeToExt(body?.mime);
  if (!ext) return NextResponse.json({ error: "invalid_mime" }, { status: 400 });

  const admin = createAdminClient();
  const path = `${kstYearMonth()}/${randomUUID()}.${ext}`;
  const { data: signed, error } = await admin.storage
    .from(EVENTS_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !signed) {
    log.warn("event_image.signed_url_fail", { userId: gate.user.id, ...errInfo(error) });
    return NextResponse.json({ error: "signed_url_failed" }, { status: 500 });
  }
  return NextResponse.json({ path, ext, token: signed.token });
}

/** PATCH — 업로드 완료 검증(어드민 전용) → { path, url }. path 형식·object size/mime 재확인. */
export async function PATCH(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as { path?: string } | null;
  const path = body?.path;
  if (!path || !PATH_RE.test(path)) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }

  const admin = createAdminClient();
  // 서버측 object 검증(클라 size/mime 불신)
  const { data: info, error: infoErr } = await admin.storage.from(EVENTS_BUCKET).info(path);
  if (infoErr || !info) {
    log.warn("event_image.upload_missing", { userId: gate.user.id, ...errInfo(infoErr) });
    return NextResponse.json({ error: "upload_missing" }, { status: 404 });
  }
  const size = info.size ?? 0;
  const mimetype = info.contentType ?? "";
  if (size <= 0 || size > MAX_BYTES || !mimetype.startsWith("image/") || mimetype.includes("svg")) {
    log.warn("event_image.upload_rejected", { userId: gate.user.id, size, mimetype });
    await admin.storage.from(EVENTS_BUCKET).remove([path]).catch(() => {});
    return NextResponse.json({ error: "rejected" }, { status: 400 });
  }

  const url = admin.storage.from(EVENTS_BUCKET).getPublicUrl(path).data.publicUrl;
  log.info("event_image.uploaded", { userId: gate.user.id, size });
  return NextResponse.json({ ok: true, path, url });
}
