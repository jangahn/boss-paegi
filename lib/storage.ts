import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOLLS_BUCKET, HIGHLIGHTS_BUCKET, dollPath } from "@/lib/storage-path";

/**
 * private 버킷 읽기 — service-role signed URL. **server-only**(client 직접 import 금지, signed-URL API만).
 * TTL 짧게(takedown 후 기존 URL 잔존창 축소). ⚠️ 이미 발급된 signed URL은 TTL 동안 유효 —
 * deleted_at/플립은 "신규 발급 중단"만. (lib/storage-path 의 순수 유틸은 client 도 import 가능.)
 */

/** doll 이미지 signed URL. v=저장값(URL or path). ttl 초(기본 600=10분, OG 내부는 60). 실패/없음=null. */
export async function signedDollUrl(
  v: string | null | undefined,
  ttl = 600
): Promise<string | null> {
  const path = dollPath(v);
  if (!path) return null;
  const { data, error } = await createAdminClient()
    .storage.from(DOLLS_BUCKET)
    .createSignedUrl(path, ttl);
  return error ? null : data?.signedUrl ?? null;
}

/** 하이라이트 clip signed URL. clipPath=highlight_clip_path(경로 저장). ttl 초(기본 900=15분). */
export async function signedHighlightUrl(
  clipPath: string | null | undefined,
  ttl = 900
): Promise<string | null> {
  if (!clipPath) return null;
  const { data, error } = await createAdminClient()
    .storage.from(HIGHLIGHTS_BUCKET)
    .createSignedUrl(clipPath, ttl);
  return error ? null : data?.signedUrl ?? null;
}
