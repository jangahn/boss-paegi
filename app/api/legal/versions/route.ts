import "server-only";
import { NextResponse } from "next/server";
import { getCurrentLegalVersionsStrict } from "@/lib/legal/strict-versions";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 공개 — 현재 약관·방침 발행본 **버전 정수만**(`{terms,privacy}`). 본문/구조는 노출하지 않으므로
 * legal_documents service-role-only 정책 위배가 아니다. 클라 `getMyProfile` 이 member 버전과 비교해
 * consent_incomplete 판정. 미래 예약본은 별도 publish 요청 없이 KST 자정에 활성화되므로 브라우저와
 * CDN 모두 no-store다. 어떤 재검증 유예 창도 시행 후 v1을 허용하지 않는다.
 */
export async function GET() {
  try {
    const versions = await getCurrentLegalVersionsStrict();
    return NextResponse.json(versions, {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "CDN-Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    });
  } catch (error) {
    log.warn("legal.versions_unavailable", errInfo(error));
    return NextResponse.json(
      { error: "legal_versions_unavailable" },
      {
        status: 503,
        headers: {
          "Cache-Control": "no-store",
          "Vercel-CDN-Cache-Control": "no-store",
        },
      },
    );
  }
}
