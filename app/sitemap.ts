import type { MetadataRoute } from "next";
import { SITE_URL } from "@/lib/site";
import { getSitemapEvents } from "@/lib/events";

// 색인 대상 공개 페이지만. UGC·랭킹·갤러리·기록·게이트 경로는 제외(noindex/robots 로 통제).
// 소식: /news 목록 + 발행·노출윈도우 active·미삭제·noindex=false 인 /news/[id] 동적 등재.
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const events = await getSitemapEvents().catch(() => []);
  return [
    { url: `${SITE_URL}/`, changeFrequency: "weekly", priority: 1 },
    { url: `${SITE_URL}/faq`, changeFrequency: "monthly", priority: 0.8 },
    { url: `${SITE_URL}/play`, changeFrequency: "monthly", priority: 0.7 },
    { url: `${SITE_URL}/news`, changeFrequency: "daily", priority: 0.6 },
    { url: `${SITE_URL}/terms`, changeFrequency: "yearly", priority: 0.3 },
    { url: `${SITE_URL}/privacy`, changeFrequency: "yearly", priority: 0.3 },
    ...events.map((e) => ({
      url: `${SITE_URL}/news/${e.id}`,
      lastModified: new Date(e.updated_at),
      changeFrequency: "weekly" as const,
      priority: 0.5,
    })),
  ];
}
