import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireAdmin, memberGateResponse } from "@/lib/auth-server";
import { readAdminJsonRequest } from "@/lib/http/admin-json-request";
import { EVENTS_BUCKET } from "@/lib/storage-path";
import {
  attemptUploadCleanup,
  confirmUploadIntentWithLegacyAdoption,
  imageContentTypeMatchesPath,
  isFreshSignedUpload,
  parseCreatedUploadIntent,
  resolveUploadIntentMutation,
  uploadIntentErrorMessage,
  isUuid,
} from "@/lib/upload-write-safety";
import { log, errInfo } from "@/lib/log";
import { publicWriteActorKey } from "@/lib/public-write-quota";

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

/** POST — 서명 업로드 URL 발급(바이트는 Vercel 안 거침). 어드민 전용. */
export async function POST(req: NextRequest) {
  const gate = await requireAdmin();
  if (!gate.ok) return memberGateResponse(gate);

  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as {
    mime?: string;
    requestId?: string;
    month?: string;
  } | null;
  const ext = mimeToExt(body?.mime);
  if (
    !ext ||
    !isUuid(body?.requestId) ||
    !body?.month ||
    !/^\d{6}$/.test(body.month)
  ) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const actorKey = publicWriteActorKey(
    req.headers,
    gate.user.id,
    true,
  );
  if (!actorKey) {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  const admin = createAdminClient();
  const path = `${body.month}/${body.requestId}.${ext}`;
  const intent = await resolveUploadIntentMutation(() =>
    admin.rpc("create_admin_storage_upload_intent", {
      p_admin_id: gate.user.id,
      p_purpose: "event_image",
      p_bucket: EVENTS_BUCKET,
      p_path: path,
      p_request_id: body.requestId,
      p_actor_key: actorKey,
    }),
  );
  if (!intent.ok) {
    log.error("event_image.intent_create_fail", {
      userId: gate.user.id,
      path,
      ...errInfo(intent.error),
    });
    const message = uploadIntentErrorMessage(intent.error);
    return NextResponse.json(
      {
        error: message.includes("quota")
          ? "upload_quota_exceeded"
          : "upload_intent_failed",
      },
      { status: message.includes("quota") ? 429 : 503 },
    );
  }
  if (!parseCreatedUploadIntent(intent.data, { expires: true })) {
    log.error("event_image.intent_create_invalid", {
      userId: gate.user.id,
      path,
    });
    return NextResponse.json({ error: "upload_intent_failed" }, { status: 500 });
  }
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

  const requestBody = await readAdminJsonRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as { path?: string } | null;
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
  const fresh = isFreshSignedUpload(info.createdAt);
  if (
    size <= 0 ||
    size > MAX_BYTES ||
    !imageContentTypeMatchesPath(path, mimetype, [
      "png",
      "jpg",
      "webp",
      "gif",
    ]) ||
    !fresh
  ) {
    log.warn("event_image.upload_rejected", {
      userId: gate.user.id,
      size,
      mimetype,
      fresh,
    });
    const cleanup = await attemptUploadCleanup(
      "event_image.rejected_cleanup",
      [path],
      (paths) => admin.storage.from(EVENTS_BUCKET).remove(paths),
      (target) => admin.storage.from(EVENTS_BUCKET).exists(target),
    );
    if (!cleanup.ok) {
      log.error("event_image.upload_cleanup_fail", {
        userId: gate.user.id,
        path,
        ...errInfo(cleanup.error),
      });
      return NextResponse.json(
        { error: "upload_cleanup_failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: "rejected" }, { status: 400 });
  }

  const confirmation = await confirmUploadIntentWithLegacyAdoption({
    confirm: () =>
      admin.rpc("confirm_admin_storage_upload_intent", {
        p_admin_id: gate.user.id,
        p_bucket: EVENTS_BUCKET,
        p_path: path,
      }),
    create: () =>
      admin.rpc("create_admin_storage_upload_intent", {
        p_admin_id: gate.user.id,
        p_purpose: "event_image",
        p_bucket: EVENTS_BUCKET,
        p_path: path,
      }),
  });
  if (!confirmation.ok) {
    const message = uploadIntentErrorMessage(confirmation.error);
    const code = message.includes("upload_intent_expired")
      ? "upload_intent_expired"
      : message.includes("upload_intent_forbidden")
        ? "upload_intent_forbidden"
        : message.includes("upload_cleanup_in_progress")
          ? "upload_cleanup_in_progress"
          : "upload_intent_failed";
    log.warn("event_image.intent_confirm_fail", {
      userId: gate.user.id,
      path,
      code,
      phase: confirmation.phase,
      ...errInfo(confirmation.error),
    });
    return NextResponse.json(
      { error: code },
      {
        status:
          code === "upload_intent_forbidden"
            ? 403
            : code === "upload_intent_failed"
              ? 500
              : 409,
      },
    );
  }
  if (confirmation.adoptedLegacy) {
    log.info("event_image.legacy_intent_adopted", {
      userId: gate.user.id,
      path,
    });
  }

  const url = admin.storage.from(EVENTS_BUCKET).getPublicUrl(path).data.publicUrl;
  log.info("event_image.uploaded", { userId: gate.user.id, size });
  return NextResponse.json({ ok: true, path, url });
}
