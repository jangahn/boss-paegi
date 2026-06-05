"use client";

import { useEffect } from "react";
import { ensureAuth } from "@/lib/auth-client";

/**
 * 앱 진입 시 익명 세션을 보장 (없으면 생성).
 * 어느 페이지에서든 supabase 쿼리를 바로 쓸 수 있게.
 */
export function SessionBootstrap() {
  useEffect(() => {
    ensureAuth().catch((e) => {
      console.warn("[auth] failed to bootstrap anonymous session:", e);
    });
  }, []);
  return null;
}
