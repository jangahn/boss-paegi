import "server-only";

import { createAdminClient } from "@/lib/supabase/admin";

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
  const { data, count } = await q
    .order("created_at", { ascending: false })
    .order("id", { ascending: false })
    .range(from, to);

  const rows: IntegrityRow[] = ((data ?? []) as unknown as ScoreJoinRow[]).map((r) => ({
    scoreId: r.id,
    ownerId: r.owner_id ?? "",
    ownerName: r.profiles?.display_name ?? "익명",
    score: r.score ?? 0,
    reviewStatus: r.review_status ?? "",
    abuseScore: r.score_flags?.abuse_score ?? 0,
    status: r.score_flags?.status ?? "",
    signalIds: Array.isArray(r.score_flags?.signals)
      ? r.score_flags.signals.map((s) => s?.id ?? "").filter(Boolean)
      : [],
    scoreCreatedAt: r.created_at,
    flaggedAt: r.score_flags?.created_at ?? r.created_at,
  }));
  return { rows, total: count ?? 0, page, pageSize: INTEGRITY_PAGE_SIZE };
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
  const { data: s } = await admin
    .from("scores")
    .select(
      "id, owner_id, score, weapon, duration_ms, max_combo, review_status, created_at, telemetry_session_id, profiles(display_name)"
    )
    .eq("id", scoreId)
    .maybeSingle();
  if (!s) return null;
  const ownerId = (s as { owner_id: string }).owner_id;

  const [{ data: flag }, { data: member }] = await Promise.all([
    admin.from("score_flags").select("*").eq("score_id", scoreId).maybeSingle(),
    admin.from("member_accounts").select("email, abuse_status").eq("user_id", ownerId).maybeSingle(),
  ]);

  let telemetry: IntegrityDetail["telemetry"] = null;
  const tsId = (s as { telemetry_session_id: string | null }).telemetry_session_id;
  if (tsId) {
    const { data: ts } = await admin
      .from("telemetry_sessions")
      .select(
        "score, duration_ms, apm, tap_share, max_touch, distinct_weapons, suspicious, interval_cv, device_class, refresh_hz, timeline"
      )
      .eq("id", tsId)
      .maybeSingle();
    if (ts) {
      const tl = Array.isArray((ts as { timeline?: unknown }).timeline)
        ? ((ts as { timeline: Array<Record<string, unknown>> }).timeline)
        : [];
      const bucketApm = tl
        .filter((e) => e?.type === "hit_bucket" && typeof e.apm === "number")
        .map((e) => e.apm as number);
      telemetry = {
        score: numOrNull(ts.score),
        durationMs: numOrNull(ts.duration_ms),
        apm: numOrNull(ts.apm),
        tapShare: numOrNull(ts.tap_share),
        maxTouch: numOrNull(ts.max_touch),
        distinctWeapons: numOrNull(ts.distinct_weapons),
        suspicious: !!ts.suspicious,
        intervalCv: numOrNull(ts.interval_cv),
        deviceClass: (ts.device_class as string) ?? null,
        refreshHz: numOrNull(ts.refresh_hz),
        bucketApm,
      };
    }
  }

  const { data: others } = await admin
    .from("scores")
    .select("id, score, review_status, created_at")
    .eq("owner_id", ownerId)
    .neq("id", scoreId)
    .order("created_at", { ascending: false })
    .limit(10);

  return {
    scoreId,
    ownerId,
    ownerName: (s as { profiles?: { display_name?: string } }).profiles?.display_name ?? "익명",
    email: (member as { email?: string } | null)?.email ?? null,
    abuseStatus: (member as { abuse_status?: string } | null)?.abuse_status ?? "clean",
    score: (s as { score: number }).score,
    weapon: (s as { weapon: string }).weapon,
    durationMs: (s as { duration_ms: number }).duration_ms,
    maxCombo: numOrNull((s as { max_combo: number | null }).max_combo),
    reviewStatus: (s as { review_status: string }).review_status,
    createdAt: (s as { created_at: string }).created_at,
    flag: flag
      ? {
          abuseScore: (flag as { abuse_score: number }).abuse_score,
          status: (flag as { status: string }).status,
          rulesVersion: (flag as { rules_version: string }).rules_version,
          signals:
            ((flag as { signals?: unknown }).signals as {
              id: string;
              value: number | null;
              threshold: number | null;
              source: string;
            }[]) ?? [],
          evidence: ((flag as { evidence?: Record<string, unknown> }).evidence) ?? {},
          reason: (flag as { reason: string | null }).reason ?? null,
          reviewedAt: (flag as { reviewed_at: string | null }).reviewed_at ?? null,
        }
      : null,
    telemetry,
    otherScores: ((others ?? []) as Array<{ id: string; score: number; review_status: string; created_at: string }>).map(
      (o) => ({ id: o.id, score: o.score, reviewStatus: o.review_status, createdAt: o.created_at })
    ),
  };
}

function numOrNull(v: unknown): number | null {
  return typeof v === "number" ? v : v == null ? null : Number(v);
}
