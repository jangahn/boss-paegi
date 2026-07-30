import "server-only";

// 공유·유입 분석 — 서버 적재(service_role insert, best-effort). 비즈니스 동작을 절대 막지 않음(실패는 log만).
// /api/track(visit|share) + 점수제출/가입(conversion) 에서 사용. member_state 는 서버에서 결정해 전달.

import { createAdminClient } from "@/lib/supabase/admin";
import { PUBLIC_ENV } from "@/lib/env";
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

export type PublicTrackAck =
  | { accepted: true }
  | {
      accepted: false;
      reason:
        | "actor_request_quota"
        | "global_request_quota"
        | "invalid_actor"
        | "quota_busy";
    };

type PublicTrackRpcResult = { data: unknown; error: unknown | null };
export type PublicTrackDependencies = {
  collectionEnabled: boolean;
  rpc: (args: Record<string, unknown>) => Promise<PublicTrackRpcResult>;
};

export function parsePublicTrackAck(value: unknown): PublicTrackAck | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const keys = Object.keys(row).sort();
  if (
    row.accepted === true &&
    keys.length === 1 &&
    keys[0] === "accepted"
  ) {
    return { accepted: true };
  }
  if (
    row.accepted === false &&
    keys.length === 2 &&
    keys[0] === "accepted" &&
    keys[1] === "reason" &&
    (
      row.reason === "actor_request_quota" ||
      row.reason === "global_request_quota" ||
      row.reason === "invalid_actor" ||
      row.reason === "quota_busy"
    )
  ) {
    return {
      accepted: false,
      reason: row.reason,
    };
  }
  return null;
}

async function recordBoundedAnalyticsEvent(
  row: TrackRow | ReturnType<typeof buildConversionRow>,
  memberState: MemberState,
  actorKey: string,
  dependencies?: PublicTrackDependencies,
): Promise<PublicTrackAck | null> {
  const collectionEnabled = dependencies
    ? dependencies.collectionEnabled
    : PUBLIC_ENV.ANALYTICS_ENABLED;
  if (!collectionEnabled) return null;

  const rpc =
    dependencies?.rpc ??
    (async (args: Record<string, unknown>): Promise<PublicTrackRpcResult> => {
      const admin = createAdminClient();
      return admin.rpc("record_public_analytics_event", args);
    });
  try {
    const result = await rpc({
      p_actor_key: actorKey,
      p_member_state: memberState,
      p_event: row,
    });
    if (result.error !== null && result.error !== undefined) {
      log.warn("analytics.insert_fail", {
        kind: row.kind,
        ...errInfo(result.error),
      });
      return null;
    }
    const ack = parsePublicTrackAck(result.data);
    if (!ack) {
      log.warn("analytics.insert_invalid_result", { kind: row.kind });
      return null;
    }
    // Quota exhaustion is an expected best-effort drop, not a Sentry/log event.
    return ack;
  } catch (e) {
    log.warn("analytics.insert_error", { kind: row.kind, ...errInfo(e) });
    return null;
  }
}

/** /api/track 의 visit|share 적재. member_state 는 서버 세션으로 결정. */
export async function recordTrackEvent(
  row: TrackRow,
  memberState: MemberState,
  actorKey: string,
  dependencies?: PublicTrackDependencies,
): Promise<PublicTrackAck | null> {
  return recordBoundedAnalyticsEvent(
    row,
    memberState,
    actorKey,
    dependencies,
  );
}

/** 점수제출/가입 conversion도 동일 원자 quota RPC로만 적재한다. */
export async function recordConversion(
  step: ConversionStep,
  rawSource: RawSource | null | undefined,
  memberState: MemberState,
  actorKey: string,
  dependencies?: PublicTrackDependencies,
): Promise<PublicTrackAck | null> {
  return recordBoundedAnalyticsEvent(
    buildConversionRow(step, rawSource),
    memberState,
    actorKey,
    dependencies,
  );
}
