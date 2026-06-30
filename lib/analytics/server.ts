import "server-only";

// 공유·유입 분석 — 서버 적재(service_role insert, best-effort). 비즈니스 동작을 절대 막지 않음(실패는 log만).
// /api/track(visit|share) + 점수제출/가입(conversion) 에서 사용. member_state 는 서버에서 결정해 전달.

import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import {
  buildConversionRow,
  type TrackRow,
  type ConversionStep,
  type RawSource,
  type MemberState,
} from "@/lib/analytics/core";

/** Supabase auth session 기준 member 판별(member_accounts 조회 안 함 — 도메인 격리). */
export function memberStateFromUser(user: { is_anonymous?: boolean } | null | undefined): MemberState {
  return user && !user.is_anonymous ? "member" : "anon";
}

async function insertEvent(row: Record<string, unknown>): Promise<void> {
  try {
    const admin = createAdminClient();
    const { error } = await admin.from("analytics_events").insert(row);
    if (error) log.warn("analytics.insert_fail", { kind: row.kind, ...errInfo(error) });
  } catch (e) {
    log.warn("analytics.insert_error", { kind: row.kind, ...errInfo(e) });
  }
}

/** /api/track 의 visit|share 적재. member_state 는 서버 세션으로 결정. */
export async function recordTrackEvent(row: TrackRow, memberState: MemberState): Promise<void> {
  await insertEvent({ ...row, member_state: memberState });
}

/** 점수제출/가입 시 conversion 적재(first-touch source·무효 시 direct fallback). best-effort. */
export async function recordConversion(
  step: ConversionStep,
  rawSource: RawSource | null | undefined,
  memberState: MemberState
): Promise<void> {
  await insertEvent({ ...buildConversionRow(step, rawSource), member_state: memberState });
}
