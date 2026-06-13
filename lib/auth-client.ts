"use client";

import { createClient } from "@/lib/supabase/client";
import { log, errInfo } from "@/lib/log";

/**
 * 익명 세션 보장 — 없으면 signInAnonymously, 있으면 그대로 반환.
 * 첫 진입한 사용자가 가입 절차 없이 즉시 데이터 쓰고 읽을 수 있게 함.
 */
export async function ensureAuth() {
  const sb = createClient();
  const { data: existing } = await sb.auth.getSession();
  if (existing.session) return existing.session;

  const { data, error } = await sb.auth.signInAnonymously();
  if (error) {
    // 익명 로그인 실패 = 모든 데이터 읽기/쓰기 불가 — 치명적, 반드시 추적
    log.error("auth.anon_sign_in_fail", errInfo(error));
    throw error;
  }
  log.info("auth.anon_sign_in", { userId: data.session?.user.id });
  return data.session!;
}
