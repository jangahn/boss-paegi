"use client";

import type { Session } from "@supabase/supabase-js";
import {
  establishAnonymousAuthSession,
} from "@/lib/supabase/client";
import { log, errInfo } from "@/lib/log";
import { runClientMutation } from "@/lib/client-mutation";

// 진행 중 익명 로그인 1건만 공유 — SessionBootstrap·AccountMenu·ConsentGuard 등이 첫 진입에
// 동시에 ensureAuth() 를 호출해도 signInAnonymously 가 한 번만 일어나게(익명 유저 다중 생성 race 방지).
let inflightAuth: Promise<Session> | null = null;

/**
 * 익명 세션 보장 — 없으면 signInAnonymously, 있으면 그대로 반환. 동시 호출 안전(in-flight 합류).
 * 첫 진입한 사용자가 가입 절차 없이 즉시 데이터 쓰고 읽을 수 있게 함.
 */
export async function ensureAuth(signal?: AbortSignal): Promise<Session> {
  if (!inflightAuth) {
    inflightAuth = (async () => {
      const outcome = await runClientMutation({
        attempt: async (requestSignal) => {
          try {
            return {
              kind: "confirmed" as const,
              value: await establishAnonymousAuthSession(
                requestSignal,
              ),
            };
          } catch (error) {
            return { kind: "rejected" as const, error };
          }
        },
      });
      if (outcome.kind === "confirmed") {
        const session = outcome.value;
        log.info("auth.session_ready", {
          userId: session.user.id,
          anonymous: session.user.is_anonymous === true,
        });
        return session;
      }
      const error =
        outcome.kind === "rejected"
          ? outcome.error
          : new Error("auth_anon_sign_in_unconfirmed");
      log.error("auth.anon_sign_in_fail", errInfo(error));
      throw error;
    })().finally(() => {
      inflightAuth = null;
    });
  }
  const shared = inflightAuth;
  const wait = await runClientMutation({
    attempt: async () => {
      try {
        return {
          kind: "confirmed" as const,
          value: await shared,
        };
      } catch (error) {
        return { kind: "rejected" as const, error };
      }
    },
    signal,
  });
  if (wait.kind === "confirmed") return wait.value;
  throw wait.kind === "rejected"
    ? wait.error
    : new Error(
        wait.kind === "aborted"
          ? "auth_anon_sign_in_aborted"
          : "auth_anon_sign_in_unconfirmed",
      );
}
