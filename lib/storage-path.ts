// 순수 path 유틸 + 버킷 상수 — server/client 양쪽 import 가능(server-only 아님, createAdminClient 미사용).
// signed URL 발급(createAdminClient)은 lib/storage.ts(server-only)에.

export const DOLLS_BUCKET = "dolls";
export const HIGHLIGHTS_BUCKET = "highlights";
export const EVENTS_BUCKET = "events"; // 이벤트/공지 이미지(public — 서명 불요·CDN/OG 친화)
export const SITE_ASSETS_BUCKET = "site-assets"; // 기본 OG·서비스 로고(public — 변환 render URL 로 소비). 대시보드/Management API 로 수동 생성.

const UUID_SEGMENT =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const FINAL_DOLL_PATH = new RegExp(
  `^${UUID_SEGMENT}/${UUID_SEGMENT}\\.png$`,
);
const CANDIDATE_DOLL_PATH = new RegExp(
  `^${UUID_SEGMENT}/candidates/${UUID_SEGMENT}/[0-2]\\.jpg$`,
);
const LEGACY_DOLL_URL_MARKERS = [
  "/storage/v1/object/public/dolls/",
  "/storage/v1/object/sign/dolls/",
  "/storage/v1/render/image/public/dolls/",
  "/storage/v1/render/image/sign/dolls/",
] as const;

/**
 * dolls 버킷에서 서비스가 실제로 생성하는 두 object-key 문법만 허용한다.
 *
 * - 확정 캐릭터: `{owner UUID}/{doll UUID}.png`
 * - 생성 후보: `{owner UUID}/candidates/{generation UUID}/{0..2}.jpg`
 *
 * Supabase Storage object key는 URL처럼 정규화되지 않는다. 따라서 dot
 * segment, backslash, control byte, percent-encoded separator를 관용적으로
 * 받아들이면 DB 손상 시 서명 API가 예상 밖 object key의 signing oracle이
 * 될 수 있다. 정규식의 exact allowlist가 그 전체 클래스를 fail-closed 한다.
 */
export function isCanonicalDollObjectPath(value: string): boolean {
  return FINAL_DOLL_PATH.test(value) || CANDIDATE_DOLL_PATH.test(value);
}

/**
 * dolls 저장값(전체 공개 URL · signed URL · 이미 버킷상대경로 · null) → 버킷상대경로.
 * 레거시 Supabase public/sign URL만 object key를 추출하고, 현재 canonical
 * 버킷상대경로는 idempotent하게 돌려준다. 그 밖의 URL·비정규 object key는
 * 반드시 null이다.
 *
 * (private 전환 backfill 전엔 image_url 이 full URL, 후엔 path — 둘 다 안전 처리.)
 */
export function dollPath(v: string | null | undefined): string | null {
  if (!v) return null;
  let s = v.trim();
  if (!s) return null;

  if (s.includes("://") || s.startsWith("/storage/")) {
    let pathname: string;
    try {
      const parsed = new URL(s, "https://storage-path.invalid");
      if (
        parsed.origin !== "https://storage-path.invalid" &&
        (parsed.protocol !== "https:" ||
          !parsed.hostname.toLowerCase().endsWith(".supabase.co"))
      ) {
        return null;
      }
      pathname = parsed.pathname;
    } catch {
      return null;
    }

    const marker = LEGACY_DOLL_URL_MARKERS.find((candidate) =>
      pathname.includes(candidate),
    );
    if (!marker) return null;
    const markerIndex = pathname.lastIndexOf(marker);
    s = pathname.slice(markerIndex + marker.length);
  } else {
    const suffixIndex = s.search(/[?#]/);
    if (suffixIndex >= 0) s = s.slice(0, suffixIndex);
  }

  return isCanonicalDollObjectPath(s) ? s : null;
}
