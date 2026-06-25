import { ImageResponse } from "next/og";
import { getSiteContent } from "@/lib/config/getters";
import { SERVICE_NAME } from "@/lib/policy";

export const runtime = "nodejs";
export const revalidate = 3600;
export const alt = SERVICE_NAME;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

// 로고 없이 텍스트 기반 루트 OG — 서비스명 + 한 줄 정의(config). 공유·검색 카드용.
export default async function OgImage() {
  const sc = await getSiteContent();
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: "80px 96px",
          background: "linear-gradient(135deg, #18181b 0%, #3f3f46 100%)",
          color: "#fafafa",
        }}
      >
        <div style={{ display: "flex", fontSize: 40, fontWeight: 800, color: "#f59e0b" }}>👊 {SERVICE_NAME}</div>
        <div style={{ display: "flex", fontSize: 60, fontWeight: 900, lineHeight: 1.2, marginTop: 28, letterSpacing: "-0.03em" }}>
          {sc.definition}
        </div>
        <div style={{ display: "flex", fontSize: 30, color: "#a1a1aa", marginTop: 28 }}>
          설치 없이 웹에서 바로 · 만 14세 이상 · 무료 플레이
        </div>
      </div>
    ),
    { ...size }
  );
}
