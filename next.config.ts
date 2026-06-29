import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  images: {
    // next/image 최적화 결과 캐시 하한(기본 60s 라 /_next/image 가 max-age=0 처럼 재검증) — 31일.
    minimumCacheTTL: 2678400,
    remotePatterns: [
      { protocol: "https", hostname: "*.fal.media" },
      { protocol: "https", hostname: "fal.media" },
      // Supabase Storage 만 — 호스트 전체 개방 대신 storage 경로로 제한.
      // 핵심: render(변환) 경로(로고 등 next/image 소비). object(원본)는 폴백/디버그용.
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/render/image/public/**" },
      { protocol: "https", hostname: "*.supabase.co", pathname: "/storage/v1/object/public/**" },
    ],
  },
  // 정적 public/ 이미지 장기 캐시 — Next 기본 `max-age=0, must-revalidate`(재방문마다 304 round-trip)가
  // 재방문 즉시 표시를 막던 진짜 원인. fade 제거 후 '빠른 표시'를 이 캐싱이 담당.
  async headers() {
    return [
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
