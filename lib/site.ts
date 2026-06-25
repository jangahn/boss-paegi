// 사이트 절대 URL — env(NEXT_PUBLIC_SITE_URL) 우선, 없으면 Vercel 배포 도메인.
// 도메인 구입 시 Vercel 환경변수 NEXT_PUBLIC_SITE_URL 만 교체하면 metadataBase·sitemap·robots·JSON-LD·OG 가 일괄 전환.
export const SITE_URL = (
  process.env.NEXT_PUBLIC_SITE_URL ?? "https://boss-paegi.vercel.app"
).replace(/\/+$/, "");

/** 절대 URL 생성. */
export function abs(path = "/"): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}
