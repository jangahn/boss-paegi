/**
 * 캐릭터 프사 프리셋(v1.41) — `public/avatars/preset-{1..5}.png`(256px 알파 PNG, 투명 여백 제거 후 머리 90% 배치).
 *
 * 기본 프사는 1장 고정이 아니라 **유저별 고정**: 유저 id 의 FNV-1a 해시로 5장 중 하나를 배정한다(같은 유저 = 어디서나
 * 같은 캐릭터, 서버·클라이언트 동일 계산, DB 변경 없음). 커스텀 프사(`profiles.avatar_url`)가 있으면 그것이 우선.
 * "캐릭터로 고르기"(A 방식)는 프리셋 PNG 를 기존 업로드 경로로 그대로 올려 커스텀 프사로 저장한다(`lib/avatar.ts`).
 * 표시 크기는 헤더 24 · 랭킹 36 · 히스토리 44 · 계정 96px(전부 원형)라 256px 이면 2배 DPR 까지 선명.
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

/** 표시용 src — 커스텀 프사 우선, 없으면 유저별 기본 프리셋. 이미지 로드 실패 폴백도 같은 값을 쓴다. */
export function avatarSrc(avatarUrl: string | null | undefined, userId: string | null | undefined): string {
  return avatarUrl || defaultAvatarUrl(userId);
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

/** 작은 칸 표시용 src — 커스텀 프사 우선, 없으면 기본 프사 썸네일. */
export function avatarThumbSrc(avatarUrl: string | null | undefined, userId: string | null | undefined): string {
  return avatarUrl || defaultAvatarThumbUrl(userId);
}
