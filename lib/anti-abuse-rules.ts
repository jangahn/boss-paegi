import "server-only";

import {
  resolveWeapon,
  SWIPE_FACTOR_MAX,
  THROW_FACTOR_MAX,
  GRAB_FLING_POWER_BONUS,
} from "@/lib/weapons";
import { MAX_COMBO_MULTIPLIER } from "@/lib/score-limits";
import { VARIETY_CAP, ULT_HITS, FRESH_WEAPON_BONUS } from "@/lib/game-tuning";
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
 *
 * v2(2026-07-03, S2 교정): strength 를 1타 base 로 가정한 v1 산식이 속도 배율 경로
 * (swipe ×2.0 / throw ×2.2 / grab fling strength+30)와 fresh +300(weaponScores 귀속)을
 * 미반영해 정상 플레이를 flag(실측 grab 271.8/타 > 구 임계 184, 오탐 2건).
 * → 실효 max base 유도 + fresh 정확 차감 + margin 1.05. 클린 v2 535튜플 전수 FP 0 검증.
 * 위조 봉투는 S3(1,400/s)가 계속 바인딩이라 불변, 고정 데미지 무기는 오히려 강화.
 *
 * v3(2026-07-08, cron C1/C1B 교정 + S7 가중 정합): cron 정합검사(0054)를 "완주 텔레메트리"
 * (end_reason ∈ normal/time_limit/score_limit)로 한정 — 절단 텔레(hidden_timeout 등)는 duration·score
 * 가 부분값이라 정상 플레이를 오탐(전수조사: C1B 발화 100%가 hidden_timeout 절단 아티팩트).
 * 또한 CRITICAL 가중 set 의 dead entry(S7_DURATION_MISMATCH — 발화 id 는 S7_DURATION_LONG)를 제거
 * (mismatch-critical 역할은 cron C1B 가 이미 ×3 로 담당, 제출시 S7 은 magnitude-only weight 1).
 *
 * v4(2026-07-08, cron C1 방향 교정): cron C1(점수 정합, 0055)을 one-sided 로 — 제출 점수는 클램프
 * (min(raw, durationSec×MAX_AVG_SCORE_PER_SEC))되고 텔레는 raw 저장이라 완주 텔레에선 항상 tscore ≥ 제출.
 * 대칭 |score−tscore| 은 이 정상 클램프까지 오탐(예 score 5c5e6435: raw 171K→ceiling 130K, 32%) →
 * "제출 > 텔레(raw)" 방향만 flag(원점수 초과=위조). C1B(duration)는 클램프가 없어 대칭 유지(설계 '결').
 *
 * v5(2026-07-13, S7 점수 하한 결합): S7 이 duration 단독(>15분)이라 세션 캡(30분) 도달 정상 제출을
 * 100% 오탐 — 캡 도달 시 clampForSubmit 이 durationMs 를 정확히 MAX_DURATION_MS 로 안착시키고
 * route 400 은 strict `>` 라 경계값이 통과한다. 캡 완주(실측 3e2f930e)와 탭 방치(게임 벽시계는
 * hidden 중에도 진행 — 실사례 0528dbad: 46초 플레이 후 방치, 1,194점, admin cleared) 모두 해당.
 * → S7 = 장기 세션 AND 점수 하한(S7_LONG_SESSION_SCORE_FLOOR=126만, S3 의 15분 봉투 상수).
 * 무플래그 위조 상한 126만이 duration 전 구간에서 불변(공격자 이득 정확히 0)이고, 실측 어뷰저
 * 패턴(4be023f8: 2.19M/29.6분 — score/초 1,231 이라 S3 침묵)은 계속 포착.
 */
export const ANTI_ABUSE_RULES_VERSION = "2026-07-anti-abuse-v5";

/** 리더보드 노출 가치가 있어 텔레메트리 정합이 필요한 점수 하한(S6). */
export const NOTABLE_SCORE = 300_000;
/** 장기 세션 경계(S7) — 정상 최대 플레이 12.2분(실측 2026-07-02) 위 마진.
 *  ⚠ 이 값 단독 초과는 어뷰징 증거가 아니다: 세션 캡(30분, score-limits.ts MAX_DURATION_MS =
 *  session_limits.maxPlaySeconds 상한)까지 간 제출은 clampForSubmit 이 정확히 캡으로 안착시키고
 *  route 400 은 strict `>` 라 경계값이 통과 — 캡 완주·탭 방치가 전부 여기 떨어진다(v5 오탐 교정).
 *  S7 은 반드시 S7_LONG_SESSION_SCORE_FLOOR 와 결합해 발화한다. */
export const MAX_REASONABLE_DURATION_MS = 900_000; // 15분
/** 궁극기 1회당 상한(보수적, ~43타×상한). ultScore 몰아넣기(S10) 방어용. */
export const MAX_ULT_SCORE_PER_USE = 8_000;
/** 지속(≥60s) 최대 타격속도(/초). 인간 14.6, 여기 넘으면 flag. */
export const HITS_PER_SEC_SUSTAINED = 18;
/** 임의 길이 최대 타격속도(/초). 인간 버스트 19.1. */
export const HITS_PER_SEC_BURST = 25;
/** 최대 평균 score/초(S3 의심 플래그). 인간 검증 최대 1,267 + 마진.
 *  ⚠ 봉투 계층 불변식: `MAX_AVG_SCORE_PER_SEC`(2000, score-limits.ts 저장 하드상한) ≥ 이 값(1400, 의심
 *  플래그) ≥ 인간 max(1267). 상한은 "저장 거부"용(정상 안 막게 넉넉), S3 는 "의심→리뷰"용이라 서로 다른
 *  계층 — 같게 두지 말 것. 상한을 낮추면 정상 고득점을 거부하고, S3 를 올리면 봇을 놓친다. */
export const SCORE_PER_SEC_MAX = 1_400;
/** S7 점수 하한 = S3 의 15분 봉투 상수(SCORE_PER_SEC_MAX × 900s = 1,260,000).
 *  S3 는 score/초 비율이라 duration 에 비례해 봉투가 늘어난다 — 15분 초과 구간에선 이 상수를
 *  하한으로 걸어야 무플래그 위조 상한(126만)이 duration 과 무관하게 불변이다. 두 신호는 상보적:
 *  ≤15분 & >126만은 산술상 반드시 S3(126만/900s=1,400/s 초과), >15분 & >126만은 S7.
 *  인간이 이 하한을 넘으려면 700/s+ 를 15분 이상 지속해야 함(검증 최대: 버스트 1,267/s·최장 12.2분). */
export const S7_LONG_SESSION_SCORE_FLOOR =
  SCORE_PER_SEC_MAX * (MAX_REASONABLE_DURATION_MS / 1000); // 1,260,000
/** S2 무기별 타당성 최소 타격수(소량 표본 노이즈 방지 — fresh 는 정확 차감으로 별도 처리). */
export const S2_MIN_HITS = 20;
/** S2 실효 이론상한 대비 허용 배수 — 상한이 정확한 supremum(실측 극값이 캡에 정확 안착)이라
 *  구현 드리프트 보험만. 클린 v2 535튜플 전수에서 FP 0 (2026-07-03). */
export const S2_MARGIN = 1.05;
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

/** 무기 1타 실효 최대 base — PlayScene 득점 경로의 배율 상한에서 유도(전 경로 확인 2026-07-03).
 *  tap(fist/hammer)·shoot(gun)·draw(pen)는 strength 고정(배율 경로 없음).
 *  grab 은 fling 릴리즈(strength + power×30)가 상한 — 벽히트(15 고정)는 avg 를 낮추는 방향. */
function effectiveMaxBase(weaponKey: string): number {
  const w = resolveWeapon(weaponKey);
  switch (w.category) {
    case "swipe":
      return Math.round(w.strength * SWIPE_FACTOR_MAX);
    case "throw":
      return Math.round(w.strength * THROW_FACTOR_MAX);
    case "grab":
      return w.strength + GRAB_FLING_POWER_BONUS;
    default:
      return w.strength; // tap · shoot · draw — 고정 데미지
  }
}

/** 무기 1타 이론 최대 점수 = 실효 max base × 콤보캡 × 다양성캡. */
function theoreticalMaxPerHit(weaponKey: string): number {
  return effectiveMaxBase(weaponKey) * MAX_COMBO_MULTIPLIER * (1 + VARIETY_CAP);
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

  // ── S2: 무기별 점수 타당성(fresh 차감 avg/hit > 실효 이론상한×margin, 최소 타격수 게이트) ──
  // fresh 300 은 무기 첫 타격에 정확히 1회 weaponScores 에 플랫 가산(gameStore charge) → 정확 차감.
  // 위조 payload 가 fresh 를 안 넣으면 무기당 최대 +300 유리할 뿐(S3 봉투 대비 무시 가능).
  if (stats) {
    for (const [w, cnt] of Object.entries(stats.weaponCounts)) {
      if (cnt < S2_MIN_HITS) continue;
      const avg = ((stats.weaponScores[w] ?? 0) - FRESH_WEAPON_BONUS) / cnt;
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

  // ── S7: 장기 세션 × 고득점(15분 초과 구간의 봉투 연장) ──
  // duration 단독 조건은 정상 경로를 오탐한다(v5 교정): 세션 캡 도달 제출은 정확히 30분으로
  //   안착·통과하므로 캡 완주/탭 방치 유저가 100% 걸렸음(실사례 0528dbad). 점수 하한을 결합하면
  //   저점수 장기 세션은 통과하고, 봉투(무플래그 위조 상한 126만)는 duration 전 구간 불변.
  // ⚠ 텔레메트리 duration 즉시 대조는 하지 않는다: 텔레메트리는 delta 스트리밍이라 점수 제출 시점엔
  //   미확정(부분값)이라 정상 플레이도 큰 "불일치"로 오탐됨(실측: 손 게임 dur 17.5s vs 미확정 텔레 10s).
  //   duration/score 정합은 텔레메트리 확정 후 cron(C1b, integrity_scan_recent)만 담당(설계 원안).
  if (durationMs > MAX_REASONABLE_DURATION_MS && score > S7_LONG_SESSION_SCORE_FLOOR)
    signals.push({ id: "S7_DURATION_LONG", value: durationMs, threshold: MAX_REASONABLE_DURATION_MS, source: "submit" });

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

  // 치명 신호(정합 불가·확정)엔 가중치. S7_DURATION_LONG 은 장기세션×고득점 결합 신호(정황)라
  // 미포함(weight 1) — duration mismatch-critical 역할은 cron C1B(0054, ×3)로 이관됨.
  const CRITICAL = new Set(["S8_TELEMETRY_SUSPICIOUS", "S10_ULT_NO_USES", "BANNED_MEMBER"]);
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
