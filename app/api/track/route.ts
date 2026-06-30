import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { PUBLIC_ENV } from "@/lib/env";
import { sanitizeTrackPayload, type MemberState } from "@/lib/analytics/core";
import { recordTrackEvent, memberStateFromUser } from "@/lib/analytics/server";

export const runtime = "nodejs";

// 공유·유입 분석 수집 — **공개**(anon 허용·requireAdmin/Member 아님). 성공/드롭 모두 204 + no-store.
// 무PII: 식별자/원본 URL/query/IP/UA 미저장. 클라 값 불신 — sanitize(core) + member_state 서버 판정.
const MAX_BYTES = 4096;
const HEADERS = { "Cache-Control": "no-store" } as const;
function noContent() {
  return new NextResponse(null, { status: 204, headers: HEADERS });
}

/** 과엄격 방지: Origin 있으면 host 검사 / 없으면 Referer host / 둘 다 없으면 통과(sendBeacon·Safari 빈 헤더). */
function originAllowed(req: NextRequest): boolean {
  let siteHost = "";
  try {
    siteHost = new URL(PUBLIC_ENV.SITE_URL).host;
  } catch {
    /* ignore */
  }
  const selfHost = req.nextUrl.host; // 배포 호스트(production/preview/dev 자동 허용)
  const hostOf = (v: string | null): string | null => {
    if (!v) return null;
    try {
      return new URL(v).host;
    } catch {
      return null;
    }
  };
  const origin = req.headers.get("origin");
  if (origin !== null) {
    const h = hostOf(origin);
    return h !== null && (h === selfHost || h === siteHost);
  }
  const ref = hostOf(req.headers.get("referer"));
  if (ref !== null) return ref === selfHost || ref === siteHost;
  return true; // Origin/Referer 모두 없음 — strict validation + 무PII 로 방어
}

export async function POST(req: NextRequest) {
  if (!originAllowed(req)) return noContent();

  let text: string;
  try {
    text = await req.text();
  } catch {
    return noContent();
  }
  if (text.length > MAX_BYTES) return noContent();

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return noContent();
  }

  const row = sanitizeTrackPayload(raw);
  if (!row) return noContent();

  // member_state — Supabase auth session 기준(member_accounts 조회 안 함, 도메인 격리).
  let memberState: MemberState = "anon";
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    memberState = memberStateFromUser(user);
  } catch {
    /* 세션 조회 실패 → anon 취급 */
  }

  await recordTrackEvent(row, memberState); // best-effort
  return noContent();
}
