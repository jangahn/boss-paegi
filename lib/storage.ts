import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { DOLLS_BUCKET, HIGHLIGHTS_BUCKET, dollPath } from "@/lib/storage-path";
import {
  resolveStorageSigningResult,
  StorageSigningError,
} from "@/lib/storage-signing-result";

export { StorageSigningError } from "@/lib/storage-signing-result";

/**
 * private 버킷 읽기 — service-role signed URL. **server-only**(client 직접 import 금지, signed-URL API만).
 * TTL 짧게(takedown 후 기존 URL 잔존창 축소). ⚠️ 이미 발급된 signed URL은 TTL 동안 유효 —
 * deleted_at/플립은 "신규 발급 중단"만. (lib/storage-path 의 순수 유틸은 client 도 import 가능.)
 */

/**
 * 작은 표시용 썸네일 변환(on-the-fly). 브라우저는 Accept 로 webp 자동(~20KB, 원본 ~600KB의 1/30).
 * ⚠️ **width/height 둘 다 + resize:contain 필수** — width 만 주면 Supabase 가 height 를 안 줄여
 *   왜곡(768×1024 → 384×1024, 세로로 늘어남)됨. contain 으로 비례 보존(3:4 → 384×512, 다른 비율은 letterbox).
 *   왜곡 시 갤러리 object-cover 가 과하게 크롭돼 "확대"로 보였던 버그(원본 종횡비로 복원).
 */
export const DOLL_THUMB_PX = 384;
export const DOLL_THUMB_TRANSFORM = {
  width: 384,
  height: 512,
  resize: "contain",
} as const;

/**
 * doll 이미지 signed URL. v=저장값(URL or path). ttl 초(기본 600=10분, OG 내부는 60).
 * 원본 없음만 null이며, 유효한 원본의 서명 실패/손상 응답은 throw한다.
 * opts.thumb → 384px 변환 썸네일(갤러리·공유·어드민 등 작은 표시. 원본은 /play 게임 텍스처만).
 */
export function signedDollUrl(
  v: string,
  ttl?: number,
  opts?: { thumb?: boolean },
): Promise<string>;
export function signedDollUrl(
  v: null | undefined,
  ttl?: number,
  opts?: { thumb?: boolean },
): Promise<null>;
export function signedDollUrl(
  v: string | null | undefined,
  ttl?: number,
  opts?: { thumb?: boolean },
): Promise<string | null>;
export async function signedDollUrl(
  v: string | null | undefined,
  ttl = 600,
  opts?: { thumb?: boolean }
): Promise<string | null> {
  if (v === null || v === undefined) return null;
  const path = dollPath(v);
  if (!path) {
    throw new StorageSigningError(
      "storage.sign_doll",
      new Error("invalid_doll_path"),
    );
  }
  let result;
  try {
    result = await createAdminClient()
      .storage.from(DOLLS_BUCKET)
      .createSignedUrl(
        path,
        ttl,
        opts?.thumb ? { transform: DOLL_THUMB_TRANSFORM } : undefined,
      );
  } catch (error) {
    throw new StorageSigningError("storage.sign_doll", error);
  }
  return resolveStorageSigningResult("storage.sign_doll", path, result);
}

/** 하이라이트 clip signed URL. clipPath=highlight_clip_path(경로 저장). ttl 초(기본 900=15분). */
export function signedHighlightUrl(
  clipPath: string,
  ttl?: number,
): Promise<string>;
export function signedHighlightUrl(
  clipPath: null | undefined,
  ttl?: number,
): Promise<null>;
export function signedHighlightUrl(
  clipPath: string | null | undefined,
  ttl?: number,
): Promise<string | null>;
export async function signedHighlightUrl(
  clipPath: string | null | undefined,
  ttl = 900
): Promise<string | null> {
  if (clipPath === null || clipPath === undefined) return null;
  let result;
  try {
    result = await createAdminClient()
      .storage.from(HIGHLIGHTS_BUCKET)
      .createSignedUrl(clipPath, ttl);
  } catch (error) {
    throw new StorageSigningError("storage.sign_highlight", error);
  }
  return resolveStorageSigningResult(
    "storage.sign_highlight",
    clipPath,
    result,
  );
}
