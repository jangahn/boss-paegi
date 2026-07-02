import "server-only";

import { resolveWeapon } from "@/lib/weapons";
import { MAX_COMBO_MULTIPLIER } from "@/lib/score-limits";
import { VARIETY_CAP, ULT_HITS } from "@/lib/game-tuning";
import { validateGameplayStats, type GameplayStats } from "@/lib/stats";

/**
 * 점수 어뷰징 판정 — 제출 시점 신호(S1~S10)의 단일 출처.
 *
 * 서버가 body.score 를 재계산하진 못하지만(완전 재계산은 후속), 제출 payload 와
 * 연결 텔레메트리(있으면)로 "정상 인간 플레이로 불가능한" 케이스를 flag 한다.
 * 발화 시 review_status='pending'(공개면 숨김, 운영자 검토). 하드 리젝은 두지 않는다.
 *
 * 임계는 실측 기준선(전수조사 2026-07-02)에서 파생 — 인간/봇 4~6배 격차라 보수적으로 잡아 오탐 ~0:
 *  - 인간 지속 타격속도 ≤ ~15타/초(60s+), 버스트 ~19타/초. 봇 55~62타/초.
 *  - 인간 검증 최대 score/초 1,267. 정상 고득점 duration ≤ 12.2분.
 * 튜닝 변경 시 임계 재점검 + RULES_VERSION 상향.
 */
export const ANTI_ABUSE_RULES_VERSION = "2026-07-anti-abuse-v1";

/** 리더보드 노출 가치가 있어 텔레메트리 정합이 필요한 점수 하한(S6). */
export const NOTABLE_SCORE = 300_000;
/** 정상 최대 플레이 12.2분(실측) 위 마진. 초과 시 pending(S7). 30분 하드캡은 route 가 400. */
export const MAX_REASONABLE_DURATION_MS = 900_000; // 15분
/** 궁극기 1회당 상한(보수적, ~43타×상한). ultScore 몰아넣기(S10) 방어용. */
export const MAX_ULT_SCORE_PER_USE = 8_000;
/** 지속(≥60s) 최대 타격속도(/초). 인간 14.6, 여기 넘으면 flag. */
export const HITS_PER_SEC_SUSTAINED = 18;
/** 임의 길이 최대 타격속도(/초). 인간 버스트 19.1. */
export const HITS_PER_SEC_BURST = 25;
/** 최대 평균 score/초. 인간 검증 최대 1,267. */
export const SCORE_PER_SEC_MAX = 1_400;
/** S2 무기별 타당성 최소 타격수(fresh 보너스·소량 타격 FP 방지). */
export const S2_MIN_HITS = 20;
/** S2 이론상한 대비 허용 배수. */
export const S2_MARGIN = 1.15;
/** S5 타격간격 CV 하한 — 이 미만이면 거의 등간격(봇/매크로). 인간은 편차가 커 훨씬 높음.
 *  ⚠ 클라 CV 계측이 실플레이로 아직 보정 안 됨 → 오탐(정상 유저 숨김) 방지 위해 **보수적 0.08**
 *  (확실한 봇 영역)으로 시작. 어드민 interval_cv 분포로 인간 CV 확인 후 0.15 까지 상향 검토. */
export const INTERVAL_CV_MIN = 0.08;

export type ReviewDecision = "registered" | "pending" | "voided";

export type AbuseSignal = {
  id: string;
  value: number | null;
  threshold: number | null;
  source: "submit";
};

export type TelemetrySnapshot = {
  score: number | null;
  durationMs: number | null;
  suspicious: boolean;
} | null;

export type EvaluateInput = {
  score: number;
  durationMs: number;
  telemetrySessionId: string | null;
  /** 서버에서 canonical 로 재구성한 stats(없으면 null). */
  stats: GameplayStats | null;
  /** 연결 텔레메트리 즉시 스냅샷(delta 스트리밍이라 미확정일 수 있음 — 최종 정합은 cron). */
  telemetry: TelemetrySnapshot;
  /** banned 유저 제출 — 무조건 voided. */
  isBanned: boolean;
};

export type EvaluateResult = {
  reviewStatus: ReviewDecision;
  signals: AbuseSignal[];
  abuseScore: number;
  /** score_flags.evidence — 관리자 리뷰용 제출당시 스냅샷(allowlist, PII/raw 금지). */
  evidence: Record<string, unknown>;
};

/** 무기 1타 이론 최대 점수 = strength × 콤보캡 × 다양성캡. */
function theoreticalMaxPerHit(weaponKey: string): number {
  return resolveWeapon(weaponKey).strength * MAX_COMBO_MULTIPLIER * (1 + VARIETY_CAP);
}

/**
 * 제출 시점 판정. 발화 신호가 하나라도 있으면 pending(banned 는 voided).
 * abuseScore = 신호 개수(치명 신호 가중) — 어드민 큐 정렬용.
 */
export function evaluateSubmission(input: EvaluateInput): EvaluateResult {
  const { score, durationMs, telemetrySessionId, stats, telemetry, isBanned } = input;
  const signals: AbuseSignal[] = [];
  const durationSec = durationMs > 0 ? durationMs / 1000 : 0;
  const scorePerSec = durationSec > 0 ? score / durationSec : score;

  // ── S4: stats 누락/검증실패 (clean 등록 불가) ──
  if (!stats) {
    signals.push({ id: "S4_STATS_MISSING", value: null, threshold: null, source: "submit" });
  } else if (!validateGameplayStats(stats, score)) {
    signals.push({ id: "S4_STATS_INVALID", value: null, threshold: null, source: "submit" });
  }

  // ── S1: 지속 타격속도(hits/초) ──
  const hitCount = stats?.hitCount ?? null;
  const hitsPerSec = hitCount != null && durationSec > 0 ? hitCount / durationSec : null;
  if (hitsPerSec != null) {
    const limit = durationMs >= 60_000 ? HITS_PER_SEC_SUSTAINED : HITS_PER_SEC_BURST;
    if (hitsPerSec > limit)
      signals.push({ id: "S1_HITS_PER_SEC", value: round1(hitsPerSec), threshold: limit, source: "submit" });
  }

  // ── S2: 무기별 점수 타당성(avg/hit > 이론상한×margin, 최소 타격수 게이트) ──
  if (stats) {
    for (const [w, cnt] of Object.entries(stats.weaponCounts)) {
      if (cnt < S2_MIN_HITS) continue;
      const avg = (stats.weaponScores[w] ?? 0) / cnt;
      const cap = theoreticalMaxPerHit(w) * S2_MARGIN;
      if (avg > cap) {
        signals.push({ id: `S2_WEAPON_AVG:${w}`, value: round1(avg), threshold: round1(cap), source: "submit" });
        break; // 하나면 충분
      }
    }
  }

  // ── S3: 평균 score/초 ──
  if (scorePerSec > SCORE_PER_SEC_MAX)
    signals.push({ id: "S3_SCORE_PER_SEC", value: round1(scorePerSec), threshold: SCORE_PER_SEC_MAX, source: "submit" });

  // ── S5: 타격 간격 규칙성(CV) — 봇/매크로는 거의 등간격(CV≈0). 표본 충분(hitCount≥100)일 때만. ──
  const intervalCV = stats?.intervalCV;
  if (typeof intervalCV === "number" && (hitCount ?? 0) >= 100 && intervalCV < INTERVAL_CV_MIN)
    signals.push({ id: "S5_INTERVAL_CV", value: round2(intervalCV), threshold: INTERVAL_CV_MIN, source: "submit" });

  // ── S6: notable 점수인데 텔레메트리 링크 없음 ──
  if (score >= NOTABLE_SCORE && !telemetrySessionId)
    signals.push({ id: "S6_NOTABLE_NO_TELEMETRY", value: score, threshold: NOTABLE_SCORE, source: "submit" });

  // ── S7: duration plausibility(magnitude + 텔레 duration 즉시 대조) ──
  if (durationMs > MAX_REASONABLE_DURATION_MS)
    signals.push({ id: "S7_DURATION_LONG", value: durationMs, threshold: MAX_REASONABLE_DURATION_MS, source: "submit" });
  if (telemetry?.durationMs && telemetry.durationMs > 0) {
    const diff = Math.abs(durationMs - telemetry.durationMs) / telemetry.durationMs;
    if (diff > 0.2)
      signals.push({ id: "S7_DURATION_MISMATCH", value: round2(diff), threshold: 0.2, source: "submit" });
  }

  // ── S8: 연결 텔레메트리가 이미 suspicious(단조 → 오토클리커는 제출시 true) ──
  if (telemetry?.suspicious)
    signals.push({ id: "S8_TELEMETRY_SUSPICIOUS", value: 1, threshold: 1, source: "submit" });

  // ── S10: ultScore 상한(validateGameplayStats 가 못 막는 몰아넣기) ──
  if (stats) {
    const ultScore = Math.max(0, stats.ultScore ?? 0);
    const ultUses = Math.max(0, stats.ultimateCount ?? 0);
    // switch 가속·마진 반영해 관대하게(FP 방지): ULT_HITS/2 마다 1회 + 2회 여유.
    const maxUltUses = Math.floor((stats.hitCount ?? 0) / (ULT_HITS / 2)) + 2;
    if (ultScore > 0 && ultUses === 0)
      signals.push({ id: "S10_ULT_NO_USES", value: ultScore, threshold: 0, source: "submit" });
    else if (ultUses > maxUltUses)
      signals.push({ id: "S10_ULT_COUNT", value: ultUses, threshold: maxUltUses, source: "submit" });
    else {
      const effectiveUses = Math.min(ultUses || maxUltUses, maxUltUses);
      const cap = effectiveUses * MAX_ULT_SCORE_PER_USE;
      if (ultScore > cap)
        signals.push({ id: "S10_ULT_SCORE", value: ultScore, threshold: cap, source: "submit" });
    }
  }

  const reviewStatus: ReviewDecision = isBanned
    ? "voided"
    : signals.length > 0
      ? "pending"
      : "registered";
  if (isBanned)
    signals.push({ id: "BANNED_MEMBER", value: null, threshold: null, source: "submit" });

  // 치명 신호(정합 불가·확정)엔 가중치.
  const CRITICAL = new Set(["S7_DURATION_MISMATCH", "S8_TELEMETRY_SUSPICIOUS", "S10_ULT_NO_USES", "BANNED_MEMBER"]);
  const abuseScore = signals.reduce((a, s) => a + (CRITICAL.has(s.id) ? 3 : 1), 0);

  const evidence: Record<string, unknown> = {
    submittedScore: score,
    durationMs,
    hitCount,
    scorePerSec: round1(scorePerSec),
    hitRate: hitsPerSec != null ? round1(hitsPerSec) : null,
    intervalCV: typeof intervalCV === "number" ? round2(intervalCV) : null,
    weaponCounts: stats?.weaponCounts ?? null,
    weaponScores: stats?.weaponScores ?? null,
    ultScore: stats?.ultScore ?? null,
    ultimateCount: stats?.ultimateCount ?? null,
    telemetryScore: telemetry?.score ?? null,
    telemetryDurationMs: telemetry?.durationMs ?? null,
    telemetrySuspicious: telemetry?.suspicious ?? null,
    rulesVersion: ANTI_ABUSE_RULES_VERSION,
  };

  return { reviewStatus, signals, abuseScore, evidence };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
