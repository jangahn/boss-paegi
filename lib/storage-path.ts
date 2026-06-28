// 순수 path 유틸 + 버킷 상수 — server/client 양쪽 import 가능(server-only 아님, createAdminClient 미사용).
// signed URL 발급(createAdminClient)은 lib/storage.ts(server-only)에.

export const DOLLS_BUCKET = "dolls";
export const HIGHLIGHTS_BUCKET = "highlights";
export const EVENTS_BUCKET = "events"; // 이벤트/공지 이미지(public — 서명 불요·CDN/OG 친화)

/**
 * dolls 저장값(전체 공개 URL · signed URL · 이미 버킷상대경로 · null) → 버킷상대경로.
 * 관용·idempotent: 경로면 그대로, URL이면 '.../dolls/' 뒤를 추출, 쿼리스트링(?token=…) 제거.
 * (private 전환 backfill 전엔 image_url 이 full URL, 후엔 path — 둘 다 안전 처리.)
 */
export function dollPath(v: string | null | undefined): string | null {
  if (!v) return null;
  let s = v.trim();
  if (!s) return null;
  // public(`/object/public/dolls/`) · signed(`/object/sign/dolls/`) · 일반 URL 모두 마지막 '/dolls/' 뒤.
  if (s.includes("://") || s.includes("/dolls/")) {
    const i = s.lastIndexOf("/dolls/");
    if (i >= 0) s = s.slice(i + "/dolls/".length);
  }
  const q = s.indexOf("?"); // signed URL token 등 제거
  if (q >= 0) s = s.slice(0, q);
  return s || null;
}
