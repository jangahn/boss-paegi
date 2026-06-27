import { NextResponse } from "next/server";

export const runtime = "nodejs";

/**
 * Deprecated — 가입 완료는 통합 엔드포인트 `POST /api/account/consent` 로 대체됨.
 * stale 탭(옛 JS)이 호출하면 410 + consent_required 로 통합 흐름으로 유도(즉시 404 대신).
 */
export async function POST() {
  return NextResponse.json({ error: "consent_required" }, { status: 410 });
}
