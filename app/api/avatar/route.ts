import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireMember, memberGateResponse } from "@/lib/auth-server";
import {
  attemptUploadCleanup,
  confirmUploadIntentWithLegacyAdoption,
  imageContentTypeMatchesPath,
  isFreshSignedUpload,
  isUuid,
  isOwnedAvatarUploadPath,
  parseCreatedUploadIntent,
  resolveUploadIntentMutation,
  uploadIntentErrorMessage,
} from "@/lib/upload-write-safety";
import { processStorageObjectCleanupJob } from "@/lib/storage-cleanup-jobs";
import { log, errInfo } from "@/lib/log";
import {
  cleanupJobToRun,
  parseDetachedStorageMutationAck,
} from "@/lib/storage-mutation-result";
import { readApiJsonObjectRequest } from "@/lib/http/api-json-request";
import { publicWriteActorKey } from "@/lib/public-write-quota";

export const runtime = "nodejs";

const BUCKET = "avatars";
/** hard cap — 클라가 ≤512px JPEG(~40~80KB)로 정규화. 여유 포함 512KB(과거 PNG 폴백 bloat 방지). */
const MAX_BYTES = 512 * 1024;

async function cleanupAvatarUpload(
  admin: ReturnType<typeof createAdminClient>,
  userId: string,
  path: string,
  reason: string,
): Promise<boolean> {
  const cleanup = await attemptUploadCleanup(
    `avatar.${reason}`,
    [path],
    (paths) => admin.storage.from(BUCKET).remove(paths),
    (target) => admin.storage.from(BUCKET).exists(target),
  );
  if (!cleanup.ok) {
    log.error("avatar.upload_cleanup_fail", {
      userId,
      path,
      reason,
      ...errInfo(cleanup.error),
    });
  }
  return cleanup.ok;
}

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

  const requestBody = await readApiJsonObjectRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as { mime?: string; requestId?: string };
  const ext = mimeToExt(body?.mime);
  if (!ext || !isUuid(body.requestId)) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }
  const actorKey = publicWriteActorKey(req.headers, user.id, true);
  if (!actorKey) {
    return NextResponse.json({ error: "service_unavailable" }, { status: 503 });
  }

  const admin = createAdminClient();
  const path = `${user.id}/${body.requestId}.${ext}`;
  const intent = await resolveUploadIntentMutation(() =>
    admin.rpc("create_avatar_upload_intent", {
      p_user_id: user.id,
      p_path: path,
      p_request_id: body.requestId,
      p_actor_key: actorKey,
    }),
  );
  if (!intent.ok) {
    const message = uploadIntentErrorMessage(intent.error);
    const quota = message.includes("quota");
    const conflict =
      message.includes("conflict") ||
      message.includes("token_issue_limit") ||
      message.includes("already_attached");
    log.error("avatar.intent_create_fail", {
      userId: user.id,
      path,
      ...errInfo(intent.error),
    });
    return NextResponse.json(
      {
        error: quota
          ? "upload_quota_exceeded"
          : conflict
            ? "upload_request_conflict"
            : "upload_intent_failed",
      },
      { status: quota ? 429 : conflict ? 409 : 503 },
    );
  }
  if (!parseCreatedUploadIntent(intent.data, { expires: true })) {
    log.error("avatar.intent_create_invalid", { userId: user.id, path });
    return NextResponse.json(
      { error: "upload_intent_failed" },
      { status: 500 },
    );
  }
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

  const requestBody = await readApiJsonObjectRequest(req);
  if (!requestBody.ok) {
    return NextResponse.json(
      { error: requestBody.error },
      { status: requestBody.status },
    );
  }
  const body = requestBody.value as { path?: string };
  const path = body?.path;
  // admin이 RLS를 우회하므로 prefix만 보지 않고 canonical UUID 파일명까지 강제한다.
  if (!isOwnedAvatarUploadPath(path, user.id)) {
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
  const fresh = isFreshSignedUpload(info.createdAt);
  if (
    size <= 0 ||
    size > MAX_BYTES ||
    !imageContentTypeMatchesPath(path, mimetype, ["png", "jpg", "webp"]) ||
    !fresh
  ) {
    log.warn("avatar.upload_rejected", {
      userId: user.id,
      size,
      mimetype,
      fresh,
    });
    const cleaned = await cleanupAvatarUpload(
      admin,
      user.id,
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

  const publicUrl = admin.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
  const confirmation = await confirmUploadIntentWithLegacyAdoption({
    confirm: () =>
      admin.rpc("confirm_avatar_upload_intent", {
        p_user_id: user.id,
        p_path: path,
      }),
    create: () =>
      admin.rpc("create_avatar_upload_intent", {
        p_user_id: user.id,
        p_path: path,
      }),
  });
  if (!confirmation.ok) {
    const message = uploadIntentErrorMessage(confirmation.error);
    const deleted = message.includes("account_deleted");
    const invalidAck = message.startsWith("invalid_upload_intent_");
    log.warn("avatar.intent_confirm_fail", {
      userId: user.id,
      path,
      phase: confirmation.phase,
      ...errInfo(confirmation.error),
    });
    return NextResponse.json(
      { error: deleted ? "account_deleted" : "upload_intent_failed" },
      { status: deleted ? 403 : invalidAck ? 500 : 409 },
    );
  }
  if (confirmation.adoptedLegacy) {
    log.info("avatar.legacy_intent_adopted", { userId: user.id, path });
  }

  const { data: replaceData, error: replaceError } = await admin.rpc(
    "request_avatar_replace",
    {
      p_user_id: user.id,
      p_path: path,
      p_public_url: publicUrl,
    },
  );
  if (replaceError) {
    const deleted = replaceError.message?.includes("account_deleted") ?? false;
    log.error("avatar.replace_fail", {
      userId: user.id,
      path,
      ...errInfo(replaceError),
    });
    return NextResponse.json(
      { error: deleted ? "account_deleted" : "update_failed" },
      { status: deleted ? 403 : 500 },
    );
  }

  const replace = parseDetachedStorageMutationAck(replaceData);
  if (!replace) {
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, avatar_url, deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (
    profileError ||
    !profile ||
    profile.id !== user.id ||
    profile.avatar_url !== publicUrl ||
    profile.deleted_at !== null
  ) {
    log.error("avatar.replace_postcondition_fail", {
      userId: user.id,
      path,
      ...errInfo(
        profileError ?? new Error("avatar_replace_postcondition_failed"),
      ),
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  const cleanupJobId = cleanupJobToRun(replace);
  if (cleanupJobId) {
    try {
      const outcome = await processStorageObjectCleanupJob(
        admin,
        cleanupJobId,
      );
      if (outcome.kind !== "completed") {
        return NextResponse.json(
          { accepted: true, avatarUrl: publicUrl, cleanup: "pending" },
          { status: 202 },
        );
      }
    } catch (cleanupError) {
      log.warn("avatar.replace_cleanup_claim_fail", {
        userId: user.id,
        jobId: cleanupJobId,
        ...errInfo(cleanupError),
      });
      return NextResponse.json(
        { accepted: true, avatarUrl: publicUrl, cleanup: "pending" },
        { status: 202 },
      );
    }
  }

  log.info("avatar.updated", { userId: user.id, size });
  return NextResponse.json({ ok: true, avatarUrl: publicUrl });
}

/** DELETE — DB를 먼저 비우고 Storage cleanup outbox를 같은 트랜잭션에 남긴다. */
export async function DELETE() {
  const gate = await requireMember();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("request_avatar_clear", {
    p_user_id: user.id,
  });
  if (error) {
    const code = (error.message ?? "").includes("account_deleted")
      ? "account_deleted"
      : "update_failed";
    log.error("avatar.delete_request_fail", {
      userId: user.id,
      ...errInfo(error),
    });
    return NextResponse.json(
      { error: code },
      { status: code === "account_deleted" ? 403 : 500 },
    );
  }

  const started = parseDetachedStorageMutationAck(data);
  if (!started) {
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("id, avatar_url, deleted_at")
    .eq("id", user.id)
    .maybeSingle();
  if (
    profileError ||
    !profile ||
    profile.id !== user.id ||
    profile.avatar_url !== null ||
    profile.deleted_at !== null
  ) {
    log.error("avatar.delete_postcondition_fail", {
      userId: user.id,
      ...errInfo(
        profileError ?? new Error("avatar_clear_postcondition_failed"),
      ),
    });
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }
  const cleanupJobId = cleanupJobToRun(started);
  if (cleanupJobId) {
    try {
      const outcome = await processStorageObjectCleanupJob(
        admin,
        cleanupJobId,
      );
      if (outcome.kind !== "completed") {
        return NextResponse.json(
          { accepted: true, cleanup: "pending" },
          { status: 202 },
        );
      }
    } catch (cleanupError) {
      log.warn("avatar.delete_cleanup_claim_fail", {
        userId: user.id,
        jobId: cleanupJobId,
        ...errInfo(cleanupError),
      });
      return NextResponse.json(
        { accepted: true, cleanup: "pending" },
        { status: 202 },
      );
    }
  }

  log.info("avatar.deleted", { userId: user.id });
  return NextResponse.json({ ok: true, cleanup: "completed" });
}
