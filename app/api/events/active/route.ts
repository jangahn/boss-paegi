import { NextResponse } from "next/server";
import { getActiveEventSurfaces } from "@/lib/events";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 20;

/**
 * 공개 — 현재 활성 팝업 1건 + 지면별(홈·갤러리·랭킹) 배너 각 1건(슬림 DTO). anon 포함 누구나(/api 는 proxy 예외).
 * 단일 service_role RPC의 한 MVCC snapshot에서 4지면과 다음 예약 경계를
 * 함께 고른다. 본문(body)·커버 경로는 DB RPC 단계부터 노출하지 않는다.
 */
export async function GET() {
  const snapshot = await getActiveEventSurfaces();
  return NextResponse.json(
    snapshot,
    {
      headers: {
        // starts_at/ends_at 1ms 경계를 공유 cache TTL로 양자화하지 않는다.
        // 클라이언트는 nextTransitionAt에 현재 snapshot을 먼저 폐기한 뒤
        // 동일 endpoint를 다시 조회한다.
        "Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    },
  );
}
