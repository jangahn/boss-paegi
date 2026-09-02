import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { readCurrentAuthSessionState } from "@/lib/auth-session-live";
import { PUBLIC_ENV } from "@/lib/env";
import { isTrackableUserAgent, sanitizeTrackPayload, type MemberState } from "@/lib/analytics/core";
import { recordTrackEvent, memberStateFromUser } from "@/lib/analytics/server";
import { recordUserVisitDay } from "@/lib/user-visit-days";
import {
  readTrackJsonRequest,
} from "@/lib/analytics/request-boundary";
import { publicWriteNetworkActorKey } from "@/lib/public-write-quota";

export const runtime = "nodejs";

// 공유·유입 분석 수집 — **공개**(anon 허용·requireAdmin/Member 아님). 성공/드롭 모두 204 + no-store.
// 무PII: 식별자/원본 URL/query/IP/UA 미저장. 클라 값 불신 — sanitize(core) + member_state 서버 판정.
// v1.17: 방문(visit)은 별도로 user_visit_days 에 세션 uid·KST 일자만 남긴다(대시보드 유저 퍼널·구성 — analytics 행과 무결합).
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
  // 봇 게이트(v1.08) — UA 는 판별에만 사용·미저장(무PII 불변). 무UA(비브라우저 클라이언트)도 드롭.
  if (!isTrackableUserAgent(req.headers.get("user-agent"))) return noContent();
  if (!originAllowed(req)) return noContent();
  const raw = await readTrackJsonRequest(req);
  if (raw === null) return noContent();

  const row = sanitizeTrackPayload(raw);
  if (!row) return noContent();

  // member_state — Supabase auth session 기준(member_accounts 조회 안 함, 도메인 격리).
  let memberState: MemberState = "anon";
  let visitUserId: string | null = null;
  try {
    const supabase = await createClient();
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (user) {
      const sessionState = await readCurrentAuthSessionState(() =>
        supabase.rpc("oauth_current_auth_session_live"),
      );
      if (sessionState.kind === "live") {
        memberState = memberStateFromUser(user);
        visitUserId = user.id;
      }
    }
  } catch {
    /* 세션 조회 실패 → anon 취급 */
  }

  // This best-effort endpoint deliberately performs no unbounded membership
  // DB read before quota. Network HMAC therefore applies to every track event;
  // an anonymous/pre-consent Auth UUID can never mint fresh actor buckets.
  const actorKey = publicWriteNetworkActorKey(req.headers);
  if (!actorKey) return noContent();
  await recordTrackEvent(row, memberState, actorKey); // bounded best-effort
  // 상호작용·봇 게이트를 지난 방문만 여기 도달 — 유저 단위 방문일(PK 로 1행/일, 멱등). 세션 없으면 기록 없음.
  if (row.kind === "visit" && visitUserId) await recordUserVisitDay(visitUserId);
  return noContent();
}
