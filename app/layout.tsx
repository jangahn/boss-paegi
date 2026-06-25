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
import { JsonLd } from "@/components/JsonLd";
import { SITE_URL } from "@/lib/site";

export async function generateMetadata(): Promise<Metadata> {
  const sc = await getSiteContent();
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
    openGraph: {
      title: SERVICE_NAME,
      description: sc.definition,
      siteName: SERVICE_NAME,
      url: SITE_URL,
      locale: "ko_KR",
      type: "website",
    },
    twitter: { card: "summary_large_image", title: SERVICE_NAME, description: sc.definition },
  };
}

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
  const [marketingCopy, roleConfig, scoreConfig, sessionLimits, growthLevers, badgeCatalog, siteContent] =
    await Promise.all([
      getMarketingCopy(),
      getRoleConfig(),
      getScoreConfig(),
      getSessionLimits(),
      getGrowthLevers(),
      getBadgeCatalog(),
      getSiteContent(),
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
        </SiteContentProvider>
      </body>
    </html>
  );
}
