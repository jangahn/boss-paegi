"use client";

import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/oauth-metadata";
import { clearProfileCache } from "@/lib/profile";
import { log, errInfo } from "@/lib/log";

export type OAuthProvider = "kakao" | "google";

/**
 * OAuth 로그인/가입 시작.
 * - 현재 익명 세션이면 `linkIdentity` → 같은 user.id 로 멤버 승격(dolls/scores 보존).
 * - 세션 없음 / 재로그인(forceSignIn)이면 `signInWithOAuth` → 기존(또는 신규) 계정 로그인.
 * 둘 다 `/auth/callback?next=` 로 복귀.
 */
export async function startOAuth(
  provider: OAuthProvider,
  opts?: { next?: string; forceSignIn?: boolean }
): Promise<void> {
  const sb = createClient();
  const next = safeNext(opts?.next);
  // p=provider 를 함께 실어 보냄 — identity_already_exists 바운스 시 콜백이 어느 provider 로
  // 자동 재로그인할지 알 수 있게 (next 처럼 redirectTo 쿼리는 에러 redirect 에도 보존됨).
  const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}&p=${provider}`;

  // 익명 분기 결정: 보존할 데이터(점수)가 있을 때만 linkIdentity(같은 user.id 보존).
  // 점수 없는 새 익명 = 재로그인 케이스 → signInWithOAuth 로 OAuth round-trip 1회 → 계정 선택 1회.
  // (구글 재로그인이 linkIdentity 실패→auto signInWithOAuth 로 2회 선택되던 버그 해결.)
  let useLink = false;
  let isAnonymous = false;
  let scoreCount = 0;
  let countFailed = false;

  if (!opts?.forceSignIn) {
    const { data } = await sb.auth.getUser();
    const user = data.user;
    isAnonymous = user?.is_anonymous === true;
    if (isAnonymous && user) {
      const { count, error } = await sb
        .from("scores")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", user.id);
      if (error) {
        // 조회 실패 → 데이터 유실 방지 우선(linkIdentity). 최악 2회 선택이지만 점수 보존 기회 유지.
        countFailed = true;
        useLink = true;
      } else {
        scoreCount = count ?? 0;
        useLink = scoreCount > 0; // 점수 있으면 보존, 없으면 깔끔히 signInWithOAuth
      }
    }
  }

  const method = useLink ? "linkIdentity" : "signInWithOAuth";
  log.info("auth.oauth_start_decision", {
    provider,
    isAnonymous,
    scoreCount,
    countFailed,
    method,
  });

  if (useLink) {
    const { error } = await sb.auth.linkIdentity({
      provider,
      options: { redirectTo },
    });
    if (error) {
      log.warn("auth.link_identity_start_fail", { provider, ...errInfo(error) });
      throw error;
    }
    return;
  }

  const { error } = await sb.auth.signInWithOAuth({
    provider,
    options: { redirectTo },
  });
  if (error) {
    log.warn("auth.oauth_start_fail", { provider, ...errInfo(error) });
    throw error;
  }
}

/** 로그아웃 — 세션 종료 후 홈으로. 다음 진입 시 SessionBootstrap 이 새 익명 세션 생성. */
export async function signOut(): Promise<void> {
  const sb = createClient();
  clearProfileCache(); // user별 프로필 캐시 정리 (다음 계정 오표시 방지)
  const { error } = await sb.auth.signOut();
  if (error) log.warn("auth.sign_out_fail", { ...errInfo(error) });
  window.location.href = "/";
}
