"use client";

import type { Session } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/client";
import { log, errInfo } from "@/lib/log";

// 진행 중 익명 로그인 1건만 공유 — SessionBootstrap·AccountMenu·ConsentGuard 등이 첫 진입에
// 동시에 ensureAuth() 를 호출해도 signInAnonymously 가 한 번만 일어나게(익명 유저 다중 생성 race 방지).
let inflightAnon: Promise<Session> | null = null;

/**
 * 익명 세션 보장 — 없으면 signInAnonymously, 있으면 그대로 반환. 동시 호출 안전(in-flight 합류).
 * 첫 진입한 사용자가 가입 절차 없이 즉시 데이터 쓰고 읽을 수 있게 함.
 */
export async function ensureAuth(): Promise<Session> {
  const sb = createClient();
  const { data: existing } = await sb.auth.getSession();
  if (existing.session) return existing.session;

  if (!inflightAnon) {
    inflightAnon = sb.auth
      .signInAnonymously()
      .then(({ data, error }) => {
        if (error) {
          // 익명 로그인 실패 = 모든 데이터 읽기/쓰기 불가 — 치명적, 반드시 추적
          log.error("auth.anon_sign_in_fail", errInfo(error));
          throw error;
        }
        log.info("auth.anon_sign_in", { userId: data.session?.user.id });
        return data.session!;
      })
      .finally(() => {
        inflightAnon = null;
      });
  }
  return inflightAnon;
}
