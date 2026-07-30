"use client";

import { createClient } from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";
import {
  requireSupabaseData,
  requireSupabaseOptionalData,
} from "@/lib/supabase-operation";
import {
  isExactNicknameMutationRow,
  parseProfileMember,
  parseProfileSelf,
} from "@/lib/profile-read";
import { runClientMutation } from "@/lib/client-mutation";

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

/** 크레딧 변동(생성 차감·구매·환불 등) 시 헤더 생성권을 새로고침 없이 즉시 갱신하도록 알리는 이벤트. */
export const CREDITS_CHANGED_EVENT = "boss-paegi:credits-changed";

/** 크레딧 변동 후 호출 — AccountMenu(헤더 생성권)가 이 이벤트를 듣고 재조회한다. 클라 전용(SSR no-op). */
export function notifyCreditsChanged(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(CREDITS_CHANGED_EVENT));
  }
}

/**
 * 내 프로필 조회 — 세션 없으면 익명 세션 생성 후 조회.
 * **동의 여부는 서버 proxy 가 게이트**(클라 계산 불필요) → 비익명이면 isLoggedIn=true.
 * auth.users 생성 트리거가 보장하는 profile no-row와 모든 non-null 손상 row는 권위 데이터
 * 장애로 throw한다. 단, 로그인 직후 /consent 전의 합법적인 member no-row는 별도 처리한다.
 */
export async function getMyProfile(
  signal?: AbortSignal,
): Promise<MyProfile> {
  const outcome = await runClientMutation<MyProfile>({
    attempt: async (requestSignal) => {
      try {
        const session = await ensureAuth(requestSignal);
        const sb = createClient(requestSignal);
        const profileRow = await requireSupabaseData(
          "profile.self",
          () =>
            sb
              .from("profiles")
              .select("id, display_name, avatar_url")
              .eq("id", session.user.id)
              .abortSignal(requestSignal)
              .maybeSingle(),
        );
        const base = parseProfileSelf(profileRow, session.user.id);

        if (session.user.is_anonymous === true) {
          return {
            kind: "confirmed",
            value: {
              ...base,
              isLoggedIn: false,
              genCredits: null,
              isAdmin: false,
            },
          };
        }

        // 비익명 OAuth 직후 /consent 전에는 member row가 아직 없을 수 있다.
        // 성공 no-row만 허용하고, non-null 손상 row/transport 오류는 실패시킨다.
        const memberRow = await requireSupabaseOptionalData(
          "profile.member",
          () =>
            sb
              .from("member_accounts")
              .select("gen_credits, is_admin")
              .eq("user_id", session.user.id)
              .abortSignal(requestSignal)
              .maybeSingle(),
        );
        const member =
          memberRow === null ? null : parseProfileMember(memberRow);

        return {
          kind: "confirmed",
          value: {
            ...base,
            isLoggedIn: true,
            genCredits: member?.gen_credits ?? null,
            isAdmin: member?.is_admin ?? false,
          },
        };
      } catch (error) {
        return { kind: "rejected", error };
      }
    },
    signal,
  });
  if (outcome.kind === "confirmed") return outcome.value;
  throw outcome.kind === "rejected"
    ? outcome.error
    : new Error(
        outcome.kind === "aborted"
          ? "profile_read_aborted"
          : "profile_read_unconfirmed",
      );
}

/**
 * 닉네임 수정 — RLS self update. 랭킹/공유는 profiles join 이라 즉시 반영.
 * @returns 정규화되어 저장된 닉네임
 */
export async function updateNickname(
  raw: string,
  signal?: AbortSignal,
): Promise<string> {
  const name = raw.trim().slice(0, NICKNAME_MAX);
  if (name.length < 2) {
    throw new Error("닉네임은 2자 이상이어야 해요");
  }
  const session = await ensureAuth(signal);
  const sb = createClient(signal);
  const deliver = async (requestSignal: AbortSignal) => {
    const { data, error } = await sb
      .from("profiles")
      .update({ display_name: name })
      .eq("id", session.user.id)
      .select("id, display_name")
      .abortSignal(requestSignal)
      .maybeSingle();
    if (!error && isExactNicknameMutationRow(data, session.user.id, name)) {
      return { kind: "confirmed" as const, value: name };
    }
    return {
      kind: "unconfirmed" as const,
      reason: "nickname_update_response_unconfirmed",
      error,
    };
  };
  const outcome = await runClientMutation({
    attempt: deliver,
    // Setting the same normalized display_name on the same profile is
    // idempotent, so an exact second delivery safely reconciles response loss.
    reconcile: deliver,
    signal,
  });
  if (outcome.kind === "confirmed") return outcome.value;
  if (outcome.kind === "aborted") {
    throw new Error("닉네임 저장이 취소됐어요");
  }
  throw new Error("닉네임 저장 실패 — 잠시 후 다시 시도해주세요");
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
