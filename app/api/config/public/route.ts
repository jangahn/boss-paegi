import { NextRequest, NextResponse } from "next/server";
import { buildPublicConfig } from "@/lib/config/public";

export const runtime = "nodejs";

/**
 * 공개 런타임 config — `?domain=gameplay|marketing`. surface 별 최소 projection 만 반환
 * (운영필드·inactive·hidden 제거는 도메인 entry.toPublic). 클라 게임/표시가 시작 시 1회 로드.
 */
export async function GET(req: NextRequest) {
  const surface = req.nextUrl.searchParams.get("domain");
  if (surface !== "gameplay" && surface !== "marketing") {
    return NextResponse.json({ error: "invalid_domain" }, { status: 400 });
  }
  const config = await buildPublicConfig(surface);
  return NextResponse.json({ config });
}
