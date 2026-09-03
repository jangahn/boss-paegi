import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import {
  removeStorageObjects,
  SupabaseOperationError,
} from "@/lib/supabase-operation";

const BUCKET = "dolls";
const TMP_PREFIX = "tmp/face";
export const FACE_INPUT_SIGNED_TTL_SECONDS = 10 * 60;

/** 임시 얼굴 storage 경로 — genId 로 결정적. 비동기 흐름에서 복구가 done 시 이 경로로 삭제. */
export function tmpFacePath(userId: string, genId: string): string {
  return `${TMP_PREFIX}/${userId}/${genId}.jpg`;
}

/**
 * 사용자 face 이미지를 Supabase tmp 폴더에 업로드 후 signed URL 반환.
 * fal.ai 가 이 URL 로 fetch 할 동안만 유효 (정확히 10분).
 * 경로는 genId 로 결정적 — 생성 done/failed 시 deleteFaceTmp 로 삭제 (정책: 원본 폐기).
 */
export async function uploadFaceTmp(
  userId: string,
  genId: string,
  buf: Buffer
): Promise<{ url: string; path: string }> {
  const admin = createAdminClient();
  const path = tmpFacePath(userId, genId);

  // Next's multipart file bytes can arrive backed by a SharedArrayBuffer in
  // the deployed runtime, which fetch bodies reject ("SharedArrayBuffer is
  // not allowed"). Copy into a fresh plain ArrayBuffer before uploading.
  const bytes = new Uint8Array(buf.byteLength);
  bytes.set(buf);

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, bytes, {
      contentType: "image/jpeg",
      upsert: true, // 결정적 경로 — 재시도 시 덮어쓰기
    });
  if (uploadError) throw uploadError;

  const { data, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, FACE_INPUT_SIGNED_TTL_SECONDS);
  if (signError || !data) {
    // 업로드는 됐는데 signed URL 실패 — 원본 얼굴 정리 후 throw.
    // 정리 실패는 원본이 tmp 에 남는다는 정책 #1 리스크 → 무로깅 삼키지 말고 가시화(Sentry).
    try {
      await removeStorageObjects(
        "gen.face_cleanup_after_sign_fail",
        [path],
        (paths) => admin.storage.from(BUCKET).remove(paths),
        (target) => admin.storage.from(BUCKET).exists(target),
      );
    } catch (error) {
      const cause =
        error instanceof SupabaseOperationError
          ? error.operationError
          : error;
      log.warn("gen.face_cleanup_fail", {
        userId,
        genId,
        operation:
          error instanceof SupabaseOperationError
            ? error.operation
            : "gen.face_cleanup_after_sign_fail",
        ...errInfo(cause),
      });
    }
    throw signError ?? new Error("createSignedUrl returned no data");
  }

  return { url: data.signedUrl, path };
}

/** 서버 주도 continuation 이 이어갈 원본이 이미 없을 때(고아 sweep·정리 뒤). */
export class FaceSourceMissingError extends Error {
  constructor(public readonly path: string) {
    super("face_source_missing");
    this.name = "FaceSourceMissingError";
  }
}

/**
 * 보존된 얼굴(tmp/face/{userId}/{fromId})을 생성용 경로(tmp/face/{userId}/{toId})로 복사하고
 * signed URL 을 돌려준다 — 서버 주도 continuation(웹훅·스윕)이 클라이언트 바이트 없이
 * 3장 제출을 이어가는 유일한 입력. 원본(fromId)은 호출자가 이어서 지운다(정책 #1).
 */
export async function copyFaceTmp(
  userId: string,
  fromId: string,
  toId: string,
): Promise<{ url: string; path: string }> {
  const admin = createAdminClient();
  const from = tmpFacePath(userId, fromId);
  const to = tmpFacePath(userId, toId);
  const { error: copyError } = await admin.storage.from(BUCKET).copy(from, to);
  if (copyError) {
    const status = (copyError as { statusCode?: unknown; status?: unknown })
      .statusCode ?? (copyError as { status?: unknown }).status;
    if (
      String(status) === "404" ||
      /not found|does not exist/i.test(copyError.message ?? "")
    ) {
      // 대상이 이미 있는 재시도(복사 충돌)면 그대로 서명, 원본 부재면 fail-visible.
      const { data: existing } = await admin.storage.from(BUCKET).exists(to);
      if (!existing) throw new FaceSourceMissingError(from);
    } else {
      throw copyError;
    }
  }
  const { data, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(to, FACE_INPUT_SIGNED_TTL_SECONDS);
  if (signError || !data) {
    throw signError ?? new Error("createSignedUrl returned no data");
  }
  return { url: data.signedUrl, path: to };
}

export async function deleteFaceTmp(path: string): Promise<void> {
  const admin = createAdminClient();
  await removeStorageObjects(
    "gen.face_cleanup",
    [path],
    (paths) => admin.storage.from(BUCKET).remove(paths),
    (target) => admin.storage.from(BUCKET).exists(target),
  );
}
