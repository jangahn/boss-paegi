import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MAX_DURATION_MS, scoreCeiling } from "@/lib/score-limits";
import {
  buildGameplayStats,
  validateGameplayStats,
  type GameplayStats,
} from "@/lib/stats";
import {
  evaluateSubmission,
  ANTI_ABUSE_RULES_VERSION,
  type TelemetrySnapshot,
} from "@/lib/anti-abuse-rules";
import { matchPersona } from "@/lib/persona";
import { getBadgeCatalog } from "@/lib/config/getters";
import { evaluateBadges, knownSlugs } from "@/lib/config/domains/badges";
import { log, errInfo } from "@/lib/log";
import { recordConversion, memberStateFromUser } from "@/lib/analytics/server";
import type { RawSource } from "@/lib/analytics/core";

export const runtime = "nodejs";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** weaponCounts/weaponScores 를 finite·non-negative·키 제한으로 정제(직접제출 위조/NaN 방어). */
function sanitizeNumberMap(v: unknown, maxKeys = 30): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n >= maxKeys) break;
    if (typeof k !== "string" || k.length > 24) continue;
    const num = typeof val === "number" ? val : NaN;
    if (!Number.isFinite(num) || num < 0) continue;
    out[k] = num;
    n++;
  }
  return out;
}

export async function POST(req: NextRequest) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    score?: number;
    weapon?: string;
    durationMs?: number;
    dollId?: string | null;
    maxCombo?: number;
    gameplayStats?: GameplayStats;
    endReason?: string;
    telemetrySessionId?: string | null;
    trackFirstTouchPlay?: boolean;
    acqSource?: unknown;
  } | null;

  // ── Protocol 검증 (rule 평가 전) — score/duration 이상은 400, stats 이상은 pending 경로로 ──
  if (
    typeof body?.score !== "number" ||
    !Number.isFinite(body.score) ||
    typeof body?.weapon !== "string" ||
    typeof body?.durationMs !== "number" ||
    !Number.isFinite(body.durationMs)
  ) {
    return NextResponse.json({ error: "missing_fields" }, { status: 400 });
  }
  const score = Math.round(body.score);
  if (body.durationMs <= 0 || body.durationMs > MAX_DURATION_MS) {
    return NextResponse.json({ error: "invalid_duration" }, { status: 400 });
  }
  // 평균 점수/sec 하드 상한(클라도 동일 클램프). 초과 = 명백 비정상(프로토콜) → 400.
  const ceiling = scoreCeiling(body.durationMs);
  if (score < 0 || score > ceiling) {
    log.warn("score.out_of_range", {
      userId: user.id,
      score,
      ceiling,
      durationMs: body.durationMs,
      weapon: body.weapon,
    });
    return NextResponse.json({ error: "score_out_of_range", ceiling }, { status: 400 });
  }
  if (body.weapon.length > 20) {
    return NextResponse.json({ error: "invalid_weapon" }, { status: 400 });
  }

  const maxCombo =
    typeof body.maxCombo === "number" && Number.isFinite(body.maxCombo)
      ? Math.min(Math.max(0, Math.round(body.maxCombo)), 99999)
      : 0;

  const endReason =
    body.endReason === "time_limit" || body.endReason === "score_limit"
      ? body.endReason
      : "normal";

  const telemetrySessionId =
    typeof body.telemetrySessionId === "string" && UUID_RE.test(body.telemetrySessionId)
      ? body.telemetrySessionId
      : null;

  // doll_id IDOR 방어 — 본인 소유 doll 만 attach(user 클라 RLS). 미소유/무효 → null 강등.
  let dollId: string | null =
    typeof body.dollId === "string" && UUID_RE.test(body.dollId) ? body.dollId : null;
  if (dollId) {
    const { data: ownDoll, error: dollErr } = await supabase
      .from("dolls")
      .select("id")
      .eq("id", dollId)
      .maybeSingle();
    if (!dollErr && !ownDoll) {
      log.warn("score.doll_ownership_mismatch", { userId: user.id, dollId });
      dollId = null;
    }
  }

  // ── canonical stats 재구성 (durationMs=서버값, ultScore 클램프, 숫자맵 정제) ──
  const raw = body.gameplayStats;
  let canonicalStats: GameplayStats | null = null;
  if (raw && typeof raw === "object" && typeof raw.hitCount === "number" && Number.isFinite(raw.hitCount)) {
    canonicalStats = buildGameplayStats({
      hitCount: Math.max(0, Math.round(raw.hitCount)),
      maxCombo,
      durationMs: body.durationMs,
      weaponCounts: sanitizeNumberMap(raw.weaponCounts),
      weaponScores: sanitizeNumberMap(raw.weaponScores),
      ultScore: Math.min(Math.max(0, Number.isFinite(raw.ultScore) ? raw.ultScore! : 0), score),
      ultimateCount:
        typeof raw.ultimateCount === "number" && Number.isFinite(raw.ultimateCount)
          ? Math.max(0, Math.round(raw.ultimateCount))
          : 0,
      firstHitMs: typeof raw.firstHitMs === "number" ? raw.firstHitMs : null,
      bgVisits: Array.isArray(raw.bgVisits) ? raw.bgVisits.slice(0, 12) : [],
    });
  }

  const admin = createAdminClient();

  // banned 유저? (공개 등록 차단 — 저장은 하되 voided)
  let isBanned = false;
  {
    const { data: mem } = await admin
      .from("member_accounts")
      .select("abuse_status")
      .eq("user_id", user.id)
      .maybeSingle();
    isBanned = mem?.abuse_status === "banned";
  }

  // 연결 텔레메트리 즉시 스냅샷(미확정 가능 — 최종 정합은 cron). suspicious 는 단조라 즉시 유효.
  let telemetry: TelemetrySnapshot = null;
  if (telemetrySessionId) {
    const { data: ts } = await admin
      .from("telemetry_sessions")
      .select("score, duration_ms, suspicious")
      .eq("id", telemetrySessionId)
      .maybeSingle();
    if (ts)
      telemetry = {
        score: typeof ts.score === "number" ? ts.score : null,
        durationMs: typeof ts.duration_ms === "number" ? ts.duration_ms : null,
        suspicious: !!ts.suspicious,
      };
  }

  // ── 판정(단일 출처 lib/anti-abuse-rules) ──
  const decision = evaluateSubmission({
    score,
    durationMs: body.durationMs,
    telemetrySessionId,
    stats: canonicalStats,
    telemetry,
    isBanned,
  });

  // ── 원자 저장 + 리뷰(fail-closed) ──
  const { data: rpcData, error: rpcErr } = await admin.rpc("submit_score_with_review", {
    p_owner_id: user.id,
    p_doll_id: dollId,
    p_score: score,
    p_weapon: body.weapon,
    p_duration_ms: Math.round(body.durationMs),
    p_max_combo: maxCombo,
    p_end_reason: endReason,
    p_telemetry_session_id: telemetrySessionId,
    p_review_status: decision.reviewStatus,
    p_signals: decision.signals,
    p_evidence: decision.evidence,
    p_abuse_score: decision.abuseScore,
    p_rules_version: ANTI_ABUSE_RULES_VERSION,
  });

  if (rpcErr || !rpcData) {
    if ((rpcErr?.message ?? "").includes("telemetry_session_conflict")) {
      return NextResponse.json({ error: "telemetry_session_conflict" }, { status: 409 });
    }
    log.error("score.insert_fail", { userId: user.id, score, ...errInfo(rpcErr) });
    return NextResponse.json({ error: "insert_failed", detail: rpcErr?.message }, { status: 500 });
  }

  const result = rpcData as { scoreId: string; reviewStatus: string; duplicate: boolean };
  const scoreId = result.scoreId;
  const reviewStatus = result.reviewStatus;
  const clientStatus = reviewStatus === "registered" ? "registered" : "pending";

  log.info("score.save_success", {
    userId: user.id,
    scoreId,
    score,
    maxCombo,
    weapon: body.weapon,
    durationMs: Math.round(body.durationMs),
    hasDoll: !!dollId,
    reviewStatus,
    abuseScore: decision.abuseScore,
    signals: decision.signals.map((s) => s.id),
  });

  // 중복 제출(본인) — graceful. 부가 리포트 스킵.
  if (result.duplicate) {
    return NextResponse.json({
      scoreId,
      status: reviewStatus === "registered" ? "registered" : "pending",
      reviewStatus,
      personaId: null,
      percentile: null,
      newBadges: [],
      collectedCount: 0,
      duplicate: true,
    });
  }

  // 방문→플레이 전환(분석, best-effort) — 저장 성공 시 1회.
  if (body.trackFirstTouchPlay === true && body.acqSource) {
    await recordConversion("play", body.acqSource as RawSource, memberStateFromUser(user));
  }

  // ── 부가 리포트(페르소나·뱃지·백분위) — registered 에만. flagged/voided 는 미부여. ──
  let personaId: string | null = null;
  let percentile: number | null = null;
  let newBadges: string[] = [];
  let collectedCount = 0;
  if (reviewStatus === "registered" && canonicalStats && validateGameplayStats(canonicalStats, score)) {
    try {
      personaId = matchPersona(canonicalStats).id;
      const catalog = await getBadgeCatalog();
      const earned = evaluateBadges(canonicalStats, score, catalog);

      try {
        const { data: pct } = await admin.rpc("get_score_percentile", { p_score: score });
        if (typeof pct === "number") percentile = pct;
      } catch (e) {
        log.warn("percentile.error", { scoreId, ...errInfo(e) });
      }

      const { error: statsErr } = await admin.from("score_stats").insert({
        score_id: scoreId,
        gameplay_stats: canonicalStats,
        persona_id: personaId,
        badge_ids: earned,
        percentile,
      });
      if (statsErr) log.warn("score_stats.insert_fail", { scoreId, ...errInfo(statsErr) });

      if (earned.length) {
        const { data: ins, error: bErr } = await admin
          .from("user_badges")
          .upsert(
            earned.map((badge_id) => ({ owner_id: user.id, badge_id, first_score_id: scoreId })),
            { onConflict: "owner_id,badge_id", ignoreDuplicates: true }
          )
          .select("badge_id");
        if (bErr) log.warn("user_badges.insert_fail", { scoreId, ...errInfo(bErr) });
        else newBadges = (ins ?? []).map((r) => r.badge_id as string);
      }

      const { count } = await admin
        .from("user_badges")
        .select("badge_id", { count: "exact", head: true })
        .eq("owner_id", user.id)
        .in("badge_id", [...knownSlugs(catalog)]);
      collectedCount = count ?? 0;
    } catch (e) {
      log.warn("score_stats.error", { scoreId, ...errInfo(e) });
    }
  }

  return NextResponse.json({
    scoreId,
    status: clientStatus,
    reviewStatus,
    personaId,
    percentile,
    newBadges,
    collectedCount,
    messageKey: clientStatus === "registered" ? null : "under_review",
  });
}
