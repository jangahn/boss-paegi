"use client";

import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/oauth-metadata";
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

  let isAnon = false;
  if (!opts?.forceSignIn) {
    const { data } = await sb.auth.getUser();
    isAnon = data.user?.is_anonymous === true;
  }

  if (isAnon) {
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
  const { error } = await sb.auth.signOut();
  if (error) log.warn("auth.sign_out_fail", { ...errInfo(error) });
  window.location.href = "/";
}
