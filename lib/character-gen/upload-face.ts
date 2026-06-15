import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";

const BUCKET = "dolls";
const TMP_PREFIX = "tmp/face";
const SIGNED_TTL_SEC = 600; // 10분 — fal 큐가 길어져도 안전

/** 임시 얼굴 storage 경로 — genId 로 결정적. 비동기 흐름에서 복구가 done 시 이 경로로 삭제. */
export function tmpFacePath(userId: string, genId: string): string {
  return `${TMP_PREFIX}/${userId}/${genId}.jpg`;
}

/**
 * 사용자 face 이미지를 Supabase tmp 폴더에 업로드 후 signed URL 반환.
 * fal.ai 가 이 URL 로 fetch 할 동안만 유효 (10분).
 * 경로는 genId 로 결정적 — 생성 done/failed 시 deleteFaceTmp 로 삭제 (정책: 원본 폐기).
 */
export async function uploadFaceTmp(
  userId: string,
  genId: string,
  buf: Buffer
): Promise<{ url: string; path: string }> {
  const admin = createAdminClient();
  const path = tmpFacePath(userId, genId);

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, buf, {
      contentType: "image/jpeg",
      upsert: true, // 결정적 경로 — 재시도 시 덮어쓰기
    });
  if (uploadError) throw uploadError;

  const { data, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_TTL_SEC);
  if (signError || !data) {
    // 업로드는 됐는데 signed URL 실패 — 원본 얼굴 정리 후 throw.
    // 정리 실패는 원본이 tmp 에 남는다는 정책 #1 리스크 → 무로깅 삼키지 말고 가시화(Sentry).
    await admin.storage
      .from(BUCKET)
      .remove([path])
      .catch((e) => log.warn("gen.face_cleanup_fail", { userId, genId, ...errInfo(e) }));
    throw signError ?? new Error("createSignedUrl returned no data");
  }

  return { url: data.signedUrl, path };
}

export async function deleteFaceTmp(path: string): Promise<void> {
  const admin = createAdminClient();
  await admin.storage.from(BUCKET).remove([path]);
}
