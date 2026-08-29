import "server-only";
import { NextRequest, NextResponse } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { requireActiveUser, memberGateResponse } from "@/lib/auth-server";
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
import { getBadgeCatalogStrictUncached } from "@/lib/config/getters";
import { evaluateBadges, knownSlugs } from "@/lib/config/domains/badges";
import { log, errInfo } from "@/lib/log";
import { recordConversion, memberStateFromUser } from "@/lib/analytics/server";
import type { RawSource } from "@/lib/analytics/core";
import {
  publicWriteActorKey,
  publicWriteNetworkActorKey,
} from "@/lib/public-write-quota";
import {
  parsePublicWriteAttemptFailure,
  parsePublicWriteAttemptReservation,
} from "@/lib/public-write-attempt";
import { RETIRED_WEAPONS, WEAPONS } from "@/lib/weapons";
import { BACKGROUNDS } from "@/lib/backgrounds";
import {
  isMissingCommitScoreReportRpcError,
  isMissingSubmitterBindingSchemaError,
  legacyTelemetryScoreSubmissionId,
  ownsTelemetrySession,
  parseScoreReportRpcResult,
  parseScoreSubmissionRpcResult,
  readOptionalScorePercentile,
  scoreSubmissionFingerprint,
} from "@/lib/score-submission";
import { isScoreSubmissionId } from "@/lib/score-retry";
import {
  requireSupabaseData,
  requireSupabaseExactCount,
  requireSupabaseRows,
  requireSupabaseSuccess,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import { isVisibleReviewStatus } from "@/lib/score-visibility";
import { validateAdminRows } from "@/lib/admin-read-contract";
import { readBoundedJsonRequest } from "@/lib/http/bounded-json-request";
import { responseContentLengthAllowed } from "@/lib/http/bounded-response";

export const runtime = "nodejs";
export const SCORE_SUBMISSION_MAX_BODY_BYTES = 64 * 1024;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// 은퇴 무기 포함 — 배포 전환기의 구 번들 클라이언트(대표무기 paper) 제출을 거절하지 않는다.
const WEAPON_KEYS = new Set<string>(
  [...WEAPONS, ...RETIRED_WEAPONS].map((weapon) => weapon.key)
);
const BACKGROUND_KEYS = new Set<string>(
  BACKGROUNDS.map((background) => background.key),
);

function scoreWriteErrorResponse(code: string): NextResponse | null {
  for (const conflict of [
    "telemetry_session_conflict",
    "submission_id_conflict",
    "telemetry_session_owner_mismatch",
    "doll_ownership_mismatch",
    "migrated_replay_not_authorized",
    "migrated_score_replay_mismatch",
  ]) {
    if (code.includes(conflict)) {
      return NextResponse.json({ error: conflict }, { status: 409 });
    }
  }
  if (code.includes("account_deleted")) {
    return NextResponse.json({ error: "account_deleted" }, { status: 403 });
  }
  if (code.includes("account_not_found") || code.includes("invalid_owner")) {
    return NextResponse.json({ error: "account_unavailable" }, { status: 403 });
  }
  if (code.includes("account_migrated")) {
    return NextResponse.json({ error: "account_migrated" }, { status: 409 });
  }
  if (code.includes("client_upgrade_required")) {
    return NextResponse.json(
      { error: "client_upgrade_required", retryable: false },
      { status: 409 },
    );
  }
  if (code.includes("score_write_quota_busy")) {
    return NextResponse.json(
      { error: "score_unavailable" },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }
  if (
    code.includes("score_write_global_request_quota") ||
    code.includes("score_write_network_request_quota") ||
    code.includes("score_write_owner_request_quota")
  ) {
    return NextResponse.json(
      { error: "score_rate_limited" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  if (
    code.includes("invalid_score_protocol") ||
    code.includes("invalid_submission_id") ||
    code.includes("invalid_submission_fingerprint") ||
    code.includes("invalid_migrated_replay_source") ||
    code.includes("invalid_review_status") ||
    code.includes("invalid_review_payload") ||
    code.includes("review_payload_mismatch")
  ) {
    return NextResponse.json({ error: "invalid_submission" }, { status: 400 });
  }
  return null;
}

/** weaponCounts/weaponScores 를 finite·non-negative·키 제한으로 정제(직접제출 위조/NaN 방어). */
function sanitizeNumberMap(v: unknown, maxKeys = 30): Record<string, number> {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, number> = {};
  let n = 0;
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (n >= maxKeys) break;
    if (!WEAPON_KEYS.has(k)) continue;
    const num = typeof val === "number" ? val : NaN;
    if (!Number.isSafeInteger(num) || num < 0) continue;
    out[k] = num;
    n++;
  }
  return out;
}

function sanitizeBackgroundVisits(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value.filter(
        (entry): entry is string =>
          typeof entry === "string" && BACKGROUND_KEYS.has(entry),
      ),
    ),
  ].slice(0, BACKGROUNDS.length);
}

export async function POST(req: NextRequest) {
  if (
    !responseContentLengthAllowed(
      req.headers.get("content-length"),
      SCORE_SUBMISSION_MAX_BODY_BYTES,
    )
  ) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }
  // anonymous 플레이는 허용하되 soft-deleted profile의 stale session 쓰기는 차단한다.
  const gate = await requireActiveUser();
  if (!gate.ok) return memberGateResponse(gate);
  const { user } = gate;
  const admin = createAdminClient();
  const migratedSourceHeader = req.headers.get(
    "x-boss-paegi-score-source-owner",
  );
  const migratedSourceOwnerId =
    migratedSourceHeader === null
      ? null
      : UUID_RE.test(migratedSourceHeader) &&
          migratedSourceHeader.toLowerCase() !== user.id.toLowerCase()
        ? migratedSourceHeader.toLowerCase()
        : undefined;
  if (migratedSourceOwnerId === undefined) {
    return NextResponse.json(
      { error: "invalid_migrated_replay_source" },
      { status: 400 },
    );
  }

  const requestBody = await readBoundedJsonRequest(
    req,
    SCORE_SUBMISSION_MAX_BODY_BYTES,
  );
  if (!requestBody.ok) {
    return NextResponse.json(
      {
        error:
          requestBody.error === "too_large"
            ? "payload_too_large"
            : "invalid_body",
      },
      { status: requestBody.error === "too_large" ? 413 : 400 },
    );
  }
  const body = requestBody.value as {
    score?: number;
    weapon?: string;
    durationMs?: number;
    dollId?: string | null;
    maxCombo?: number;
    gameplayStats?: GameplayStats;
    endReason?: string;
    telemetrySessionId?: string | null;
    submissionId?: string;
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
  const durationMs = Math.round(body.durationMs);
  if (durationMs <= 0 || durationMs > MAX_DURATION_MS) {
    return NextResponse.json({ error: "invalid_duration" }, { status: 400 });
  }
  // 평균 점수/sec 하드 상한(클라도 동일 클램프). 초과 = 명백 비정상(프로토콜) → 400.
  const ceiling = scoreCeiling(durationMs);
  if (score < 0 || score > ceiling) {
    log.warn("score.out_of_range", {
      userId: user.id,
      score,
      ceiling,
      durationMs,
      weapon: body.weapon,
    });
    return NextResponse.json(
      { error: "score_out_of_range", ceiling },
      { status: 400 },
    );
  }
  if (!WEAPON_KEYS.has(body.weapon)) {
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

  const requestedTelemetrySessionId =
    typeof body.telemetrySessionId === "string" &&
    UUID_RE.test(body.telemetrySessionId)
      ? body.telemetrySessionId
      : null;
  let telemetrySessionId = requestedTelemetrySessionId;
  if (
    body.submissionId !== undefined &&
    !isScoreSubmissionId(body.submissionId)
  ) {
    return NextResponse.json(
      { error: "invalid_submission_id" },
      { status: 400 },
    );
  }
  // New clients mint one UUID per game and reuse it across every HTTP retry.
  // A cached pre-0074 browser instead has only its per-game telemetry UUID.
  // With neither key, a retry and a distinct identical game are impossible to
  // distinguish, so fail closed instead of minting a duplicate-prone random ID.
  const submissionId =
    typeof body.submissionId === "string"
      ? body.submissionId.toLowerCase()
      : legacyTelemetryScoreSubmissionId(user.id, requestedTelemetrySessionId);
  if (submissionId === null) {
    return NextResponse.json(
      {
        error: "client_upgrade_required",
        retryable: false,
      },
      { status: 409 },
    );
  }

  // doll_id IDOR 방어 — 본인 소유 doll 만 attach. 조회 장애는 타인 doll을
  // service-role RPC에 넘기는 fail-open이 되므로 503, 미소유/무효만 null 강등.
  const requestedDollId: string | null =
    typeof body.dollId === "string" && UUID_RE.test(body.dollId)
      ? body.dollId
      : null;
  let dollId = requestedDollId;
  if (dollId) {
    const { data: ownDoll, error: dollErr } = await admin
      .from("dolls")
      .select("id, owner_id, deleted_at")
      .eq("id", dollId)
      .maybeSingle();
    if (dollErr) {
      log.error("score.doll_lookup_fail", {
        userId: user.id,
        dollId,
        ...errInfo(dollErr),
      });
      return NextResponse.json(
        { error: "dependency_unavailable" },
        { status: 503 },
      );
    }
    if (!ownDoll || ownDoll.owner_id !== user.id || ownDoll.deleted_at) {
      log.warn("score.doll_ownership_mismatch", { userId: user.id, dollId });
      dollId = null;
    }
  }

  // ── canonical stats 재구성 (durationMs=서버값, ultScore 클램프, 숫자맵 정제) ──
  const raw = body.gameplayStats;
  let canonicalStats: GameplayStats | null = null;
  if (
    raw &&
    typeof raw === "object" &&
    typeof raw.hitCount === "number" &&
    Number.isFinite(raw.hitCount)
  ) {
    canonicalStats = buildGameplayStats({
      hitCount: Math.max(0, Math.round(raw.hitCount)),
      maxCombo,
      durationMs,
      weaponCounts: sanitizeNumberMap(raw.weaponCounts),
      weaponScores: sanitizeNumberMap(raw.weaponScores),
      ultScore: Math.min(
        Math.max(0, Number.isFinite(raw.ultScore) ? raw.ultScore! : 0),
        score,
      ),
      ultimateCount:
        typeof raw.ultimateCount === "number" &&
        Number.isFinite(raw.ultimateCount)
          ? Math.max(0, Math.round(raw.ultimateCount))
          : 0,
      firstHitMs:
        typeof raw.firstHitMs === "number" && Number.isFinite(raw.firstHitMs)
          ? Math.min(durationMs, Math.max(0, Math.round(raw.firstHitMs)))
          : null,
      bgVisits: sanitizeBackgroundVisits(raw.bgVisits),
      intervalCV:
        typeof raw.intervalCV === "number" && Number.isFinite(raw.intervalCV)
          ? raw.intervalCV
          : null,
    });
  }

  // member/banned 판정의 resolved error를 clean/anonymous로 강등하지 않는다.
  // 최종 banned 상태는 submit_score_with_review가 같은 member advisory lock 안에서 재검증한다.
  const { data: member, error: memberError } = await admin
    .from("member_accounts")
    .select("user_id, abuse_status")
    .eq("user_id", user.id)
    .maybeSingle();
  if (memberError) {
    log.error("score.member_lookup_fail", {
      userId: user.id,
      ...errInfo(memberError),
    });
    return NextResponse.json(
      { error: "dependency_unavailable" },
      { status: 503 },
    );
  }
  const isMember = member?.user_id === user.id;
  const isBanned = member?.abuse_status === "banned";

  // 연결 텔레메트리 즉시 스냅샷(미확정 가능 — 최종 정합은 cron).
  // 존재·소유·session-scoped binding을 모두 만족한 행만 연결한다. 임의/타인/레거시
  // unbound UUID는 null 강등되어 notable score라면 S6가 정상 발화한다.
  let telemetry: TelemetrySnapshot = null;
  if (telemetrySessionId) {
    let { data: ts, error: telemetryError } = await admin
      .from("telemetry_sessions")
      .select(
        "score, duration_ms, suspicious, owner_id, is_anon, submitter_binding",
      )
      .eq("id", telemetrySessionId)
      .maybeSingle();

    // Additive rollout: deploy this route before 0074. A member row remains
    // provable by owner_id on the old schema; anonymous rows safely lose only
    // the optional link until the binding column exists.
    let legacySchema = false;
    if (
      telemetryError &&
      isMissingSubmitterBindingSchemaError(telemetryError)
    ) {
      legacySchema = true;
      const legacy = await admin
        .from("telemetry_sessions")
        .select("score, duration_ms, suspicious, owner_id, is_anon")
        .eq("id", telemetrySessionId)
        .maybeSingle();
      ts = legacy.data as typeof ts;
      telemetryError = legacy.error;
    }
    if (telemetryError) {
      log.error("score.telemetry_lookup_fail", {
        userId: user.id,
        telemetrySessionId,
        ...errInfo(telemetryError),
      });
      return NextResponse.json(
        { error: "dependency_unavailable" },
        { status: 503 },
      );
    }

    const owned =
      !!ts &&
      (legacySchema
        ? isMember && ts.is_anon === false && ts.owner_id === user.id
        : ownsTelemetrySession(
            {
              owner_id: ts.owner_id,
              is_anon: ts.is_anon,
              submitter_binding: ts.submitter_binding,
            },
            user.id,
            isMember,
            telemetrySessionId,
          ));
    if (owned && ts) {
      telemetry = {
        score: typeof ts.score === "number" ? ts.score : null,
        durationMs: typeof ts.duration_ms === "number" ? ts.duration_ms : null,
        suspicious: !!ts.suspicious,
      };
    } else {
      log.warn("score.telemetry_ownership_mismatch", {
        userId: user.id,
        telemetrySessionId,
        isMember,
        rowFound: !!ts,
        legacySchema,
      });
      telemetrySessionId = null;
    }
  }

  const submissionFingerprint = scoreSubmissionFingerprint({
    // Bind the normalized request, not DB-dependent acceptance. A telemetry
    // ingest or doll ownership row can become visible between response-loss
    // retries; the first committed score must still win without self-conflict.
    dollId: requestedDollId,
    score,
    weapon: body.weapon,
    durationMs,
    maxCombo,
    endReason,
    telemetrySessionId: requestedTelemetrySessionId,
    gameplayStats: canonicalStats,
  });

  // ── 판정(단일 출처 lib/anti-abuse-rules) ──
  const decision = evaluateSubmission({
    score,
    durationMs,
    telemetrySessionId,
    stats: canonicalStats,
    telemetry,
    isBanned,
  });

  const scoreNetworkActorKey = publicWriteNetworkActorKey(req.headers);
  if (!scoreNetworkActorKey) {
    return NextResponse.json(
      { error: "score_unavailable" },
      { status: 503, headers: { "Retry-After": "1" } },
    );
  }

  const scoreEvidence = {
    ...decision.evidence,
    submissionId,
    submissionFingerprint,
    ...(migratedSourceOwnerId ? { migratedSourceOwnerId } : {}),
  };
  const scoreAttemptArgs = {
    p_network_actor_key: scoreNetworkActorKey,
    p_owner_id: user.id,
    p_doll_id: dollId,
    p_score: score,
    p_weapon: body.weapon,
    p_duration_ms: durationMs,
    p_max_combo: maxCombo,
    p_end_reason: endReason,
    p_telemetry_session_id: telemetrySessionId,
    p_evidence: scoreEvidence,
  };

  // Commit the operation-keyed quota reservation in its own RPC transaction.
  // A later core validation failure therefore cannot roll the quota back.
  const reservationRpc = await admin.rpc(
    "reserve_score_write_attempt",
    scoreAttemptArgs,
  );
  if (reservationRpc.error) {
    const mapped = scoreWriteErrorResponse(reservationRpc.error.message ?? "");
    if (mapped) return mapped;
    log.error("score.reserve_fail", {
      userId: user.id,
      score,
      ...errInfo(reservationRpc.error),
    });
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }
  const reservation = parsePublicWriteAttemptReservation(reservationRpc.data);
  if (!reservation) {
    log.error("score.reserve_invalid_result", {
      userId: user.id,
      score,
    });
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }
  if (reservation.kind === "error") {
    const mapped = scoreWriteErrorResponse(reservation.errorCode);
    if (mapped) return mapped;
    log.error("score.reserve_rejected", {
      userId: user.id,
      score,
      errorCode: reservation.errorCode,
    });
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  let rpcData: unknown = null;
  if (reservation.kind === "replay") {
    rpcData = reservation.result;
  } else {
    // ── 원자 저장 + 리뷰(fail-closed) ──
    const submissionRpc = await admin.rpc("submit_score_with_review", {
      ...scoreAttemptArgs,
      p_review_status: decision.reviewStatus,
      p_signals: decision.signals,
      p_abuse_score: decision.abuseScore,
      p_rules_version: ANTI_ABUSE_RULES_VERSION,
    });
    if (submissionRpc.error || !submissionRpc.data) {
      const mapped = scoreWriteErrorResponse(
        submissionRpc.error?.message ?? "",
      );
      if (mapped) return mapped;
      log.error("score.insert_fail", {
        userId: user.id,
        score,
        ...errInfo(submissionRpc.error),
      });
      return NextResponse.json({ error: "insert_failed" }, { status: 500 });
    }
    rpcData = submissionRpc.data;
  }

  const attemptError = parsePublicWriteAttemptFailure(rpcData);
  if (attemptError) {
    const mapped = scoreWriteErrorResponse(attemptError);
    if (mapped) return mapped;
    log.error("score.insert_attempt_failed", {
      userId: user.id,
      score,
      errorCode: attemptError,
    });
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }

  const result = parseScoreSubmissionRpcResult(rpcData);
  if (!result) {
    log.error("score.insert_invalid_result", {
      userId: user.id,
      score,
    });
    return NextResponse.json({ error: "insert_failed" }, { status: 500 });
  }
  const scoreId = result.scoreId;
  let reviewStatus = result.reviewStatus;
  let clientStatus = isVisibleReviewStatus(reviewStatus)
    ? "registered"
    : "pending";

  log.info("score.save_success", {
    userId: user.id,
    scoreId,
    score,
    maxCombo,
    weapon: body.weapon,
    durationMs,
    hasDoll: !!dollId,
    reviewStatus,
    abuseScore: decision.abuseScore,
    signals: decision.signals.map((s) => s.id),
  });

  // 타격 간격 CV 를 연결 텔레메트리에 persist(어드민 지표·S5 evidence 는 이미 반영). best-effort.
  //   (ingest RPC 재정의 회피 — 값은 gameplayStats 와 동일 클라 계측. C3 는 S5 와 동일소스라 생략.)
  if (
    telemetrySessionId &&
    canonicalStats &&
    typeof canonicalStats.intervalCV === "number"
  ) {
    try {
      await requireSupabaseSuccess("score.telemetry_interval_cv", () =>
        admin
          .from("telemetry_sessions")
          .update({ interval_cv: canonicalStats.intervalCV })
          .eq("id", telemetrySessionId),
      );
    } catch (error) {
      log.warn("score.telemetry_interval_cv_fail", {
        scoreId,
        telemetrySessionId,
        ...errInfo(error),
      });
    }
  }

  // 방문→플레이 전환(분석, best-effort) — 저장 성공 시 1회.
  if (
    !result.duplicate &&
    body.trackFirstTouchPlay === true &&
    body.acqSource
  ) {
    const conversionMemberState = memberStateFromUser(user);
    const actorKey = publicWriteActorKey(req.headers, user.id, isMember);
    if (actorKey) {
      await recordConversion(
        "play",
        body.acqSource as RawSource,
        conversionMemberState,
        actorKey,
      );
    }
  }

  // visible 점수만 atomic RPC로 stats+badges를 함께 commit한다. 동일 제출 재시도도
  // 이 경로를 다시 타므로 score 저장 뒤 응답 단절이 나도 누락된 리포트를 복구한다.
  let personaId: string | null = null;
  let percentile: number | null = null;
  let newBadges: string[] = [];
  let collectedCount = 0;
  let reportPending = false;
  if (
    isVisibleReviewStatus(reviewStatus) &&
    canonicalStats &&
    validateGameplayStats(canonicalStats, score)
  ) {
    try {
      personaId = matchPersona(canonicalStats).id;
      const catalog = await getBadgeCatalogStrictUncached();
      const earned = evaluateBadges(canonicalStats, score, catalog);

      const percentileSnapshot = await readOptionalScorePercentile(() =>
        admin.rpc("get_score_percentile", { p_score: score }),
      );
      percentile = percentileSnapshot.value;
      if (percentileSnapshot.error) {
        log.warn("percentile.error", {
          scoreId,
          ...errInfo(percentileSnapshot.error),
        });
      }

      let report = null as ReturnType<typeof parseScoreReportRpcResult>;
      try {
        const reportResult = await requireSupabaseSuccess(
          "score.report_commit",
          () =>
            admin.rpc("commit_score_report", {
              p_score_id: scoreId,
              p_owner_id: user.id,
              p_gameplay_stats: canonicalStats,
              p_persona_id: personaId,
              p_badge_ids: earned,
              p_percentile: percentile,
              p_known_badge_ids: [...knownSlugs(catalog)],
            }),
        );
        report = parseScoreReportRpcResult(reportResult.data);
        if (!report) throw new Error("score_report_invalid_result");
      } catch (reportError) {
        const operationError =
          reportError instanceof SupabaseOperationError
            ? reportError.operationError
            : reportError;
        if (
          !isMissingCommitScoreReportRpcError(
            (operationError ?? {}) as {
              code?: string | null;
              message?: string | null;
            },
          )
        ) {
          throw reportError;
        }

        // App-first additive rollout only. Once 0074 exists, every non-missing
        // RPC error fails closed and must never fall through to direct DML.
        log.warn("score.report_legacy_rollout", { scoreId });
        await requireSupabaseSuccess("score_stats.legacy_upsert", () =>
          admin.from("score_stats").upsert(
            {
              score_id: scoreId,
              gameplay_stats: canonicalStats,
              persona_id: personaId,
              badge_ids: earned,
              percentile,
            },
            { onConflict: "score_id", ignoreDuplicates: true },
          ),
        );
        const storedData = await requireSupabaseData(
          "score_stats.legacy_read",
          () =>
            admin
              .from("score_stats")
              .select("persona_id, badge_ids, percentile")
              .eq("score_id", scoreId)
              .single(),
        );
        const stored = validateAdminRows<{
          persona_id: string | null;
          badge_ids: unknown[] | null;
          percentile: number | string | null;
        }>("score_stats.legacy_read", [storedData], {
          persona_id: "nullableString",
          badge_ids: "nullableArray",
          percentile: "nullableNumeric",
        })[0]!;
        const knownBadgeIds = knownSlugs(catalog);
        const knownBadgeSet = new Set(knownBadgeIds);
        if (
          stored.badge_ids !== null &&
          !stored.badge_ids.every(
            (badge): badge is string =>
              typeof badge === "string" && knownBadgeSet.has(badge),
          )
        ) {
          throw new Error("score_stats_invalid_badge_ids");
        }
        const persistedBadges = stored.badge_ids ?? earned;
        let legacyNewBadges: string[] = [];
        if (persistedBadges.length > 0) {
          const badgeData = await requireSupabaseRows(
            "user_badges.legacy_upsert",
            () =>
              admin
                .from("user_badges")
                .upsert(
                  persistedBadges.map((badge_id) => ({
                    owner_id: user.id,
                    badge_id,
                    first_score_id: scoreId,
                  })),
                  {
                    onConflict: "owner_id,badge_id",
                    ignoreDuplicates: true,
                  },
                )
                .select("badge_id"),
          );
          const badgeRows = validateAdminRows<{ badge_id: string }>(
            "user_badges.legacy_upsert",
            badgeData,
            { badge_id: "string" },
          );
          legacyNewBadges = badgeRows.map((row) => row.badge_id);
          if (
            new Set(legacyNewBadges).size !== legacyNewBadges.length ||
            legacyNewBadges.some((badge) => !knownBadgeSet.has(badge))
          ) {
            throw new Error("user_badges_invalid_upsert_ack");
          }
        }
        const collectedBadgeCount = await requireSupabaseExactCount(
          "user_badges.legacy_count",
          () =>
            admin
              .from("user_badges")
              .select("badge_id", { count: "exact", head: true })
              .eq("owner_id", user.id)
              .in("badge_id", [...knownBadgeIds]),
        );
        report = parseScoreReportRpcResult({
          personaId: stored.persona_id ?? personaId,
          percentile:
            typeof stored.percentile === "number"
              ? stored.percentile
              : typeof stored.percentile === "string"
                ? Number(stored.percentile)
                : percentile,
          newBadges: legacyNewBadges,
          collectedCount: collectedBadgeCount,
        });
      }
      if (!report) {
        throw new Error("score_report_empty_result");
      }
      personaId = report.personaId;
      percentile = report.percentile;
      newBadges = report.newBadges;
      collectedCount = report.collectedCount;
    } catch (e) {
      log.warn("score_stats.error", { scoreId, ...errInfo(e) });
      const message = String(
        (e as { operationError?: { message?: unknown } })?.operationError
          ?.message ?? "",
      );
      if (message.includes("member_banned")) {
        reviewStatus = "voided";
        clientStatus = "pending";
        personaId = null;
        percentile = null;
        newBadges = [];
        collectedCount = 0;
      } else if (message.includes("score_not_publishable")) {
        try {
          const currentResult = await requireSupabaseSuccess(
            "score.review_status_after_report_race",
            () =>
              admin
                .from("scores")
                .select("review_status")
                .eq("id", scoreId)
                .single(),
          );
          const current = (
            currentResult.data as {
              review_status?: unknown;
            } | null
          )?.review_status;
          if (current !== "pending" && current !== "voided") {
            throw new Error("score_review_status_invalid");
          }
          reviewStatus = current;
          clientStatus = "pending";
          personaId = null;
          percentile = null;
          newBadges = [];
          collectedCount = 0;
        } catch (statusError) {
          log.warn("score.review_status_refresh_fail", {
            scoreId,
            ...errInfo(statusError),
          });
          reportPending = true;
        }
      } else {
        reportPending = true;
      }
    }
  }

  if (reportPending) {
    // The score row is already durable. A retry with the same submissionId
    // returns that row and re-enters commit_score_report until convergence.
    return NextResponse.json(
      {
        error: "score_report_pending",
        scoreId,
        reviewStatus,
        retryable: true,
      },
      {
        status: 503,
        headers: { "Retry-After": "1" },
      },
    );
  }

  return NextResponse.json({
    scoreId,
    status: clientStatus,
    reviewStatus,
    personaId,
    percentile,
    newBadges,
    collectedCount,
    duplicate: result.duplicate,
    messageKey: clientStatus === "registered" ? null : "under_review",
  });
}
