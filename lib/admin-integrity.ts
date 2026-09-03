import { normalizeFlagSignalShape } from "@/lib/integrity-signal-shape";
import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";
import {
  requireSupabaseOptionalData,
  requireSupabasePage,
  requireSupabaseRows,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { validateAdminRows } from "@/lib/admin-read-contract";

/**
 * 어드민 무결성(어뷰징) 큐·상세 조회 — server-only(requireAdmin 뒤에서만 호출).
 * 상태변경 조치는 admin_* RPC(0052), 여긴 읽기 전용.
 */

export const INTEGRITY_STATES = ["pending", "cleared", "voided", "all"] as const;
export type IntegrityState = (typeof INTEGRITY_STATES)[number];
export const INTEGRITY_PAGE_SIZE = 20;

export type IntegrityRow = {
  scoreId: string;
  ownerId: string;
  ownerName: string;
  score: number;
  reviewStatus: string;
  abuseScore: number;
  status: string;
  signalIds: string[];
  scoreCreatedAt: string;
  flaggedAt: string;
};

export type IntegrityQueuePage = {
  rows: IntegrityRow[];
  total: number;
  page: number;
  pageSize: number;
};

type ScoreJoinRow = {
  id: string;
  score: number;
  owner_id: string;
  review_status: string;
  created_at: string;
  profiles: { display_name: string | null } | null;
  score_flags: {
    abuse_score: number;
    status: string;
    signals: Array<{ id?: string }> | null;
    created_at: string;
  } | null;
};

function singleEmbed<T>(
  operation: string,
  value: T | T[] | null,
  schema: Parameters<typeof validateAdminRows>[2],
  required: boolean,
): T | null {
  const rows = value === null ? [] : Array.isArray(value) ? value : [value];
  const parsed = validateAdminRows<T>(operation, rows, schema);
  if (parsed.length > 1 || (required && parsed.length !== 1)) {
    throw new SupabaseOperationError(
      operation,
      new Error("missing_or_ambiguous_embed"),
    );
  }
  return parsed[0] ?? null;
}

export async function getIntegrityQueue(
  state: IntegrityState,
  page: number,
  ownerId?: string | null
): Promise<IntegrityQueuePage> {
  const admin = createAdminClient();
  const from = (page - 1) * INTEGRITY_PAGE_SIZE;
  const to = from + INTEGRITY_PAGE_SIZE - 1;
  // 큐 정렬은 최신 제출순 — UI 가 표시하는 날짜(scores.created_at)와 같은 키여야 순서가
  // 뒤섞여 보이지 않는다(수동/cron 플래그는 flag.created_at 이 제출보다 늦어 어긋남).
  // 그래서 base 를 scores 로 두고 정렬한다(PostgREST 는 임베드 컬럼 정렬 미보장).
  // 위험도(abuse_score)는 정렬키가 아니라 칩 표시용. id 는 페이지 경계 안정용 tiebreaker.
  let q = admin
    .from("scores")
    .select(
      "id, score, owner_id, review_status, created_at, profiles(display_name), score_flags!inner(abuse_score, status, signals, created_at)",
      { count: "exact" }
    );
  if (state !== "all") q = q.eq("score_flags.status", state);
  if (ownerId) q = q.eq("owner_id", ownerId); // 특정 유저 필터(?ownerId=)
  const pageResult = await requireSupabasePage(
    "integrity.queue",
    () =>
      q
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
      .range(from, to),
  );
  const data = validateAdminRows<
    Omit<ScoreJoinRow, "profiles" | "score_flags"> & {
      profiles:
        | { display_name: string | null }
        | { display_name: string | null }[]
        | null;
      score_flags:
        | {
            abuse_score: number;
            status: string;
            signals: Array<{ id?: string }> | null;
            created_at: string;
          }
        | Array<{
            abuse_score: number;
            status: string;
            signals: Array<{ id?: string }> | null;
            created_at: string;
          }>
        | null;
    }
  >("integrity.queue", pageResult.rows, {
    id: "uuid",
    score: "nonnegativeInteger",
    owner_id: "uuid",
    review_status: "string",
    created_at: "timestamp",
    profiles: "embed",
    score_flags: "embed",
  });
  const count = pageResult.count;

  const rows: IntegrityRow[] = data.map((r) => {
    const profile = singleEmbed(
      "integrity.queue.profile",
      r.profiles,
      { display_name: "nullableString" },
      true,
    );
    const flag = singleEmbed(
      "integrity.queue.flag",
      r.score_flags,
      {
        abuse_score: "nonnegativeInteger",
        status: "string",
        signals: "array",
        created_at: "timestamp",
      },
      true,
    )!;
    const signals = validateAdminRows<{ id: string }>(
      "integrity.queue.flag.signals",
      flag.signals,
      { id: "string" },
    );
    return {
      scoreId: r.id,
      ownerId: r.owner_id,
      ownerName: profile?.display_name ?? "익명",
      score: r.score,
      reviewStatus: r.review_status,
      abuseScore: flag.abuse_score,
      status: flag.status,
      signalIds: signals.map((signal) => signal.id),
      scoreCreatedAt: r.created_at,
      flaggedAt: flag.created_at,
    };
  });
  return { rows, total: count, page, pageSize: INTEGRITY_PAGE_SIZE };
}

export type IntegrityDetail = {
  scoreId: string;
  ownerId: string;
  ownerName: string;
  email: string | null;
  abuseStatus: string;
  score: number;
  weapon: string;
  durationMs: number;
  maxCombo: number | null;
  reviewStatus: string;
  reviewVersion: number;
  abuseVersion: number;
  createdAt: string;
  flag: {
    abuseScore: number;
    status: string;
    rulesVersion: string;
    signals: Array<{ id: string; value: number | null; threshold: number | null; source: string }>;
    evidence: Record<string, unknown>;
    reason: string | null;
    reviewedAt: string | null;
  } | null;
  telemetry: {
    score: number | null;
    durationMs: number | null;
    apm: number | null;
    tapShare: number | null;
    maxTouch: number | null;
    distinctWeapons: number | null;
    suspicious: boolean;
    intervalCv: number | null;
    deviceClass: string | null;
    refreshHz: number | null;
    /** 버킷별 apm — 봇=천장 고정 직선 / 인간=들쭉날쭉 스파크라인. */
    bucketApm: number[];
  } | null;
  /** 이 유저의 다른 점수(첫 정상판 대비 이상치 파악용). */
  otherScores: Array<{ id: string; score: number; reviewStatus: string; createdAt: string }>;
};

export async function getIntegrityDetail(scoreId: string): Promise<IntegrityDetail | null> {
  const admin = createAdminClient();
  const scoreRow = await requireSupabaseOptionalData("integrity.detail.score", () =>
    admin
      .from("scores")
      .select(
        "id, owner_id, score, weapon, duration_ms, max_combo, review_status, integrity_version, created_at, telemetry_session_id, profiles(display_name)"
      )
      .eq("id", scoreId)
      .maybeSingle(),
  );
  type DetailScoreRow = {
    id: string;
    owner_id: string;
    score: number;
    weapon: string;
    duration_ms: number;
    max_combo: number | null;
    review_status: string;
    integrity_version: number;
    created_at: string;
    telemetry_session_id: string | null;
    profiles:
      | { display_name: string | null }
      | { display_name: string | null }[]
      | null;
  };
  if (!scoreRow) return null;
  const s = validateAdminRows<DetailScoreRow>(
    "integrity.detail.score",
    [scoreRow],
    {
      id: "uuid",
      owner_id: "uuid",
      score: "nonnegativeInteger",
      weapon: "string",
      duration_ms: "nonnegativeInteger",
      max_combo: "nullableNonnegativeInteger",
      review_status: "string",
      integrity_version: "nonnegativeInteger",
      created_at: "timestamp",
      telemetry_session_id: "nullableUuid",
      profiles: "embed",
    },
  )[0];
  const scoreProfile = singleEmbed(
    "integrity.detail.score.profile",
    s.profiles,
    { display_name: "nullableString" },
    true,
  );
  const ownerId = s.owner_id;

  const [rawFlag, rawMember] = await Promise.all([
    requireSupabaseOptionalData("integrity.detail.flag", () =>
      admin.from("score_flags").select("*").eq("score_id", scoreId).maybeSingle(),
    ),
    requireSupabaseOptionalData("integrity.detail.member", () =>
      admin
        .from("member_accounts")
        .select("email, abuse_status, integrity_version")
        .eq("user_id", ownerId)
        .maybeSingle(),
    ),
  ]);
  const flag = rawFlag
    ? validateAdminRows<Record<string, unknown>>(
        "integrity.detail.flag",
        [rawFlag],
        {
          abuse_score: "nonnegativeInteger",
          status: "string",
          rules_version: "string",
          signals: "array",
          evidence: "jsonObject",
          reason: "nullableString",
          reviewed_at: "nullableTimestamp",
        },
      )[0]
    : null;
  const member = rawMember
    ? validateAdminRows<{
        email: string | null;
        abuse_status: string;
        integrity_version: number;
      }>(
        "integrity.detail.member",
        [rawMember],
        {
          email: "nullableString",
          abuse_status: "string",
          integrity_version: "nonnegativeInteger",
        },
      )[0]
    : null;

  let telemetry: IntegrityDetail["telemetry"] = null;
  const tsId = (s as { telemetry_session_id: string | null }).telemetry_session_id;
  if (tsId) {
    const rawTs = await requireSupabaseOptionalData(
      "integrity.detail.telemetry",
      () =>
        admin
          .from("telemetry_sessions")
          .select(
            "score, duration_ms, apm, tap_share, max_touch, distinct_weapons, suspicious, interval_cv, device_class, refresh_hz, timeline"
          )
          .eq("id", tsId)
          .maybeSingle(),
    );
    const ts = rawTs
      ? validateAdminRows<{
          score: number | string | null;
          duration_ms: number | null;
          apm: number | null;
          tap_share: number | string | null;
          max_touch: number | null;
          distinct_weapons: number | null;
          suspicious: boolean;
          interval_cv: number | string | null;
          device_class: string;
          refresh_hz: number | string | null;
          timeline: Array<Record<string, unknown>> | null;
        }>("integrity.detail.telemetry", [rawTs], {
          score: "nullableNonnegativeNumeric",
          duration_ms: "nullableNonnegativeInteger",
          apm: "nullableNonnegativeInteger",
          tap_share: "nullableNonnegativeNumeric",
          max_touch: "nullableNonnegativeInteger",
          distinct_weapons: "nullableNonnegativeInteger",
          suspicious: "boolean",
          interval_cv: "nullableNonnegativeNumeric",
          device_class: "string",
          refresh_hz: "nullableNonnegativeNumeric",
          timeline: "nullableArray",
        })[0]
      : null;
    if (ts) {
      if (ts.tap_share !== null && Number(ts.tap_share) > 1) {
        throw new SupabaseOperationError(
          "integrity.detail.telemetry",
          new Error("invalid_tap_share"),
        );
      }
      const tl = ts.timeline ?? [];
      const bucketApm = tl
        .filter((e) => e?.type === "hit_bucket")
        .map((event) => {
          if (
            !Number.isSafeInteger(event.apm) ||
            (event.apm as number) < 0
          ) {
            throw new SupabaseOperationError(
              "integrity.detail.telemetry.timeline",
              new Error("invalid_bucket_apm"),
            );
          }
          return event.apm as number;
        });
      telemetry = {
        score: ts.score === null ? null : Number(ts.score),
        durationMs: ts.duration_ms,
        apm: ts.apm,
        tapShare: ts.tap_share === null ? null : Number(ts.tap_share),
        maxTouch: ts.max_touch,
        distinctWeapons: ts.distinct_weapons,
        suspicious: ts.suspicious,
        intervalCv:
          ts.interval_cv === null ? null : Number(ts.interval_cv),
        deviceClass: ts.device_class,
        refreshHz:
          ts.refresh_hz === null ? null : Number(ts.refresh_hz),
        bucketApm,
      };
    }
  }

  const others = await requireSupabaseRows(
    "integrity.detail.other_scores",
    () =>
      admin
        .from("scores")
        .select("id, score, review_status, created_at")
        .eq("owner_id", ownerId)
        .neq("id", scoreId)
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(10),
  );

  const otherRows = validateAdminRows<{
    id: string;
    score: number;
    review_status: string;
    created_at: string;
  }>("integrity.detail.other_scores", others, {
    id: "uuid",
    score: "nonnegativeInteger",
    review_status: "string",
    created_at: "timestamp",
  });
  const flagSignals = flag
    ? validateAdminRows<{
        id: string;
        value: number | string | null;
        threshold: number | string | null;
        source: string;
      }>("integrity.detail.flag.signals", normalizeFlagSignalShape(flag.signals), {
        id: "string",
        value: "nullableNumeric",
        threshold: "nullableNumeric",
        source: "string",
      }).map((signal) => ({
        id: signal.id,
        value: signal.value === null ? null : Number(signal.value),
        threshold:
          signal.threshold === null ? null : Number(signal.threshold),
        source: signal.source,
      }))
    : [];

  return {
    scoreId,
    ownerId,
    ownerName: scoreProfile?.display_name ?? "익명",
    email: member?.email ?? null,
    abuseStatus: member?.abuse_status ?? "clean",
    score: s.score,
    weapon: s.weapon,
    durationMs: s.duration_ms,
    maxCombo: s.max_combo,
    reviewStatus: s.review_status,
    reviewVersion: s.integrity_version,
    abuseVersion: member?.integrity_version ?? 0,
    createdAt: s.created_at,
    flag: flag
      ? {
          abuseScore: flag.abuse_score as number,
          status: flag.status as string,
          rulesVersion: flag.rules_version as string,
          signals: flagSignals,
          evidence: flag.evidence as Record<string, unknown>,
          reason: flag.reason as string | null,
          reviewedAt: flag.reviewed_at as string | null,
        }
      : null,
    telemetry,
    otherScores: otherRows.map(
      (o) => ({ id: o.id, score: o.score, reviewStatus: o.review_status, createdAt: o.created_at })
    ),
  };
}
