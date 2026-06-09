import type { NextConfig } from "next";

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

export default nextConfig;
