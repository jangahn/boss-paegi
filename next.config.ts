import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "*.fal.media" },
      { protocol: "https", hostname: "fal.media" },
      { protocol: "https", hostname: "*.supabase.co" },
    ],
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
