"use client";

import { createClient } from "@/lib/supabase/client";

/**
 * 익명 세션 보장 — 없으면 signInAnonymously, 있으면 그대로 반환.
 * 첫 진입한 사용자가 가입 절차 없이 즉시 데이터 쓰고 읽을 수 있게 함.
 */
export async function ensureAuth() {
  const sb = createClient();
  const { data: existing } = await sb.auth.getSession();
  if (existing.session) return existing.session;

  const { data, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return data.session!;
}
