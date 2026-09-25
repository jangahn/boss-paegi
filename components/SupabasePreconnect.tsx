"use client";

import { preconnect } from "react-dom";
import { PUBLIC_ENV } from "@/lib/env";

/**
 * Supabase 연결 미리 열기(v1.61) — 서버 HTML <head> 에 preconnect 를 실어, 하이드레이션 뒤 첫 API 요청(로그인 확인 · 랭킹 ·
 * 갤러리 등)의 DNS · TLS 왕복을 줄인다. supabase-js 의 fetch 는 자격 증명 없는 CORS 요청이라 crossOrigin="anonymous" 연결을 쓴다
 * (이미지 연결은 로고 preload 가 연다). 공개 env 가 없는 빌드(CI)에서는 아무것도 하지 않는다.
 */
export function SupabasePreconnect() {
  const url = PUBLIC_ENV.SUPABASE_URL;
  if (url) {
    try {
      preconnect(new URL(url).origin, { crossOrigin: "anonymous" });
    } catch {
      // 잘못된 URL — 힌트 없이 동작
    }
  }
  return null;
}
