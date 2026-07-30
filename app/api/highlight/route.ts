import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveUser, memberGateResponse } from "@/lib/auth-server";
import { sanitizeHighlightMeta } from "@/lib/highlight";
import {
  attemptUploadCleanup,
  confirmUploadIntentWithLegacyAdoption,
  isFreshSignedUpload,
  isUuid,
  parseCreatedUploadIntent,
  resolveUploadIntentMutation,
  uploadIntentErrorMessage,
  videoContentTypeMatchesPath,
} from "@/lib/upload-write-safety";
import { log, errInfo } from "@/lib/log";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { publicWriteNetworkActorKey } from "@/lib/public-write-quota";

export const runtime = "nodejs";

const BUCKET = "highlights";
/** hard cap — 클라 목표 ~2MB, tolerance 포함 */
const MAX_BYTES = 4 * 1024 * 1024;
const TTL_MS = 30 * 24 * 3600_000;

async function cleanupHighlightUpload(
  admin: ReturnType<typeof createAdminClient>,
  scoreId: string,
  path: string,
  reason: string,
): Promise<boolean> {
  const cleanup = await attemptUploadCleanup(
    `highlight.${reason}`,
    [path],
    (paths) => admin.storage.from(BUCKET).remove(paths),
    (target) => admin.storage.from(BUCKET).exists(target),
  );
  if (!cleanup.ok) {
    log.error("highlight.upload_cleanup_fail", {
      scoreId,
      path,
      reason,
      ...errInfo(cleanup.error),
    });
  }
  return cleanup.ok;
}

function mimeToExt(mime?: string): "mp4" | "webm" | null {
  if (!mime) return null;
  if (mime.startsWith("video/mp4")) return "mp4";
  if (mime.startsWith("video/webm")) return "webm";
  return null;
}

function isPublishableReviewStatus(status: unknown): boolean {
  return status === "registered" || status === "cleared";
}

function lifecycleInsertError(error: { message?: string } | null): {
  error: "account_deleted" | "score_not_publishable";
  status: 403 | 409;
} | null {
  const message = error?.message ?? "";
  if (message.includes("account_deleted")) {
    return { error: "account_deleted", status: 403 };
  }
  if (message.includes("score_not_publishable")) {
    return { error: "score_not_publishable", status: 409 };
  }
  return null;
}

/** POST — 서명 업로드 URL 발급 (클립 바이트는 Vercel 안 거침). */
export async function POST(req: NextRequest) {
  // anonymous 플레이어도 허용하지만 deleted profile의 stale session은 쓰기 금지.
  const gate = await requireActiveUser();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const requestBody = await readApiJsonObjectRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as {
    scoreId?: string;
    mime?: string;
    requestId?: string;
  };
  const scoreId = body?.scoreId;
  const ext = mimeToExt(body?.mime);
  if (!isUuid(scoreId) || !ext || !isUuid(body.requestId)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const actorKey = publicWriteNetworkActorKey(req.headers);
  if (!actorKey) {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  const admin = createAdminClient();
  const { data: row, error: scoreError } = await admin
    .from("scores")
    .select("id, owner_id, review_status")
    .eq("id", scoreId)
    .maybeSingle();
  if (scoreError) {
    log.error("highlight.score_lookup_fail", {
      userId: user.id,
      scoreId,
      ...errInfo(scoreError),
    });
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!row || row.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isPublishableReviewStatus(row.review_status)) {
    return NextResponse.json(
      { error: "score_not_publishable" },
      { status: 409 },
    );
  }
  const { data: hl, error: highlightError } = await admin
    .from("score_highlights")
    .select("highlight_status")
    .eq("score_id", scoreId)
    .maybeSingle();
  if (highlightError) {
    log.error("highlight.existing_lookup_fail", {
      userId: user.id,
      scoreId,
      ...errInfo(highlightError),
    });
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (hl) {
    return NextResponse.json({ error: "already_set" }, { status: 409 });
  }

  const uploadId = body.requestId;
  const path = `${scoreId}/${uploadId}.${ext}`;
  const intent = await resolveUploadIntentMutation(() =>
    admin.rpc("create_highlight_upload_intent", {
      p_user_id: user.id,
      p_score_id: scoreId,
      p_path: path,
      p_request_id: body.requestId,
      p_actor_key: actorKey,
    }),
  );
  if (!intent.ok) {
    const message = uploadIntentErrorMessage(intent.error);
    const quota = message.includes("quota");
    const code = quota
      ? "upload_quota_exceeded"
      : message.includes("already_set")
      ? "already_set"
      : message.includes("score_not_publishable")
        ? "score_not_publishable"
        : "upload_intent_failed";
    log.warn("highlight.intent_create_fail", {
      userId: user.id,
      scoreId,
      code,
      ...errInfo(intent.error),
    });
    return NextResponse.json(
      { error: code },
      {
        status:
          code === "upload_quota_exceeded"
            ? 429
            : code === "upload_intent_failed"
              ? 503
              : 409,
      },
    );
  }
  if (!parseCreatedUploadIntent(intent.data, { expires: true })) {
    log.error("highlight.intent_create_invalid", {
      userId: user.id,
      scoreId,
      path,
    });
    return NextResponse.json(
      { error: "upload_intent_failed" },
      { status: 500 },
    );
  }
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
  const gate = await requireActiveUser();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const requestBody = await readApiJsonObjectRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as {
    scoreId?: string;
    mode?: string;
    uploadId?: string;
    ext?: string;
    delta?: number;
    windowMs?: number;
  };
  const scoreId = body?.scoreId;
  const mode = body?.mode === "card" ? "card" : "clip";
  if (!isUuid(scoreId)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  const admin = createAdminClient();
  const { data: row, error: scoreError } = await admin
    .from("scores")
    .select("id, owner_id, score, review_status")
    .eq("id", scoreId)
    .maybeSingle();
  if (scoreError) {
    log.error("highlight.score_lookup_fail", {
      userId: user.id,
      scoreId,
      ...errInfo(scoreError),
    });
    return NextResponse.json({ error: "lookup_failed" }, { status: 500 });
  }
  if (!row || row.owner_id !== user.id) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (!isPublishableReviewStatus(row.review_status)) {
    if (
      mode === "clip" &&
      isUuid(body?.uploadId) &&
      (body?.ext === "mp4" || body?.ext === "webm")
    ) {
      const path = `${scoreId}/${body.uploadId}.${body.ext}`;
      const cleaned = await cleanupHighlightUpload(
        admin,
        scoreId,
        path,
        "unpublishable_score_cleanup",
      );
      if (!cleaned) {
        return NextResponse.json(
          { error: "upload_cleanup_failed" },
          { status: 500 },
        );
      }
    }
    return NextResponse.json(
      { error: "score_not_publishable" },
      { status: 409 },
    );
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
      if (insErr.code === "23505") {
        const { data: existing, error: existingError } = await admin
          .from("score_highlights")
          .select(
            "highlight_status, highlight_delta, highlight_window_ms",
          )
          .eq("score_id", scoreId)
          .maybeSingle();
        if (
          !existingError &&
          existing?.highlight_status === "card" &&
          existing.highlight_delta === meta.delta &&
          existing.highlight_window_ms === meta.windowMs
        ) {
          revalidatePath(`/share/${scoreId}`);
          return NextResponse.json({
            ok: true,
            alreadyAttached: true,
          });
        }
        if (existingError) {
          log.error("highlight.card_receipt_lookup_fail", {
            scoreId,
            ...errInfo(existingError),
          });
          return NextResponse.json(
            { error: "card_failed" },
            { status: 500 },
          );
        }
        return NextResponse.json({ error: "already_set" }, { status: 409 });
      }
      const lifecycle = lifecycleInsertError(insErr);
      if (lifecycle) {
        return NextResponse.json(
          { error: lifecycle.error },
          { status: lifecycle.status },
        );
      }
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
  if (!isUuid(uploadId) || !ext) {
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
  const fresh = isFreshSignedUpload(info.createdAt);
  const mimeOk = videoContentTypeMatchesPath(
    path,
    mimetype,
    ["mp4", "webm"],
  );
  if (size <= 0 || size > MAX_BYTES || !mimeOk || !fresh) {
    log.warn("highlight.upload_rejected", {
      scoreId,
      size,
      mimetype,
      fresh,
    });
    const cleaned = await cleanupHighlightUpload(
      admin,
      scoreId,
      path,
      "rejected_cleanup",
    );
    if (!cleaned) {
      return NextResponse.json(
        { error: "upload_cleanup_failed" },
        { status: 500 },
      );
    }
    return NextResponse.json({ error: "rejected" }, { status: 400 });
  }

  const confirmation = await confirmUploadIntentWithLegacyAdoption({
    confirm: () =>
      admin.rpc("confirm_highlight_upload_intent", {
        p_user_id: user.id,
        p_score_id: scoreId,
        p_path: path,
      }),
    create: () =>
      admin.rpc("create_highlight_upload_intent", {
        p_user_id: user.id,
        p_score_id: scoreId,
        p_path: path,
      }),
  });
  if (!confirmation.ok) {
    const message = uploadIntentErrorMessage(confirmation.error);
    const lifecycle = lifecycleInsertError({
      message,
    });
    log.warn("highlight.intent_confirm_fail", {
      userId: user.id,
      scoreId,
      path,
      phase: confirmation.phase,
      ...errInfo(confirmation.error),
    });
    if (lifecycle) {
      return NextResponse.json(
        { error: lifecycle.error },
        { status: lifecycle.status },
      );
    }
    return NextResponse.json(
      { error: "upload_intent_failed" },
      { status: message.startsWith("invalid_upload_intent_") ? 500 : 409 },
    );
  }
  const confirmationOutcome = confirmation.outcome;
  if (confirmation.adoptedLegacy) {
    log.info("highlight.legacy_intent_adopted", {
      userId: user.id,
      scoreId,
      path,
    });
  }
  if (confirmationOutcome === "already_attached") {
    const { data: attached, error: attachedError } = await admin
      .from("score_highlights")
      .select("highlight_clip_path, highlight_status")
      .eq("score_id", scoreId)
      .maybeSingle();
    if (
      attachedError ||
      !attached ||
      attached.highlight_clip_path !== path ||
      attached.highlight_status !== "attached"
    ) {
      log.error("highlight.intent_attached_state_mismatch", {
        userId: user.id,
        scoreId,
        path,
        ...errInfo(attachedError),
      });
      return NextResponse.json(
        { error: "upload_intent_state_mismatch" },
        { status: 500 },
      );
    }
    revalidatePath(`/share/${scoreId}`);
    log.info("highlight.upload_already_attached", {
      scoreId,
      size,
      delta: meta.delta,
    });
    return NextResponse.json({ ok: true, alreadyAttached: true });
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
      const cleaned = await cleanupHighlightUpload(
        admin,
        scoreId,
        path,
        "duplicate_cleanup",
      );
      if (!cleaned) {
        return NextResponse.json(
          { error: "upload_cleanup_failed" },
          { status: 500 },
        );
      }
      return NextResponse.json({ error: "already_set" }, { status: 409 });
    }
    const lifecycle = lifecycleInsertError(insErr);
    const cleaned = await cleanupHighlightUpload(
      admin,
      scoreId,
      path,
      lifecycle ? "lifecycle_reject_cleanup" : "attach_failure_cleanup",
    );
    log.error("highlight.attach_fail", {
      scoreId,
      uploadCleaned: cleaned,
      ...errInfo(insErr),
    });
    if (!cleaned) {
      return NextResponse.json(
        { error: "upload_cleanup_failed" },
        { status: 500 },
      );
    }
    if (lifecycle) {
      return NextResponse.json(
        { error: lifecycle.error },
        { status: lifecycle.status },
      );
    }
    return NextResponse.json({ error: "attach_failed" }, { status: 500 });
  }

  revalidatePath(`/share/${scoreId}`);
  log.info("highlight.upload_success", { scoreId, size, delta: meta.delta });
  return NextResponse.json({ ok: true });
}
