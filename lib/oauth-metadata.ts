import type { User } from "@supabase/supabase-js";

// 순수 함수 모듈 (server-only 아님) — safeNext 는 client(login page)·server(callback)·proxy 공용.

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

// next 목적지로 부적합한 정적 asset 확장자(게이트 우회·루프 방지).
const STATIC_EXT = /\.(?:png|jpe?g|webp|gif|svg|ico|css|js|map|txt|xml|json|woff2?)$/i;
// open-redirect 검사용 더미 base — 이 origin 으로만 풀리는 값(=내부 절대경로)만 허용.
const SAFE_BASE = "http://internal.invalid";

/**
 * 안전한 내부 이동 경로 — proxy redirect·callback·consent·login 공용 단일 함수.
 * **WHATWG URL 파서로 정규화**해 open-redirect 우회를 봉쇄: 외부 URL·프로토콜-상대(`//`)·
 * 백슬래시/제어문자 트릭(`/\evil.com`·`/\t//evil.com` 등 브라우저가 `//evil.com` 으로 해석)이
 * 모두 `SAFE_BASE` 가 아닌 origin 으로 풀려 `/` 로 collapse 된다. pathname+search 보존, **hash 제거**.
 * 위험·자기참조 내부 경로(`/auth/*`·`/api/*`·`/login`·`/consent`·`/signup`·`/reconsent`·정적 asset)도 `/`.
 */
export function safeNext(next: string | null | undefined): string {
  if (!next || typeof next !== "string") return "/";
  if (!next.startsWith("/")) return "/"; // 절대 내부 경로만(외부/상대 차단)
  let parsed: URL;
  try {
    parsed = new URL(next, SAFE_BASE);
  } catch {
    return "/";
  }
  if (parsed.origin !== SAFE_BASE) return "/"; // 다른 origin 으로 풀리면(우회) collapse
  const path = parsed.pathname; // hash 자동 제거
  if (
    path.startsWith("/auth/") ||
    path.startsWith("/api/") ||
    path === "/login" ||
    path === "/consent" ||
    path === "/signup" ||
    path === "/reconsent" ||
    STATIC_EXT.test(path)
  ) {
    return "/";
  }
  return parsed.pathname + parsed.search;
}
