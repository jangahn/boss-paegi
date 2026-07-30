import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";
import {
  API_NO_STORE_HEADERS,
  GLOBAL_SECURITY_HEADERS,
} from "./lib/security-headers.ts";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  images: {
    // next/image 최적화 결과 캐시 하한(기본 60s 라 /_next/image 가 max-age=0 처럼 재검증) — 31일.
    minimumCacheTTL: 2678400,
    // 공개 config 로 바뀌는 원격 로고는 이미 Supabase에서 640px로 변환된 자산이라
    // <Image unoptimized>로 직접 전달한다. 멀티테넌트 fal.media/*.supabase.co를
    // /_next/image allowlist에 넣으면 누구나 타 계정 URL을 Vercel 비용으로 변환할 수 있다.
    remotePatterns: [],
    // 직접 /_next/image 호출도 서비스가 가진 단일 정적 fallback만, query 없이 허용.
    localPatterns: [
      {
        pathname: "/logo.png",
        search: "",
      },
    ],
    qualities: [75],
    // 현재 허용된 원격 원본은 없으며, 향후 추가돼도 redirect로 allowlist 밖을
    // 따라가지 않게 기본(3회)보다 엄격하게 닫는다.
    maximumRedirects: 0,
  },
  // 정적 public/ 이미지 장기 캐시 — Next 기본 `max-age=0, must-revalidate`(재방문마다 304 round-trip)가
  // 재방문 즉시 표시를 막던 진짜 원인. fade 제거 후 '빠른 표시'를 이 캐싱이 담당.
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [...GLOBAL_SECURITY_HEADERS],
      },
      {
        // 새 API가 route-local header를 빠뜨려도 회원/어드민/결제/서명 URL
        // 응답이 공유 캐시에 들어가지 않는 전역 fail-closed 기본값.
        source: "/api/:path*",
        headers: [...API_NO_STORE_HEADERS],
      },
      {
        // 게임/기본 자산(경로 고정·거의 불변) → 1년 immutable. ⚠ 교체 시 파일명 변경 필요(경로 고정이라 캐시 안 깸).
        source: "/:dir(sprites|bg|avatars)/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=31536000, immutable" }],
      },
      {
        // 브랜딩·PWA 아이콘(교체 가능) → 1일(즉시성 vs 캐시 타협, immutable 풋건 회피).
        source: "/icons/:path*",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
      {
        source: "/:file(logo|og-default|icon-192|icon-512).png",
        headers: [{ key: "Cache-Control", value: "public, max-age=86400" }],
      },
    ];
  },
  // dev mode 에서 LAN IP 로 접속 허용 (핸드폰 → http://<mac LAN IP>:3100).
  // 없으면 cross-origin 차단으로 HMR/runtime asset fetch 실패 → React state 안 갱신 → 클릭은 들어가지만 setState 무효.
  allowedDevOrigins: [
    "192.168.45.*",
    "192.168.0.*",
    "192.168.1.*",
    "10.0.0.*",
    "172.16.*",
  ],
};

// Sentry 래핑 — 소스맵 업로드(authToken/org/project 있을 때만) + 광고차단 우회 터널.
// 빌드 시 env 없으면 업로드만 스킵하고 빌드는 정상 진행.
export default withSentryConfig(nextConfig, {
  org: process.env.SENTRY_ORG,
  project: process.env.SENTRY_PROJECT,
  authToken: process.env.SENTRY_AUTH_TOKEN,
  // 브라우저 → Sentry 전송을 자기 도메인(/monitoring)으로 프록시 (애드블록 우회).
  tunnelRoute: "/monitoring",
  silent: !process.env.CI,
});
