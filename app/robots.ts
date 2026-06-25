import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";

// 색인 허용(출시 전 vercel.app). 게이트·API·관리자 경로는 크롤 제외.
// UGC(/share·/doll)·랭킹·갤러리·기록은 크롤 허용하되 페이지 메타 noindex 로 색인만 제외(crawler 가 noindex 를 보게).
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: ["/admin", "/api", "/generate", "/credits", "/account", "/login", "/signup"],
    },
    sitemap: `${SITE_URL}/sitemap.xml`,
    host: SITE_URL,
  };
}
