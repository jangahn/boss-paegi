import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SERVICE_NAME } from "@/lib/policy";
import { SessionBootstrap } from "@/components/SessionBootstrap";
import { MarketingCopyProvider } from "@/components/MarketingCopyProvider";
import { RoleContentProvider } from "@/components/RoleContentProvider";
import { ScoreConfigProvider } from "@/components/ScoreConfigProvider";
import { SessionLimitsProvider } from "@/components/SessionLimitsProvider";
import {
  getMarketingCopy,
  getRoleConfig,
  getScoreConfig,
  getSessionLimits,
} from "@/lib/config/getters";

export const metadata: Metadata = {
  title: `${SERVICE_NAME} — 직장인 스트레스 해소 게임`,
  description:
    "사진 한 장으로 만드는 나만의 부장님 인형. 캐주얼하게 스트레스 한 방에 풀자.",
  applicationName: SERVICE_NAME,
  openGraph: {
    title: SERVICE_NAME,
    description: "사진 한 장으로 만드는 나만의 부장님 인형.",
    locale: "ko_KR",
    type: "website",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#ffffff" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 마케팅 카피 + 롤 콘텐츠 + 점수 등급을 서버에서 1회 읽어 클라 컨텍스트로 주입(클라 fetch 불필요·코드 기본값 폴백).
  const [marketingCopy, roleConfig, scoreConfig, sessionLimits] = await Promise.all([
    getMarketingCopy(),
    getRoleConfig(),
    getScoreConfig(),
    getSessionLimits(),
  ]);
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <SessionBootstrap />
        <MarketingCopyProvider value={marketingCopy}>
          <RoleContentProvider value={roleConfig}>
            <ScoreConfigProvider value={scoreConfig}>
              <SessionLimitsProvider value={sessionLimits}>
                {children}
              </SessionLimitsProvider>
            </ScoreConfigProvider>
          </RoleContentProvider>
        </MarketingCopyProvider>
      </body>
    </html>
  );
}
