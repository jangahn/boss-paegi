import { NextResponse } from "next/server";
import { getActivePopupEvent, getActiveBanner } from "@/lib/events";
import { type EventView } from "@/lib/events/types";

export const runtime = "nodejs";

const slimBanner = (b: EventView | null) =>
  b ? { id: b.id, type: b.type, summary: b.summary } : null;

/**
 * 공개 — 현재 활성 팝업 1건 + 지면별(홈·갤러리·랭킹) 배너 각 1건(슬림 DTO). anon 포함 누구나(/api 는 proxy 예외).
 * lib/events 의 unstable_cache(60s·tag 'events') 백킹 + 발행/수정/삭제 시 revalidateTag 로 즉시 갱신.
 * 본문(body)·커버 경로는 노출 안 함 — 상세는 /news/[id] 로.
 */
export async function GET() {
  const [popup, home, gallery, leaderboard] = await Promise.all([
    getActivePopupEvent(),
    getActiveBanner("home"),
    getActiveBanner("gallery"),
    getActiveBanner("leaderboard"),
  ]);
  return NextResponse.json(
    {
      popup: popup
        ? { id: popup.id, type: popup.type, title: popup.title, summary: popup.summary, popupDismissDays: popup.popup_dismiss_days }
        : null,
      banners: {
        home: slimBanner(home),
        gallery: slimBanner(gallery),
        leaderboard: slimBanner(leaderboard),
      },
    },
    { headers: { "Cache-Control": "public, s-maxage=30, stale-while-revalidate=60" } }
  );
}
