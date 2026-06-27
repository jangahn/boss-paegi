import "server-only";
import { NextResponse } from "next/server";
import { getCurrentLegalVersions } from "@/lib/legal";

export const runtime = "nodejs";

/**
 * 공개 — 현재 약관·방침 발행본 **버전 정수만**(`{terms,privacy}`). 본문/구조는 노출하지 않으므로
 * legal_documents service-role-only 정책 위배가 아니다. 클라 `getMyProfile` 이 member 버전과 비교해
 * consent_incomplete 판정. 캐시: 브라우저 no-store(항상 CDN 경유), CDN 60s(+swr) → 서버 게이트(즉시)보다
 * 클라 전파는 최대 60s 지연(그 사이 member 액션은 서버 requireMember 가 즉시 consent_required 로 차단).
 */
export async function GET() {
  const versions = await getCurrentLegalVersions();
  return NextResponse.json(versions, {
    headers: {
      "Cache-Control": "no-store",
      "Vercel-CDN-Cache-Control": "max-age=60, stale-while-revalidate=300",
    },
  });
}
