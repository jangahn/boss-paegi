import { ViewTransition } from "react";
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { SERVICE_NAME } from "@/lib/policy";
import { SessionBootstrap } from "@/components/SessionBootstrap";
import { MemberHintSync } from "@/components/MemberHintSync";
import { SupabasePreconnect } from "@/components/SupabasePreconnect";
import { AnalyticsVisitTracker } from "@/components/AnalyticsVisitTracker";
import { AppNav } from "@/components/AppNav";
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
  getBusinessInfo,
} from "@/lib/config/getters";
import { creditsConfig } from "@/lib/config/domains/growth";
import { SiteContentProvider } from "@/components/SiteContentProvider";
import { SiteFooter } from "@/components/SiteFooter";
import { MediaAssetsProvider } from "@/components/MediaAssetsProvider";
import { EventBannersProvider } from "@/components/events/EventBannersProvider";
import { NAV_TRANSITION, PLAY_TRANSITION } from "@/lib/view-transition";
import { getEventBannerSnapshot } from "@/lib/events/banner-snapshot-server";
import { getMediaAssetUrls, resolveOgImages } from "@/lib/site-assets";
import { JsonLd } from "@/components/JsonLd";
import { SITE_URL } from "@/lib/site";
import { MEMBER_HINT_STYLE, memberHintCookieName, memberHintInlineScript } from "@/lib/member-hint";
import { PAGE_LOADING_STYLE } from "@/lib/page-loading";

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
    // iOS Safari 데이터 디텍터 차단 — 푸터의 사업자등록번호·전화번호를 <a href="tel:"> 로
    // 감싸 SSR HTML 과 달라지며 hydration 오류(8월 iOS 73건, 리플레이 DOM 원본으로 확정)를
    // 내던 것. 화면 변화 없음(탭-통화 자동링크만 사라짐).
    formatDetection: { telephone: false, address: false, email: false, date: false },
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
  themeColor: "#f7ebdb",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  // 마케팅 카피 + 롤 콘텐츠 + 점수 등급을 서버에서 1회 읽어 클라 컨텍스트로 주입(클라 fetch 불필요·코드 기본값 폴백).
  const [marketingCopy, roleConfig, scoreConfig, sessionLimits, growthLevers, badgeCatalog, siteContent, businessInfo, mediaAssets, eventBanners] =
    await Promise.all([
      getMarketingCopy(),
      getRoleConfig(),
      getScoreConfig(),
      getSessionLimits(),
      getGrowthLevers(),
      getBadgeCatalog(),
      getSiteContent(),
      getBusinessInfo(),
      getMediaAssetUrls(),
      // 공지 배너 서버 HTML 스냅샷(v1.62) — 캐시(태그 events + 1시간), 실패하면 빈 스냅샷.
      getEventBannerSnapshot(),
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
  // 공개 env 가 없는 빌드(CI)에서는 null — 힌트 스크립트 없이 렌더한다.
  const memberHintCookie = memberHintCookieName();
  return (
    // suppressHydrationWarning: 아래 인라인 스크립트가 hydrate 전에 <html data-member-hint> 를 달 수 있다(이 요소의 속성만 해당).
    <html lang="ko" className="h-full antialiased" suppressHydrationWarning>
      <head>
        {/* 로딩 중 푸터 숨김(v1.60) — 로딩 상태(스켈레톤, 스피너)인 동안 사업자 정보 푸터를 빼 본문이 올 때 푸터가 밀리지 않게 한다(lib/page-loading.ts). */}
        <style dangerouslySetInnerHTML={{ __html: PAGE_LOADING_STYLE }} />
        {/* 회원 힌트(v1.51) — 첫 페인트 전에 세션 쿠키로 회원 여부를 판별해 정적 HTML 의 두 상태 중 맞는 쪽을 보이게 한다(lib/member-hint.ts). */}
        {/* 표시 규칙은 스타일시트가 아니라 HTML 에 싣는다 — CSS 빌드·캐시와 무관해야 한다(v1.52, lib/member-hint.ts MEMBER_HINT_STYLE). */}
        <style dangerouslySetInnerHTML={{ __html: MEMBER_HINT_STYLE }} />
        {memberHintCookie !== null && (
          <script dangerouslySetInnerHTML={{ __html: memberHintInlineScript(memberHintCookie) }} />
        )}
      </head>
      <body className="min-h-full flex flex-col">
        <MemberHintSync />
        <SupabasePreconnect />
        <JsonLd data={jsonLd} />
        <SessionBootstrap>
          <AnalyticsVisitTracker />
          {/* 전역 내비 — root layout 에서 1회 렌더(내비 간 remount 제거). 라우트별 self-hide 는 AppNav 내부. */}
          <AppNav />
          <SiteContentProvider value={siteContent}>
          <MediaAssetsProvider value={{ logoUrl: mediaAssets.logoUrl }}>
          <EventBannersProvider value={eventBanners}>
          <MarketingCopyProvider value={marketingCopy}>
            <RoleContentProvider value={roleConfig}>
              <ScoreConfigProvider value={scoreConfig}>
                <SessionLimitsProvider value={sessionLimits}>
                  <CreditProductsProvider value={creditsConfig(growthLevers)}>
                    <BadgeCatalogProvider value={badgeCatalog}>
                      {/* 상단 메뉴 이동(nav) · 캐릭터로 게임 진입(play) 타입일 때만 본문을 짧게 교차(v1.65, lib/view-transition.ts · globals.css). 그 밖의 이동은 그대로. */}
                      <ViewTransition update={{ [NAV_TRANSITION]: "nav-fade", [PLAY_TRANSITION]: "nav-fade", default: "none" }} enter="none" exit="none" default="none">
                        {children}
                      </ViewTransition>
                      {/* 사업자정보 푸터 — PG 심사 요건(메인+결제페이지 상시 노출). 미설정 시 비노출. */}
                      <SiteFooter info={businessInfo.info} />
                    </BadgeCatalogProvider>
                  </CreditProductsProvider>
                </SessionLimitsProvider>
              </ScoreConfigProvider>
            </RoleContentProvider>
          </MarketingCopyProvider>
          </EventBannersProvider>
          </MediaAssetsProvider>
          </SiteContentProvider>
        </SessionBootstrap>
      </body>
    </html>
  );
}
