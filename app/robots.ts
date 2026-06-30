import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// 색인 허용(출시 전 vercel.app). 게이트·API·관리자 경로는 크롤 제외.
// UGC per-id(/share·/doll·/history)는 noindex+SEO 가치 없음인데, 크롤되면 revalidate 페이지가 재생성돼
// ISR write 폭증(per-id ~1,178개 × 크롤러 반복 = 월 15만 write, Vercel 무료한도 임박) → 크롤 자체를 차단
// (색인 손실 0 — 어차피 noindex·sitemap 미등재). 랭킹/갤러리는 단일 페이지(per-id 아님)라 허용 유지.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/admin",
        "/api",
        "/generate",
        "/credits",
        "/account",
        "/login",
        "/signup",
        "/share",
        "/doll",
        "/history",
      ],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
