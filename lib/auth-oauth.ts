"use client";

import {
  assertBrowserSupabaseSessionCleared,
  assertBrowserSupabaseOAuthVerifierStorageCleared,
  clearBrowserSupabaseAuthStorage,
  clearBrowserSupabaseOAuthVerifierStorage,
  readBrowserSupabaseOAuthVerifier,
  runExclusiveAuthLifecycle,
  readBrowserSupabaseSessionSnapshot,
  startSupabaseUnlockedSessionWriter,
} from "@/lib/supabase/client";
import { ensureAuth } from "@/lib/auth-client";
import { requireSuccessfulSessionRead } from "@/lib/auth-session-policy";
import { safeNext } from "@/lib/oauth-metadata";
import { clearProfileCache } from "@/lib/profile";
import { clearSentryIdentity } from "@/lib/sentry-context";
import {
  parseServerSignOutAck,
} from "@/lib/signout-policy";
import { log, errInfo } from "@/lib/log";
import { PUBLIC_ENV } from "@/lib/env";
import {
  parsePrepareSignupActiveConflict,
  parsePrepareSignupAck,
  parseOAuthStartUrl,
} from "@/lib/oauth-start-result";
import {
  cancelOAuthFlowLease,
  rememberOAuthFlowLease,
} from "@/lib/oauth-flow-lease";
import {
  clearOAuthFlowBrowserBarrier,
  stageOAuthFlowBrowserBarrier,
} from "@/lib/oauth-flow-browser-barrier";
import {
  readSupabaseAccessTokenIdentity,
} from "@/lib/supabase/session-cookie";
import {
  clientMutationResponseNeedsReconciliation,
  readBoundedClientJsonResponse,
  runClientMutation,
  type ClientMutationEvidence,
} from "@/lib/client-mutation";

export type OAuthProvider = "kakao" | "google";

class OAuthExistingFlowConflictError extends Error {
  constructor() {
    super("oauth_flow_already_active");
    this.name = "OAuthExistingFlowConflictError";
  }
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  let binary = "";
  for (const byte of new Uint8Array(digest)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/**
 * OAuth 로그인/회원가입 시작 — **항상 `signInWithOAuth`(계정 선택 1회)**.
 * linkIdentity 제거(익명+기록 있을 때 이미 가입된 계정이면 2회 선택되던 문제 해결).
 * 익명 세션이면 가입 시 데이터 이전을 위해 anon id 를 서명 쿠키로 기록(`/api/auth/prepare-signup`).
 * 신규/기존 판별·동의·마이그는 `/auth/callback`→`/signup`→onboard 에서 처리.
 * (opts.forceSignIn 은 더 이상 분기에 쓰이지 않음 — 항상 sign-in.)
 */
const OAUTH_CALLBACK_WARM_TARGETS = [
  "/api/auth/oauth-flow/preflight",
  "/api/auth/oauth-flow/bind-target",
  "/api/auth/oauth-flow/finalize",
  "/api/auth/oauth-flow/release",
  "/auth/callback/continue",
] as const;

/**
 * The callback hand-off crosses five separately deployed functions. Booting
 * them serially on cold starts dominates the perceived login time, so wake
 * every one while the user is still on the provider page. keepalive requests
 * survive the navigation away; HEAD carries no cookies, no body, and no
 * domain effect, and any response (405 included) means the function is warm.
 * Warming is strictly best-effort and must never touch the flow itself.
 */
function warmOAuthCallbackFunctions(): void {
  for (const target of OAUTH_CALLBACK_WARM_TARGETS) {
    try {
      void fetch(target, {
        method: "HEAD",
        cache: "no-store",
        credentials: "omit",
        keepalive: true,
      }).catch(() => {});
    } catch {
      // Warming failures are irrelevant by design.
    }
  }
}

export async function startOAuth(
  provider: OAuthProvider,
  opts?: {
    next?: string;
    forceSignIn?: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  warmOAuthCallbackFunctions();
  const next = safeNext(opts?.next);
  const lifecycleSignal =
    opts?.signal ?? new AbortController().signal;

  // A fresh /login also mounts SessionBootstrap. Join its anonymous-session
  // single-flight before reading the user or writing the migration cookie, so
  // an early click cannot fail with a missing session or race a late anon save.
  const expectedSession = await ensureAuth(lifecycleSignal);
  const flowId = crypto.randomUUID();
  const prepareBody = JSON.stringify({
    flowId,
    expectedUserId: expectedSession.user.id,
    expectedAnonymous:
      expectedSession.user.is_anonymous === true,
    provider,
    next,
  });
  await runExclusiveAuthLifecycle(
    lifecycleSignal,
    async (auth) => {
      const before = requireSuccessfulSessionRead(
        await auth.getSession(),
      );
      const beforeIdentity = before
        ? readSupabaseAccessTokenIdentity(before.access_token)
        : null;
      if (
        !before ||
        !beforeIdentity ||
        before.user.id !== expectedSession.user.id ||
        before.user.is_anonymous !==
          expectedSession.user.is_anonymous
      ) {
        throw new Error("oauth_session_changed");
      }

      // Drain every pre-barrier SDK S operation, then keep one outer S from
      // strict source CAS through durable local barrier, server intent, PKCE
      // verifier persistence and navigation. Background Auth transport also
      // observes the durable barrier before it can start a later write.
      await startSupabaseUnlockedSessionWriter(
        lifecycleSignal,
        async () => {
          const rawBefore =
            await readBrowserSupabaseSessionSnapshot();
          if (
            !rawBefore ||
            rawBefore.evidence.userId !== before.user.id ||
            rawBefore.evidence.sessionId !==
              beforeIdentity.sessionId ||
            rawBefore.evidence.accessToken !==
              before.access_token ||
            rawBefore.evidence.refreshToken !==
              before.refresh_token
          ) {
            throw new Error("oauth_session_changed");
          }
          stageOAuthFlowBrowserBarrier(flowId);
          try {
            const prepare = async (
              signal: AbortSignal,
            ): Promise<ClientMutationEvidence<string>> => {
              const prepared = await fetch(
                "/api/auth/prepare-signup",
                {
                  method: "POST",
                  credentials: "same-origin",
                  cache: "no-store",
                  redirect: "error",
                  headers: {
                    accept: "application/json",
                    "content-type": "application/json",
                  },
                  body: prepareBody,
                  signal,
                },
              );
              const parsed = await readBoundedClientJsonResponse(
                prepared,
                signal,
              );
              const ack = parsePrepareSignupAck(
                parsed.ok ? parsed.value : null,
                flowId,
              );
              if (prepared.status === 200 && ack) {
                return { kind: "confirmed", value: ack };
              }
              if (
                prepared.status === 409 &&
                parsed.ok &&
                parsePrepareSignupActiveConflict(parsed.value)
              ) {
                return {
                  kind: "rejected",
                  error: new OAuthExistingFlowConflictError(),
                };
              }
              const error = new Error(
                `prepare_signup_http_${prepared.status}`,
              );
              return clientMutationResponseNeedsReconciliation(
                prepared.status,
                prepared.ok,
              )
                ? {
                    kind: "unconfirmed",
                    reason:
                      "prepare_signup_response_unconfirmed",
                    error,
                  }
                : { kind: "rejected", error };
            };
            const prepared = await runClientMutation({
              attempt: prepare,
              reconcile: prepare,
              signal: lifecycleSignal,
            });
            if (prepared.kind !== "confirmed") {
              const error =
                prepared.kind === "rejected"
                  ? prepared.error
                  : new Error(
                      "prepare_signup_result_unconfirmed",
                    );
              log.warn("auth.prepare_signup_fail", {
                ...errInfo(error),
              });
              throw error;
            }
            rememberOAuthFlowLease(flowId);

            const redirectTo =
              `${window.location.origin}/auth/callback` +
              `?next=${encodeURIComponent(next)}` +
              `&p=${provider}&flow=${flowId}`;
            const options =
              provider === "google"
                ? {
                    redirectTo,
                    queryParams: { prompt: "select_account" },
                    skipBrowserRedirect: true,
                  }
                : { redirectTo, skipBrowserRedirect: true };
            // signInWithOAuth's PKCE verifier writer is not internally locked;
            // this call intentionally runs inside the already-held outer S.
            const result = await auth.signInWithOAuth({
              provider,
              options,
            });
            let verifier =
              await readBrowserSupabaseOAuthVerifier();
            const codeChallenge = await pkceChallenge(verifier);
            verifier = "";
            const oauthUrl = parseOAuthStartUrl(result, {
              provider,
              supabaseUrl: PUBLIC_ENV.SUPABASE_URL,
              redirectTo,
              codeChallenge,
            });
            if (!oauthUrl) {
              throw (
                result.error ??
                new Error("invalid_oauth_start_ack")
              );
            }
            const rawAfter =
              await readBrowserSupabaseSessionSnapshot();
            if (
              !rawAfter ||
              rawAfter.rawCookieBytes !==
                rawBefore.rawCookieBytes ||
              rawAfter.evidence.userId !==
                rawBefore.evidence.userId ||
              rawAfter.evidence.sessionId !==
                rawBefore.evidence.sessionId ||
              rawAfter.evidence.accessToken !==
                rawBefore.evidence.accessToken ||
              rawAfter.evidence.refreshToken !==
                rawBefore.evidence.refreshToken
            ) {
              throw new Error("oauth_session_changed");
            }
            if (lifecycleSignal.aborted) {
              throw (
                lifecycleSignal.reason ??
                new Error("oauth_start_aborted")
              );
            }
            window.location.assign(oauthUrl);
          } catch (error) {
            if (error instanceof OAuthExistingFlowConflictError) {
              // The server rejected B before creating its DB intent because a
              // proof-only flow A already exists. Remove only the locally
              // staged, never-created B barrier and let null-flow discovery
              // recover A from its HttpOnly proof. A PKCE verifier cannot have
              // been written for B because signInWithOAuth has not run yet.
              clearOAuthFlowBrowserBarrier(flowId);
              window.location.replace("/auth/flow-pending");
              return;
            }
            const cancelled = await cancelOAuthFlowLease(
              flowId,
              { provider },
            );
            if (cancelled) {
              clearBrowserSupabaseOAuthVerifierStorage();
              assertBrowserSupabaseOAuthVerifierStorageCleared();
              clearOAuthFlowBrowserBarrier(flowId);
              throw error;
            }
            // An unknown begin/cancel outcome stays fenced and moves to the
            // durable recovery state machine instead of permitting a retry.
            window.location.replace(
              `/auth/flow-pending?flow=${encodeURIComponent(flowId)}`,
            );
          }
        },
      );
    },
  );
}

type ExactSignOutSession = {
  userId: string;
  sessionId: string;
};

async function signOutExact(
  signal?: AbortSignal,
  requiredSession?: ExactSignOutSession,
): Promise<void> {
  const lifecycleSignal = signal ?? new AbortController().signal;
  let localError: unknown = null;

  await runExclusiveAuthLifecycle(lifecycleSignal, async (auth) => {
    const session = requireSuccessfulSessionRead(
      await auth.getSession(),
    );
    const identity = session
      ? readSupabaseAccessTokenIdentity(session.access_token)
      : null;
    if (
      !session ||
      !identity ||
      session.user.id !== identity.userId ||
      (
        requiredSession !== undefined &&
        (
          identity.userId !== requiredSession.userId ||
          identity.sessionId !== requiredSession.sessionId
        )
      )
    ) {
      throw new Error("signout_session_invalid");
    }
    const expected = {
      flowId: null,
      userId: identity.userId,
      sessionId: identity.sessionId,
    } as const;
    const requestBody = JSON.stringify({
      flowId: expected.flowId,
      expectedUserId: expected.userId,
      expectedSessionId: expected.sessionId,
    });

    // The server revoke and httpOnly MIGRATE_COOKIE expiry are authoritative.
    // Keep the exact replay inside the origin-wide Auth lock so no other tab
    // can replace the session between the server acknowledgement and local
    // SDK reconciliation.
    await startSupabaseUnlockedSessionWriter(
      lifecycleSignal,
      async () => {
        const rawBefore =
          await readBrowserSupabaseSessionSnapshot();
        if (
          !rawBefore ||
          rawBefore.evidence.userId !== expected.userId ||
          rawBefore.evidence.sessionId !== expected.sessionId ||
          rawBefore.evidence.accessToken !==
            session.access_token ||
          rawBefore.evidence.refreshToken !==
            session.refresh_token
        ) {
          throw new Error("signout_session_changed");
        }

        const request = async (
          requestSignal: AbortSignal,
        ): Promise<ClientMutationEvidence<true>> => {
          const response = await fetch("/api/auth/signout", {
            method: "POST",
            credentials: "same-origin",
            headers: {
              accept: "application/json",
              "content-type": "application/json",
            },
            body: requestBody,
            cache: "no-store",
            redirect: "error",
            referrerPolicy: "no-referrer",
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
          if (
            response.status === 200 &&
            parseServerSignOutAck(data, expected)
          ) {
            return { kind: "confirmed", value: true };
          }
          const error = new Error(
            `signout_server_http_${response.status}`,
          );
          return clientMutationResponseNeedsReconciliation(
            response.status,
            response.ok,
          )
            ? {
                kind: "unconfirmed",
                reason:
                  "signout_server_response_unconfirmed",
                error,
              }
            : { kind: "rejected", error };
        };
        const serverOutcome = await runClientMutation({
          attempt: request,
          // A second exact POST reconciles a lost first response and
          // re-delivers every migration-cookie expiry header.
          reconcile: request,
          signal: lifecycleSignal,
        });
        if (serverOutcome.kind !== "confirmed") {
          const error =
            serverOutcome.kind === "rejected"
              ? serverOutcome.error
              : new Error(
                  "signout_server_result_unconfirmed",
                );
          log.error("auth.sign_out_server_fail", {
            ...errInfo(error),
          });
          throw new Error("sign_out_incomplete");
        }

        const rawAfter =
          await readBrowserSupabaseSessionSnapshot();
        if (
          !rawAfter ||
          rawAfter.rawCookieBytes !==
            rawBefore.rawCookieBytes ||
          rawAfter.evidence.userId !== expected.userId ||
          rawAfter.evidence.sessionId !==
            expected.sessionId ||
          rawAfter.evidence.accessToken !==
            rawBefore.evidence.accessToken ||
          rawAfter.evidence.refreshToken !==
            rawBefore.evidence.refreshToken
        ) {
          throw new Error("signout_session_changed");
        }
        clearBrowserSupabaseAuthStorage();
        assertBrowserSupabaseSessionCleared();
      });

    // The exact remote session is revoked and raw browser auth storage is
    // proven absent. A local-only SDK signout may now clear in-memory state
    // and emit SIGNED_OUT; it cannot invoke a remote revoke or resurrect the
    // removed cookie.
    try {
      const local = await auth.signOut({ scope: "local" });
      if (
        !local ||
        typeof local !== "object" ||
        !Object.prototype.hasOwnProperty.call(local, "error")
      ) {
        localError = new Error("signout_local_response_invalid");
      } else if (local.error !== null) {
        localError = local.error;
      }
    } catch (error) {
      localError = error;
    }
    assertBrowserSupabaseSessionCleared();
  });

  if (localError !== null) {
    log.warn("auth.sign_out_local_fail", {
      ...errInfo(localError),
    });
  }
  clearProfileCache(); // user별 프로필 캐시 정리 (다음 계정 오표시 방지)
  clearSentryIdentity(); // Sentry user 초기화 (이전 멤버 email/닉네임이 다음 익명에 잔류 방지)
}

/** 로그아웃 — 세션 종료 후 홈으로. 다음 진입 시 SessionBootstrap 이 새 익명 세션 생성. */
export async function signOut(signal?: AbortSignal): Promise<void> {
  await signOutExact(signal);
  window.location.href = "/";
}

/**
 * Clears only the stale deleted-account session named by the proxy. The
 * user+session CAS is checked inside the same H-owned sign-out lifecycle, so
 * a login completed after the redirect can never be signed out by it.
 */
export function reconcileDeletedAccountSignOut(
  expected: ExactSignOutSession,
  signal: AbortSignal,
): Promise<void> {
  return signOutExact(signal, expected);
}
