import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

const BUCKET = "dolls";
const TMP_PREFIX = "tmp/face";
const SIGNED_TTL_SEC = 600; // 10분 — fal 큐가 길어져도 안전

/**
 * 사용자 face 이미지를 Supabase tmp 폴더에 업로드 후 signed URL 반환.
 * fal.ai 가 이 URL 로 fetch 할 동안만 유효 (10분).
 * 응답은 path 도 함께 — 사용 후 deleteFaceTmp 로 즉시 삭제 (정책: 원본 폐기).
 */
export async function uploadFaceTmp(
  userId: string,
  buf: Buffer
): Promise<{ url: string; path: string }> {
  const admin = createAdminClient();
  const uuid = crypto.randomUUID();
  const path = `${TMP_PREFIX}/${userId}/${uuid}.jpg`;

  const { error: uploadError } = await admin.storage
    .from(BUCKET)
    .upload(path, buf, {
      contentType: "image/jpeg",
      upsert: false,
    });
  if (uploadError) throw uploadError;

  const { data, error: signError } = await admin.storage
    .from(BUCKET)
    .createSignedUrl(path, SIGNED_TTL_SEC);
  if (signError || !data) {
    // 업로드는 됐는데 signed URL 실패 — 정리 후 throw
    await admin.storage.from(BUCKET).remove([path]).catch(() => {});
    throw signError ?? new Error("createSignedUrl returned no data");
  }

  return { url: data.signedUrl, path };
}

export async function deleteFaceTmp(path: string): Promise<void> {
  const admin = createAdminClient();
  await admin.storage.from(BUCKET).remove([path]);
}
