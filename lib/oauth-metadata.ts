import type { User } from "@supabase/supabase-js";

// 순수 함수 모듈 (server-only 아님) — safeNext 는 client(login page)·server(callback) 공용.

const NICKNAME_MAX = 12;

export type OAuthProfile = {
  /** OAuth 제공 닉네임 (12자 클램프). 없으면 null → 기존 display_name 유지(덮어쓰지 않음). */
  displayName: string | null;
  /** OAuth 프로필 이미지 URL (외부 핫링크). 없으면 null. */
  avatarUrl: string | null;
  /** 계정 이메일. 없으면 null → 멤버화 차단. */
  email: string | null;
  /** 이메일 검증 여부. 명시적으로 false 면 멤버화 차단. */
  emailVerified: boolean;
};

/**
 * Kakao/Google OAuth user_metadata 에서 프로필 추출 — 제공자별 키 차이를 방어적으로 흡수.
 * Google: name|full_name / picture / email / email_verified
 * Kakao : name|nickname / avatar_url|picture / email
 */
export function extractOAuthProfile(user: User): OAuthProfile {
  const m = (user.user_metadata ?? {}) as Record<string, unknown>;

  const rawName = firstString(m.name, m.full_name, m.nickname, m.user_name);
  const displayName = rawName ? rawName.trim().slice(0, NICKNAME_MAX) || null : null;

  const avatarUrl = firstString(m.avatar_url, m.picture, m.profile_image_url);

  const email = firstString(user.email, m.email);

  // 명시적 false 만 미검증으로 취급(키 부재 시 Supabase 의 verified-email linking 정책에 위임).
  const emailVerified =
    m.email_verified === false ? false : Boolean(user.email_confirmed_at) || m.email_verified !== false;

  return { displayName, avatarUrl, email, emailVerified };
}

function firstString(...vals: unknown[]): string | null {
  for (const v of vals) {
    if (typeof v === "string" && v.trim().length > 0) return v;
  }
  return null;
}

/**
 * open redirect 차단 — 내부 절대경로만 허용. 외부 URL/프로토콜-상대(`//`)/비경로는 모두 "/".
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || typeof next !== "string") return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  return next;
}
