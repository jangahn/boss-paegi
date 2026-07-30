"use client";

import { createClient } from "@/lib/supabase/client";
import { safeNext } from "@/lib/oauth-metadata";
import { clearProfileCache } from "@/lib/profile";
import { clearSentryIdentity } from "@/lib/sentry-context";
import {
  parseServerSignOutAck,
  resolveSignOutAttempts,
} from "@/lib/signout-policy";
import { log, errInfo } from "@/lib/log";
import { PUBLIC_ENV } from "@/lib/env";
import {
  isExactPrepareSignupAck,
  parseOAuthStartUrl,
} from "@/lib/oauth-start-result";
import {
  clientMutationResponseNeedsReconciliation,
  readBoundedClientJsonResponse,
  runClientMutation,
  type ClientMutationEvidence,
} from "@/lib/client-mutation";

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
  opts?: {
    next?: string;
    forceSignIn?: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  const next = safeNext(opts?.next);
  const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}&p=${provider}`;

  // 익명이면 prepare-signup — 서버가 현재 익명 user.id 를 HMAC 서명 쿠키로 기록(신규 가입 시 데이터 이전용).
  try {
    const userRead = await runClientMutation({
      attempt: async (requestSignal) => {
        try {
          const { data, error } = await createClient(
            requestSignal,
          ).auth.getUser();
          return error
            ? { kind: "rejected" as const, error }
            : { kind: "confirmed" as const, value: data };
        } catch (error) {
          return { kind: "rejected" as const, error };
        }
      },
      signal: opts?.signal,
    });
    if (userRead.kind !== "confirmed") {
      throw userRead.kind === "rejected"
        ? userRead.error
        : new Error(
            userRead.kind === "aborted"
              ? "auth_user_read_aborted"
              : "auth_user_read_unconfirmed",
          );
    }
    if (userRead.value.user?.is_anonymous) {
      const prepare = async (
        signal: AbortSignal,
      ): Promise<ClientMutationEvidence<true>> => {
        const prepared = await fetch("/api/auth/prepare-signup", {
          method: "POST",
          signal,
        });
        const preparedBody =
          await readBoundedClientJsonResponse(prepared, signal);
        const preparedAck = preparedBody.ok
          ? preparedBody.value
          : null;
        if (prepared.ok && isExactPrepareSignupAck(preparedAck)) {
          return { kind: "confirmed", value: true };
        }
        const error = new Error(`prepare_signup_http_${prepared.status}`);
        return clientMutationResponseNeedsReconciliation(
          prepared.status,
          prepared.ok,
        )
          ? {
              kind: "unconfirmed",
              reason: "prepare_signup_response_unconfirmed",
              error,
            }
          : { kind: "rejected", error };
      };
      const prepared = await runClientMutation({
        attempt: prepare,
        // Re-delivery is safe: the same authenticated anonymous user produces
        // the same signed migration cookie and gives this browser the ack.
        reconcile: prepare,
        signal: opts?.signal,
      });
      if (prepared.kind !== "confirmed") {
        throw prepared.kind === "rejected" && prepared.error instanceof Error
          ? prepared.error
          : new Error("prepare_signup_result_unconfirmed");
      }
    }
  } catch (e) {
    log.warn("auth.prepare_signup_fail", { ...errInfo(e) });
    // 익명 기록을 이전할 서명 쿠키 없이 OAuth로 넘어가면 새 계정은 만들어져도
    // 점수·캐릭터 귀속이 유실된다. 사용자가 재시도할 수 있게 시작 자체를 중단한다.
    throw e;
  }

  // 계정 재선택 보장: Google 은 prompt=select_account 로 계정 picker 재노출(취소→재로그인 시 다른 계정 선택).
  // Kakao 는 동일 파라미터를 지원하지 않으므로 주입하지 않음(미지원 param 으로 로그인 실패 방지) — 기존 세션 재사용될 수 있음.
  const options =
    provider === "google"
      ? {
          redirectTo,
          queryParams: { prompt: "select_account" },
          skipBrowserRedirect: true,
        }
      : { redirectTo, skipBrowserRedirect: true };
  const oauthStart = await runClientMutation({
    attempt: async (requestSignal) => {
      try {
        const result = await createClient(
          requestSignal,
        ).auth.signInWithOAuth({ provider, options });
        return {
          kind: "confirmed" as const,
          value: result,
        };
      } catch (error) {
        return { kind: "rejected" as const, error };
      }
    },
    signal: opts?.signal,
  });
  if (oauthStart.kind !== "confirmed") {
    throw oauthStart.kind === "rejected"
      ? oauthStart.error
      : new Error(
          oauthStart.kind === "aborted"
            ? "oauth_start_aborted"
            : "oauth_start_unconfirmed",
        );
  }
  const result = oauthStart.value;
  const oauthUrl = parseOAuthStartUrl(result, {
    provider,
    supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
    redirectTo,
  });
  if (!oauthUrl) {
    const error = result.error ?? new Error("invalid_oauth_start_ack");
    log.warn("auth.oauth_start_fail", { provider, ...errInfo(error) });
    throw error;
  }
  if (opts?.signal?.aborted) {
    throw new Error("oauth_start_aborted");
  }
  window.location.assign(oauthUrl);
}

/** 로그아웃 — 세션 종료 후 홈으로. 다음 진입 시 SessionBootstrap 이 새 익명 세션 생성. */
export async function signOut(signal?: AbortSignal): Promise<void> {
  const result = await resolveSignOutAttempts({
    // httpOnly MIGRATE_COOKIE 정리(타계정 오이전 방지, I4) — 서버 성공이
    // 필수다. 로컬 signOut만 성공해도 이 쿠키는 지울 수 없다.
    server: async () => {
      const request = async (
        requestSignal: AbortSignal,
      ): Promise<
        ClientMutationEvidence<{ responseOk: boolean; data: unknown }>
      > => {
        const response = await fetch("/api/auth/signout", {
          method: "POST",
          credentials: "same-origin",
          headers: { accept: "application/json" },
          cache: "no-store",
          signal: requestSignal,
        });
        const responseBody =
          await readBoundedClientJsonResponse(
            response,
            requestSignal,
          );
        const data: unknown = responseBody.ok
          ? responseBody.value
          : null;
        if (response.ok && parseServerSignOutAck(data)) {
          return {
            kind: "confirmed",
            value: { responseOk: true, data },
          };
        }
        const error = new Error(`signout_server_http_${response.status}`);
        return clientMutationResponseNeedsReconciliation(
          response.status,
          response.ok,
        )
          ? {
              kind: "unconfirmed",
              reason: "signout_server_response_unconfirmed",
              error,
            }
          : { kind: "rejected", error };
      };
      const outcome = await runClientMutation({
        attempt: request,
        // A second exact POST both reconciles a lost first response and
        // re-delivers every cookie-expiry Set-Cookie header to this browser.
        reconcile: request,
        signal,
      });
      if (outcome.kind === "confirmed") return outcome.value;
      throw outcome.kind === "rejected"
        ? outcome.error
        : new Error("signout_server_result_unconfirmed");
    },
    local: async () => {
      const outcome = await runClientMutation({
        attempt: async (requestSignal) => {
          const local = await createClient(
            requestSignal,
          ).auth.signOut();
          if (
            local &&
            typeof local === "object" &&
            Object.prototype.hasOwnProperty.call(local, "error")
          ) {
            return { kind: "confirmed", value: local };
          }
          return {
            kind: "unconfirmed",
            reason: "signout_local_response_unconfirmed",
          };
        },
        signal,
      });
      if (outcome.kind === "confirmed") return outcome.value;
      throw outcome.kind === "rejected"
        ? outcome.error
        : new Error("signout_local_result_unconfirmed");
    },
  });
  if (!result.local.ok) {
    log.warn("auth.sign_out_local_fail", {
      ...errInfo(result.local.error),
    });
  }
  if (!result.server.ok) {
    log.error("auth.sign_out_server_fail", {
      ...errInfo(result.server.error),
    });
    throw new Error("sign_out_incomplete");
  }
  clearProfileCache(); // user별 프로필 캐시 정리 (다음 계정 오표시 방지)
  clearSentryIdentity(); // Sentry user 초기화 (이전 멤버 email/닉네임이 다음 익명에 잔류 방지)
  window.location.href = "/";
}
