/**
 * 캐릭터 프사 프리셋(v1.41) — `public/avatars/preset-{1..5}.png`(256px 알파 PNG, 투명 여백 제거 후 머리 90% 배치).
 *
 * 기본 프사는 1장 고정이 아니라 **유저별 고정**: 유저 id 의 FNV-1a 해시로 5장 중 하나를 배정한다(같은 유저 = 어디서나
 * 같은 캐릭터, 서버·클라이언트 동일 계산, DB 변경 없음). 커스텀 프사(`profiles.avatar_url`)가 있으면 그것이 우선.
 * "캐릭터로 고르기"(A 방식)는 프리셋 PNG 를 기존 업로드 경로로 그대로 올려 커스텀 프사로 저장한다(`lib/avatar.ts`).
 * 표시 크기는 헤더 24 · 랭킹 36 · 히스토리 44 · 계정 96px · 프사 변경 창 112px(전부 원형)라 256px 이면 2배 DPR 까지 선명.
 * 작은 칸(48px 이하)은 `avatarThumbSrc`, 큰 칸(96 · 112px)은 `avatarSrc`.
 */
export const AVATAR_PRESET_COUNT = 5;
export const AVATAR_PRESET_INDEXES: readonly number[] = Array.from({ length: AVATAR_PRESET_COUNT }, (_, i) => i + 1);

export function avatarPresetUrl(index: number): string {
  if (!Number.isInteger(index) || index < 1 || index > AVATAR_PRESET_COUNT) {
    throw new RangeError(`avatar preset out of range: ${index}`);
  }
  return `/avatars/preset-${index}.png`;
}

/** 유저별 기본 프리셋 번호(1..5). id 가 없으면(비회원 표시·로딩 전) 1번. */
export function defaultAvatarPreset(userId: string | null | undefined): number {
  if (!userId) return 1;
  let h = 0x811c9dc5;
  for (let i = 0; i < userId.length; i++) {
    h ^= userId.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return (h % AVATAR_PRESET_COUNT) + 1;
}

export function defaultAvatarUrl(userId: string | null | undefined): string {
  return avatarPresetUrl(defaultAvatarPreset(userId));
}

// 카카오 프로필 사진(v1.63) — 가입 때 카카오가 넘긴 주소(`profile_image_url`)를 그대로 저장한다. 카카오는 같은 주소에
// 110px 썸네일(`img_110x110.jpg`)을 함께 둔다(9/25 저장된 주소 전부 확인, 중간값 4.6KB — 원본 640px 중간값 59KB).
// 저장된 카카오 주소는 http 라 https 로 고친다(https 페이지에서 브라우저가 자동 승격하던 것). 카카오 기본 이미지(사진 미등록)는
// 사용자 결정대로 그대로 둔다 — 구글 기본 이미지를 가려낼 방법이 없어 카카오만 바꾸면 일관성이 깨진다.
const KAKAO_CDN_HTTP = /^http:\/\/((?:[a-z0-9-]+\.)*kakaocdn\.net)\//i;
const KAKAO_PROFILE_640 = /^(https:\/\/k\.kakaocdn\.net\/dn\/.+\/)img_640x640\.jpg$/;

/** 카카오 CDN 주소를 https 로. 그 밖의 주소는 그대로. */
export function httpsAvatarUrl(url: string): string {
  return url.replace(KAKAO_CDN_HTTP, "https://$1/");
}

/** 표시용 src — 커스텀 프사 우선, 없으면 유저별 기본 프리셋. 이미지 로드 실패 폴백도 같은 값을 쓴다. */
export function avatarSrc(avatarUrl: string | null | undefined, userId: string | null | undefined): string {
  return avatarUrl ? httpsAvatarUrl(avatarUrl) : defaultAvatarUrl(userId);
}

/**
 * 작은 칸(48px 이하 — 헤더 24 · 랭킹 36 · 히스토리 44)용 기본 프사 썸네일(v1.61, 144px WebP 약 5KB — 원본 256px PNG 21~26KB).
 * `scripts/gen-static-thumbs.mjs` 가 원본에서 만든다. 계정 화면(96px)과 "캐릭터로 고르기" 업로드 원본은 PNG 그대로.
 */
export function avatarPresetThumbUrl(index: number): string {
  avatarPresetUrl(index); // 범위 검사
  return `/avatars/thumb/preset-${index}.webp`;
}

export function defaultAvatarThumbUrl(userId: string | null | undefined): string {
  return avatarPresetThumbUrl(defaultAvatarPreset(userId));
}

/** 작은 칸 표시용 src — 커스텀 프사 우선(카카오 사진은 110px 썸네일), 없으면 기본 프사 썸네일. */
export function avatarThumbSrc(avatarUrl: string | null | undefined, userId: string | null | undefined): string {
  if (!avatarUrl) return defaultAvatarThumbUrl(userId);
  return httpsAvatarUrl(avatarUrl).replace(KAKAO_PROFILE_640, "$1img_110x110.jpg");
}
