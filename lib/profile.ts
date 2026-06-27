"use client";

import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";
import {
  needsConsent,
  type ConsentMember,
  type LegalVersions,
} from "@/lib/consent";

/** 클라가 보는 계정 상태. consent_incomplete = 비익명인데 동의 미충족(로그인 마지막 단계 미완). */
export type AccountState = "anonymous" | "consent_incomplete" | "member";

export type MyProfile = {
  id: string;
  display_name: string;
  avatar_url: string | null;
  accountState: AccountState;
  /** accountState==='member' 파생 — 기존 호출부(갤러리/생성/게임오버) 호환. "동의까지 끝난 회원"만 true. */
  isMember: boolean;
  /** 잔여 생성권. 멤버만, 그 외/조회실패는 null. */
  genCredits: number | null;
  /** 관리자 여부(member_accounts.is_admin self-read). 메뉴 노출 제어용 — 접근은 서버 requireAdmin 강제. */
  isAdmin: boolean;
};

const NICKNAME_MAX = 12;
/** 이 이상이면 사실상 무제한(운영계정) 으로 표시. */
const UNLIMITED_THRESHOLD = 9999;

/** 생성권 표시 문구 — 무제한 임계 이상이면 "무제한". */
export function formatCredits(n: number): string {
  return n >= UNLIMITED_THRESHOLD ? "무제한" : `${n}개`;
}

/** 현재 발행본 버전(공개 API). 실패는 {null,null}(I9 fail-open — stamp 된 회원 미강등, age·row 검사는 유효). */
async function fetchCurrentVersions(): Promise<LegalVersions> {
  try {
    const res = await fetch("/api/legal/versions");
    if (!res.ok) return { terms: null, privacy: null };
    const j = (await res.json()) as { terms?: number | null; privacy?: number | null };
    return { terms: j.terms ?? null, privacy: j.privacy ?? null };
  } catch {
    return { terms: null, privacy: null };
  }
}

/**
 * 내 프로필 조회 — 세션 없으면 익명 세션 생성 후 조회.
 * 비익명이면 member_accounts(동의 컬럼) + 현재 발행본 버전으로 **accountState** 산출(`lib/consent` 단일 규칙).
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
    return { ...base, accountState: "anonymous", isMember: false, genCredits: null, isAdmin: false };
  }

  // 비익명 — member_accounts self-read(동의 컬럼 포함) + 현재 버전 병렬 조회.
  const [m, curr] = await Promise.all([
    sb
      .from("member_accounts")
      .select("gen_credits, is_admin, age_confirmed_at, terms_version, privacy_version")
      .eq("user_id", session.user.id)
      .maybeSingle()
      .then((r) => r.data as Record<string, unknown> | null),
    fetchCurrentVersions(),
  ]);

  const member: ConsentMember = m
    ? {
        age_confirmed_at: (m.age_confirmed_at as string | null) ?? null,
        terms_version: (m.terms_version as number | null) ?? null,
        privacy_version: (m.privacy_version as number | null) ?? null,
      }
    : null;
  const incomplete = needsConsent(member, curr);

  return {
    ...base,
    accountState: incomplete ? "consent_incomplete" : "member",
    isMember: !incomplete,
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

// ── 프로필 즉시표시 캐시 (nav 스피너 제거) — user.id 별 키. genCredits 는 변동성 커서 캐시 안 함. ──
// TTL(I7): accountState 가 오래 stale 로 남아 약관 개정 후에도 member 로 보이지 않게 만료를 둔다.
const PROFILE_CACHE_PREFIX = "boss-paegi:profile:";
const PROFILE_CACHE_TTL_MS = 120_000;

export type CachedProfile = {
  display_name: string;
  avatar_url: string | null;
  accountState: AccountState;
};

export function readCachedProfile(userId: string): CachedProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_CACHE_PREFIX + userId);
    if (!raw) return null;
    const obj = JSON.parse(raw) as CachedProfile & { cachedAt?: number };
    if (!obj.cachedAt || Date.now() - obj.cachedAt > PROFILE_CACHE_TTL_MS) return null;
    if (!obj.accountState) return null; // 구버전 캐시(isMember) 무시
    return {
      display_name: obj.display_name,
      avatar_url: obj.avatar_url,
      accountState: obj.accountState,
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
        accountState: p.accountState,
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
