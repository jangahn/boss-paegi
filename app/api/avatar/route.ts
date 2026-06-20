import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "node:crypto";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

const BUCKET = "avatars";
/** hard cap — 클라가 ~512px 로 다운스케일, tolerance 포함 */
const MAX_BYTES = 3 * 1024 * 1024;

function mimeToExt(mime?: string): "png" | "jpg" | "webp" | null {
  if (!mime) return null;
  if (mime.startsWith("image/png")) return "png";
  if (mime.startsWith("image/jpeg")) return "jpg";
  if (mime.startsWith("image/webp")) return "webp";
  return null;
}

/** POST — 서명 업로드 URL 발급 (바이트는 Vercel 안 거침). 회원 전용. */
export async function POST(req: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const body = (await req.json().catch(() => null)) as { mime?: string } | null;
  const ext = mimeToExt(body?.mime);
  if (!ext) return NextResponse.json({ error: "invalid_mime" }, { status: 400 });

  const admin = createAdminClient();
  const path = `${user.id}/${randomUUID()}.${ext}`;
  const { data: signed, error } = await admin.storage
    .from(BUCKET)
    .createSignedUploadUrl(path);
  if (error || !signed) {
    log.warn("avatar.signed_url_fail", { userId: user.id, ...errInfo(error) });
    return NextResponse.json({ error: "signed_url_failed" }, { status: 500 });
  }
  return NextResponse.json({ path, ext, token: signed.token });
}

/** PATCH — 업로드 완료 후 object 검증 + profiles.avatar_url 반영(admin). 회원 전용. */
export async function PATCH(req: NextRequest) {
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const body = (await req.json().catch(() => null)) as { path?: string } | null;
  const path = body?.path;
  // path 는 반드시 본인 폴더 — admin 이 RLS 우회하므로 이 라우트가 보안경계.
  if (!path || !path.startsWith(`${user.id}/`)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const admin = createAdminClient();

  // 서버측 object 검증 (클라 size/mime 불신)
  const { data: info, error: infoErr } = await admin.storage.from(BUCKET).info(path);
  if (infoErr || !info) {
    log.warn("avatar.upload_missing", { userId: user.id, ...errInfo(infoErr) });
    return NextResponse.json({ error: "upload_missing" }, { status: 404 });
  }
  const size = info.size ?? 0;
  const mimetype = info.contentType ?? "";
  if (size <= 0 || size > MAX_BYTES || !mimetype.startsWith("image/")) {
    log.warn("avatar.upload_rejected", { userId: user.id, size, mimetype });
    await admin.storage.from(BUCKET).remove([path]).catch(() => {});
    return NextResponse.json({ error: "rejected" }, { status: 400 });
  }

  const publicUrl = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;

  // 이전 avatar 가 avatars 버킷의 본인 객체였으면 best-effort 삭제(외부 핫링크면 스킵).
  const { data: prof } = await admin
    .from("profiles")
    .select("avatar_url")
    .eq("id", user.id)
    .single();
  const prevUrl = (prof?.avatar_url as string | null) ?? null;

  const { error: upErr } = await admin
    .from("profiles")
    .update({ avatar_url: publicUrl })
    .eq("id", user.id);
  if (upErr) {
    log.error("avatar.update_fail", { userId: user.id, ...errInfo(upErr) });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  if (prevUrl && prevUrl !== publicUrl) {
    const prevPath = prevUrl.split(`/${BUCKET}/`)[1];
    if (prevPath && prevPath.startsWith(`${user.id}/`)) {
      await admin.storage.from(BUCKET).remove([prevPath]).catch(() => {});
    }
  }

  log.info("avatar.updated", { userId: user.id, size });
  return NextResponse.json({ ok: true, avatarUrl: publicUrl });
}
