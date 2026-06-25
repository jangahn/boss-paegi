import { getSiteContent } from "@/lib/config/getters";
import { SITE_URL } from "@/lib/site";
import { SERVICE_NAME } from "@/lib/policy";

export const runtime = "nodejs";

// GEO(생성형 엔진 최적화) — LLM 이 서비스를 정확히 이해·인용하도록 정의·핵심 페이지·FAQ 를 평문 제공.
export async function GET() {
  const sc = await getSiteContent();
  const faq = sc.faq.map((f) => `### ${f.q}\n${f.a}`).join("\n\n");
  const body = `# ${SERVICE_NAME}\n\n> ${sc.definition}\n\n${sc.intro}\n\n## 주요 페이지\n- 홈: ${SITE_URL}/\n- 소개·자주 묻는 질문: ${SITE_URL}/faq\n- 이용약관: ${SITE_URL}/terms\n- 개인정보처리방침: ${SITE_URL}/privacy\n\n## 자주 묻는 질문\n${faq}\n`;
  return new Response(body, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=3600, stale-while-revalidate=86400",
    },
  });
}
