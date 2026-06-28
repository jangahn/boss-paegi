import { NextResponse } from "next/server";
import { getActivePopupEvent, getActiveBannerEvent } from "@/lib/events";

export const runtime = "nodejs";

/**
 * 공개 — 현재 활성 팝업·배너 각 1건(슬림 DTO). anon 포함 누구나(/api 는 proxy 게이트 예외).
 * 데이터는 lib/events 의 unstable_cache(60s·tag 'events') 백킹 + 발행 시 revalidateTag 로 즉시 갱신.
 * 본문(body)·커버 경로는 노출 안 함 — 상세는 /news/[id] 로.
 */
export async function GET() {
  const [popup, banner] = await Promise.all([getActivePopupEvent(), getActiveBannerEvent()]);
  return NextResponse.json(
    {
      popup: popup
        ? { id: popup.id, type: popup.type, title: popup.title, summary: popup.summary, popupDismissDays: popup.popup_dismiss_days }
        : null,
      banner: banner ? { id: banner.id, type: banner.type, summary: banner.summary } : null,
    },
    { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } }
  );
}
