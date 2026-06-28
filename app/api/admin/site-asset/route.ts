import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { SITE_ASSETS_BUCKET } from "@/lib/storage-path";
import { siteAssetUrl, OG_PREVIEW_TRANSFORM, LOGO_PREVIEW_TRANSFORM } from "@/lib/site-assets";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/** 미디어 자산(기본 OG·서비스 로고) — public site-assets 버킷. 어드민 전용. event-image 패턴 복제 + 슬롯 prefix. */
const MAX_BYTES = 5 * 1024 * 1024;

// 미디어 자산은 정지 이미지만 — SVG(XSS/추적)·GIF 금지. jpeg/png/webp 만.
function mimeToExt(mime?: string): "png" | "jpg" | "webp" | null {
  if (!mime) return null;
  if (mime.startsWith("image/png")) return "png";
  if (mime.startsWith("image/jpeg")) return "jpg";
  if (mime.startsWith("image/webp")) return "webp";
  return null;
}

type Slot = "og" | "logo";
function isSlot(v: unknown): v is Slot {
  return v === "og" || v === "logo";
}
// 슬롯별 prefix 강제 — og 슬롯엔 og/, logo 슬롯엔 logo/ 만.
const PATH_RE = /^(og|logo)\/\d{6}\/[0-9a-f-]{36}\.(png|jpg|webp)$/;

/** YYYYMM (KST). */
function kstYearMonth(): string {
  const d = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Seoul" }); // YYYY-MM-DD
  return d.slice(0, 4) + d.slice(5, 7);
}

/** POST — 슬롯별 서명 업로드 URL 발급(바이트는 Vercel 안 거침). 어드민 전용. */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as { mime?: string; slot?: string } | null;
  const ext = mimeToExt(body?.mime);
  if (!ext) return NextResponse.json({ error: "invalid_mime" }, { status: 400 });
  if (!isSlot(body?.slot)) return NextResponse.json({ error: "invalid_slot" }, { status: 400 });

  const admin = createAdminClient();
  const path = `${body.slot}/${kstYearMonth()}/${randomUUID()}.${ext}`;
  const { data: signed, error } = await admin.storage
    .from(SITE_ASSETS_BUCKET)
    .createSignedUploadUrl(path);
  if (error || !signed) {
    log.warn("site_asset.signed_url_fail", { userId: gate.user.id, ...errInfo(error) });
    return NextResponse.json({ error: "signed_url_failed" }, { status: 500 });
  }
  return NextResponse.json({ path, ext, token: signed.token });
}

/**
 * PATCH — 업로드 완료 검증(어드민 전용) → { path, previewUrl }.
 * path prefix↔slot·object size/mime 재확인. raw public URL 미반환(소비처 transform-only):
 * 응답은 path(저장용) + previewUrl(작은 transform, 미리보기용)만.
 */
export async function PATCH(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const body = (await req.json().catch(() => null)) as { path?: string; slot?: string } | null;
  const path = body?.path;
  const slot = body?.slot;
  if (!path || !PATH_RE.test(path) || !isSlot(slot) || !path.startsWith(`${slot}/`)) {
    return NextResponse.json({ error: "invalid_path" }, { status: 400 });
  }

  const admin = createAdminClient();
  // 서버측 object 검증(클라 size/mime 불신)
  const { data: info, error: infoErr } = await admin.storage.from(SITE_ASSETS_BUCKET).info(path);
  if (infoErr || !info) {
    log.warn("site_asset.upload_missing", { userId: gate.user.id, ...errInfo(infoErr) });
    return NextResponse.json({ error: "upload_missing" }, { status: 404 });
  }
  const size = info.size ?? 0;
  const mimetype = info.contentType ?? "";
  // jpeg/png/webp 만(mimeToExt=null → svg/gif/기타 거부) + 크기.
  if (size <= 0 || size > MAX_BYTES || !mimeToExt(mimetype)) {
    log.warn("site_asset.upload_rejected", { userId: gate.user.id, size, mimetype });
    await admin.storage.from(SITE_ASSETS_BUCKET).remove([path]).catch(() => {});
    return NextResponse.json({ error: "rejected" }, { status: 400 });
  }

  const previewUrl = siteAssetUrl(path, slot === "og" ? OG_PREVIEW_TRANSFORM : LOGO_PREVIEW_TRANSFORM);
  log.info("site_asset.uploaded", { userId: gate.user.id, slot, size });
  return NextResponse.json({ ok: true, path, previewUrl });
}
