"use client";

import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";

export type MyProfile = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  /** 비익명 세션(=로그인). 메뉴·갤러리 표시용. (글로벌 동의 모델: 로그인 사용자는 proxy 통과 = 동의완료.) */
  isLoggedIn: boolean;
  /** 잔여 생성권. 로그인+member row 있을 때만, 그 외/실패는 null. */
  genCredits: number | null;
  /** 관리자 여부(member_accounts.is_admin self-read). 메뉴 노출 제어용 — 접근은 서버 requireAdmin 강제. */
  isAdmin: boolean;
};

const NICKNAME_MAX = 12;
const UNLIMITED_THRESHOLD = 9999;

export function formatCredits(n: number): string {
  return n >= UNLIMITED_THRESHOLD ? "무제한" : `${n}개`;
}

/**
 * 내 프로필 조회 — 세션 없으면 익명 세션 생성 후 조회.
 * **동의 여부는 서버 proxy 가 게이트**(클라 계산 불필요) → 비익명이면 isLoggedIn=true.
 * member row 없어도(신규·동의 전) 깨지지 않음: isLoggedIn=true·genCredits=null·isAdmin=false.
 */
export async function getMyProfile(): Promise<MyProfile | null> {
  const session = await ensureAuth();
  const sb = createClient();
  const { data } = await sb
    .from("profiles")
    .select("id, display_name, avatar_url")
    .eq("id", session.user.id)
    .single();
  if (!data) return null;

  const base = {
    id: data.id as string,
    display_name: data.display_name as string,
    avatar_url: (data.avatar_url as string | null) ?? null,
  };

  if (session.user.is_anonymous === true) {
    return { ...base, isLoggedIn: false, genCredits: null, isAdmin: false };
  }

  // 비익명 — member_accounts self-read(없으면 null-safe).
  const m = await sb
    .from("member_accounts")
    .select("gen_credits, is_admin")
    .eq("user_id", session.user.id)
    .maybeSingle()
    .then((r) => r.data as Record<string, unknown> | null);

  return {
    ...base,
    isLoggedIn: true,
    genCredits: (m?.gen_credits as number | undefined) ?? null,
    isAdmin: (m?.is_admin as boolean | undefined) ?? false,
  };
}

/**
 * 닉네임 수정 — RLS self update. 랭킹/공유는 profiles join 이라 즉시 반영.
 * @returns 정규화되어 저장된 닉네임
 */
export async function updateNickname(raw: string): Promise<string> {
  const name = raw.trim().slice(0, NICKNAME_MAX);
  if (name.length < 2) {
    throw new Error("닉네임은 2자 이상이어야 해요");
  }
  const session = await ensureAuth();
  const sb = createClient();
  const { error } = await sb
    .from("profiles")
    .update({ display_name: name })
    .eq("id", session.user.id);
  if (error) throw new Error("닉네임 저장 실패 — 잠시 후 다시 시도해주세요");
  return name;
}

// ── 프로필 즉시표시 캐시 (nav 스피너 제거) — user.id 별 키. **메뉴 표시용(isLoggedIn)만** 캐시. ──
// genCredits/isAdmin 은 캐시 안 함(fresh getMyProfile). 동의 게이트는 서버 proxy. TTL 로 stale 방지.
const PROFILE_CACHE_PREFIX = "boss-paegi:profile:";
const PROFILE_CACHE_TTL_MS = 120_000;

export type CachedProfile = {
  display_name: string;
  avatar_url: string | null;
  isLoggedIn: boolean;
};

export function readCachedProfile(userId: string): CachedProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_PREFIX + userId);
    if (!raw) return null;
    const obj = JSON.parse(raw) as CachedProfile & { cachedAt?: number };
    if (!obj.cachedAt || Date.now() - obj.cachedAt > PROFILE_CACHE_TTL_MS) return null;
    if (typeof obj.isLoggedIn !== "boolean") return null; // 구버전 캐시(accountState/isMember) 무시
    return {
      display_name: obj.display_name,
      avatar_url: obj.avatar_url,
      isLoggedIn: obj.isLoggedIn,
    };
  } catch {
    return null;
  }
}

export function writeCachedProfile(userId: string, p: CachedProfile): void {
  try {
    localStorage.setItem(
      PROFILE_CACHE_PREFIX + userId,
      JSON.stringify({
        display_name: p.display_name,
        avatar_url: p.avatar_url,
        isLoggedIn: p.isLoggedIn,
        cachedAt: Date.now(),
      })
    );
  } catch {
    /* localStorage 불가(프라이빗 모드 등) — 캐시 없이 동작 */
  }
}

/** 로그아웃/계정 변경 시 전체 프로필 캐시 정리. */
export function clearProfileCache(): void {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(PROFILE_CACHE_PREFIX)) localStorage.removeItem(k);
    }
  } catch {
    /* noop */
  }
}

export { NICKNAME_MAX };
