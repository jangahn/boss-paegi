import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";

export const runtime = "nodejs";

/**
 * 공개 랭킹 API — **쿠키/세션 비의존**(public)이라 CDN 캐시 가능.
 * 데이터는 전부 공개(닉네임·점수·아바타)이므로 admin client 로 RLS 우회 호출.
 * 캐시: 브라우저는 no-store(항상 CDN 경유), Vercel Edge 만 30s 캐시(+swr) → 서울 PoP 서빙.
 */
export async function GET(req: NextRequest) {
  const raw = new URL(req.url).searchParams.get("period");
  const period =
    raw === "weekly" ? "weekly" : raw === "monthly" ? "monthly" : "daily"; // allowlist (기본 daily)

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_leaderboard", {
    period,
    max_limit: 10,
  });
  if (error) {
    log.warn("leaderboard.api_query_fail", { period, ...errInfo(error) });
    // 에러는 캐시하지 않음(no-store) — transient 에러가 30s 굳지 않게.
    return NextResponse.json(
      { rows: [] },
      { headers: { "Cache-Control": "no-store" } }
    );
  }

  return NextResponse.json(
    { rows: data ?? [] },
    {
      headers: {
        "Cache-Control": "no-store",
        "Vercel-CDN-Cache-Control": "max-age=30, stale-while-revalidate=300",
      },
    }
  );
}
