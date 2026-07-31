import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import { parseLeaderboardRows } from "@/lib/leaderboard-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * 공개 랭킹 API — **쿠키/세션 비의존**(public).
 * 데이터는 전부 공개(닉네임·점수·아바타)이므로 admin client 로 RLS 우회 호출.
 * 닉네임/아바타 격리·탈퇴가 즉시 반영되어야 하므로 모든 공유 캐시를 금지한다.
 */
export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("period");
  const period =
    raw === "weekly" ? "weekly" : raw === "monthly" ? "monthly" : "daily"; // allowlist (기본 daily)

  const admin = createAdminClient();
  let result: Awaited<ReturnType<typeof admin.rpc>>;
  try {
    result = await admin.rpc("get_leaderboard", {
      period,
      max_limit: 10,
    });
  } catch (error) {
    log.warn("leaderboard.api_query_fail", { period, ...errInfo(error) });
    return NextResponse.json(
      { error: "leaderboard_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  const { data, error } = result;
  if (error) {
    log.warn("leaderboard.api_query_fail", { period, ...errInfo(error) });
    // 에러도 no-store — transient 실패가 브라우저/CDN에 고정되지 않게 한다.
    return NextResponse.json(
      { error: "leaderboard_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
  const rows = parseLeaderboardRows(data);
  if (!rows) {
    log.error("leaderboard.api_invalid_response", {
      period,
      payloadType: Array.isArray(data) ? "array" : typeof data,
    });
    return NextResponse.json(
      { error: "leaderboard_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }

  return NextResponse.json(
    { rows },
    {
      headers: {
        "Cache-Control": "private, no-store, max-age=0",
        "CDN-Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "no-store",
      },
    }
  );
}
