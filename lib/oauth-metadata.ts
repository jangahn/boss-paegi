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
 * Kakao/Google OAuth 프로필 추출 — 제공자별 키 차이를 방어적으로 흡수.
 * Google: name|full_name / picture / email / email_verified
 * Kakao : name|nickname / avatar_url|picture / email
 *
 * ⚠️ linkIdentity(익명 승격) 는 새 identity 데이터를 `user_metadata` 에 머지하지 않음 →
 * OAuth 닉/프사/이메일은 `identities[].identity_data` 에만 들어온다. 그래서 두 곳을 합쳐서 읽음
 * (identity_data 우선). user 는 admin.getUserById 로 받아 identities 가 채워진 객체여야 함.
 */
export function extractOAuthProfile(user: User): OAuthProfile {
  const provider = user.app_metadata?.provider;
  const identities = user.identities ?? [];
  const identity =
    identities.find((i) => i.provider === provider) ??
    identities[identities.length - 1];
  const idData = (identity?.identity_data ?? {}) as Record<string, unknown>;
  const um = (user.user_metadata ?? {}) as Record<string, unknown>;
  // identity_data 가 OAuth 원본 — user_metadata 위에 덮어써 우선시.
  const m: Record<string, unknown> = { ...um, ...idData };

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
 * open redirect/redirect loop 차단 — 내부 절대경로만 허용(query 는 보존, I8).
 * 외부 URL/프로토콜-상대(`//`)/비경로는 "/". 위험·자기참조 내부 경로
 * (`/auth/*`·`/api/*`·동의 흐름 자체인 `/consent`·`/signup`·`/reconsent`)도 "/".
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || typeof next !== "string") return "/";
  if (!next.startsWith("/")) return "/";
  if (next.startsWith("//")) return "/";
  const path = next.split(/[?#]/)[0];
  if (
    path.startsWith("/auth/") ||
    path.startsWith("/api/") ||
    path === "/consent" ||
    path === "/signup" ||
    path === "/reconsent"
  ) {
    return "/";
  }
  return next;
}
