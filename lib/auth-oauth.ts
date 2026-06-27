"use client";

import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/oauth-metadata";
import { clearProfileCache } from "@/lib/profile";
import { clearSentryIdentity } from "@/lib/sentry-context";
import { log, errInfo } from "@/lib/log";

export type OAuthProvider = "kakao" | "google";

/**
 * OAuth 로그인/회원가입 시작 — **항상 `signInWithOAuth`(계정 선택 1회)**.
 * linkIdentity 제거(익명+기록 있을 때 이미 가입된 계정이면 2회 선택되던 문제 해결).
 * 익명 세션이면 가입 시 데이터 이전을 위해 anon id 를 서명 쿠키로 기록(`/api/auth/prepare-signup`).
 * 신규/기존 판별·동의·마이그는 `/auth/callback`→`/signup`→onboard 에서 처리.
 * (opts.forceSignIn 은 더 이상 분기에 쓰이지 않음 — 항상 sign-in.)
 */
export async function startOAuth(
  provider: OAuthProvider,
  opts?: { next?: string; forceSignIn?: boolean }
): Promise<void> {
  const sb = createClient();
  const next = safeNext(opts?.next);
  const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}&p=${provider}`;

  // 익명이면 prepare-signup — 서버가 현재 익명 user.id 를 HMAC 서명 쿠키로 기록(신규 가입 시 데이터 이전용).
  try {
    const { data } = await sb.auth.getUser();
    if (data.user?.is_anonymous) {
      await fetch("/api/auth/prepare-signup", { method: "POST" });
    }
  } catch (e) {
    log.warn("auth.prepare_signup_fail", { ...errInfo(e) });
  }

  // 계정 재선택 보장: Google 은 prompt=select_account 로 계정 picker 재노출(취소→재로그인 시 다른 계정 선택).
  // Kakao 는 동일 파라미터를 지원하지 않으므로 주입하지 않음(미지원 param 으로 로그인 실패 방지) — 기존 세션 재사용될 수 있음.
  const options =
    provider === "google"
      ? { redirectTo, queryParams: { prompt: "select_account" } }
      : { redirectTo };
  const { error } = await sb.auth.signInWithOAuth({ provider, options });
  if (error) {
    log.warn("auth.oauth_start_fail", { provider, ...errInfo(error) });
    throw error;
  }
}

/** 로그아웃 — 세션 종료 후 홈으로. 다음 진입 시 SessionBootstrap 이 새 익명 세션 생성. */
export async function signOut(): Promise<void> {
  const sb = createClient();
  clearProfileCache(); // user별 프로필 캐시 정리 (다음 계정 오표시 방지)
  clearSentryIdentity(); // Sentry user 초기화 (이전 멤버 email/닉네임이 다음 익명에 잔류 방지)
  // httpOnly MIGRATE_COOKIE 정리(타계정 오이전 방지, I4) — 서버 경유.
  await fetch("/api/auth/signout", { method: "POST" }).catch(() => {});
  const { error } = await sb.auth.signOut();
  if (error) log.warn("auth.sign_out_fail", { ...errInfo(error) });
  window.location.href = "/";
}
