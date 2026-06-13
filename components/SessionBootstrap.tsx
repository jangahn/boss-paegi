"use client";

import { useEffect } from "react";
import { ensureAuth } from "@/lib/auth-client";

/**
 * 앱 진입 시 익명 세션을 보장 (없으면 생성).
 * 어느 페이지에서든 supabase 쿼리를 바로 쓸 수 있게.
 */
export function SessionBootstrap() {
  useEffect(() => {
    // ensureAuth() 가 실패 시 이미 log.error("auth.anon_sign_in_fail") 를 남기므로
    // 여기서 또 로깅하면 같은 사건이 두 줄(레벨·포맷 불일치)로 갈린다 → 침묵.
    ensureAuth().catch(() => {});
  }, []);
  return null;
}
