import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SERVICE_NAME } from "@/lib/policy";
import { SessionBootstrap } from "@/components/SessionBootstrap";
import { MarketingCopyProvider } from "@/components/MarketingCopyProvider";
import { RoleContentProvider } from "@/components/RoleContentProvider";
import { ScoreConfigProvider } from "@/components/ScoreConfigProvider";
import { SessionLimitsProvider } from "@/components/SessionLimitsProvider";
import { CreditProductsProvider } from "@/components/CreditProductsProvider";
import { BadgeCatalogProvider } from "@/components/BadgeCatalogProvider";
import {
  getMarketingCopy,
  getRoleConfig,
  getScoreConfig,
  getSessionLimits,
  getGrowthLevers,
  getBadgeCatalog,
  getSiteContent,
} from "@/lib/config/getters";
import { activeCreditProducts } from "@/lib/config/domains/growth";
import { SiteContentProvider } from "@/components/SiteContentProvider";
import { MediaAssetsProvider } from "@/components/MediaAssetsProvider";
import { getMediaAssetUrls, resolveOgImages } from "@/lib/site-assets";
import { JsonLd } from "@/components/JsonLd";
import { SITE_URL } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const sc = await getSiteContent();
  // OG/twitter 이미지를 명시(파일-기반 컨벤션 미사용). 우선순위 media_config 기본 OG > 정적 default.
  const ogImages = await resolveOgImages();
  return {
    metadataBase: new URL(SITE_URL),
    title: {
      default: `${SERVICE_NAME} — 직장인 스트레스 해소 게임`,
      template: `%s · ${SERVICE_NAME}`,
    },
    description: sc.metaDescription,
    applicationName: SERVICE_NAME,
    keywords: sc.keywords,
    alternates: { canonical: "/" },
    // 검색엔진 소유확인(메타태그 방식). 토큰은 비밀 아님(공개 HTML 렌더) — 코드에 고정.
    verification: {
      google: "lFpQQH8GbI-gtGbDbWuHYkrHngToMMWUT294pxdm3MY",
      other: { "naver-site-verification": "a864d35c73a0565ade6dad4a878659916ca9a832" },
    },
    openGraph: {
      title: SERVICE_NAME,
      description: sc.definition,
      siteName: SERVICE_NAME,
      url: SITE_URL,
      locale: "ko_KR",
      type: "website",
      images: ogImages,
    },
    twitter: { card: "summary_large_image", title: SERVICE_NAME, description: sc.definition, images: ogImages },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: "#f7ebdb",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 마케팅 카피 + 롤 콘텐츠 + 점수 등급을 서버에서 1회 읽어 클라 컨텍스트로 주입(클라 fetch 불필요·코드 기본값 폴백).
  const [marketingCopy, roleConfig, scoreConfig, sessionLimits, growthLevers, badgeCatalog, siteContent, mediaAssets] =
    await Promise.all([
      getMarketingCopy(),
      getRoleConfig(),
      getScoreConfig(),
      getSessionLimits(),
      getGrowthLevers(),
      getBadgeCatalog(),
      getSiteContent(),
      getMediaAssetUrls(),
    ]);
  const jsonLd = [
    { "@context": "https://schema.org", "@type": "WebSite", name: SERVICE_NAME, url: SITE_URL, inLanguage: "ko-KR", description: siteContent.definition },
    { "@context": "https://schema.org", "@type": "Organization", name: SERVICE_NAME, url: SITE_URL },
    {
      "@context": "https://schema.org",
      "@type": "VideoGame",
      name: SERVICE_NAME,
      url: SITE_URL,
      description: siteContent.definition,
      inLanguage: "ko-KR",
      genre: ["캐주얼", "아케이드"],
      gamePlatform: "Web browser",
      operatingSystem: "Web",
      applicationCategory: "GameApplication",
      offers: { "@type": "Offer", price: "0", priceCurrency: "KRW" },
    },
  ];
  return (
    <html lang="ko" className="h-full antialiased">
      <body className="min-h-full flex flex-col">
        <JsonLd data={jsonLd} />
        <SessionBootstrap />
        <SiteContentProvider value={siteContent}>
        <MediaAssetsProvider value={{ logoUrl: mediaAssets.logoUrl }}>
        <MarketingCopyProvider value={marketingCopy}>
          <RoleContentProvider value={roleConfig}>
            <ScoreConfigProvider value={scoreConfig}>
              <SessionLimitsProvider value={sessionLimits}>
                <CreditProductsProvider value={activeCreditProducts(growthLevers)}>
                  <BadgeCatalogProvider value={badgeCatalog}>
                    {children}
                  </BadgeCatalogProvider>
                </CreditProductsProvider>
              </SessionLimitsProvider>
            </ScoreConfigProvider>
          </RoleContentProvider>
        </MarketingCopyProvider>
        </MediaAssetsProvider>
        </SiteContentProvider>
      </body>
    </html>
  );
}
