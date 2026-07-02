import { resolveWeapon } from "@/lib/weapons";

/**
 * 게임 플레이 상세 스탯 — "플레이 해석 리포트"(페르소나/뱃지)의 입력.
 * GameOverModal(클라, 즉시 페르소나 계산)·/api/score(서버, 검증·저장)·/share(렌더) 공용 순수 모듈.
 * 단순 score/combo 를 넘어 "무엇으로·얼마나 다양하게·얼마나 몰아쳤나"를 담는다.
 */

// v2: ultScore 추가(궁극기 난타 점수 분리) → 검증이 sum(weaponScores)≈score-ultScore 로 바뀜.
export const GAMEPLAY_STATS_VERSION = 2;

export type GameplayStats = {
  v: number;
  hitCount: number;
  maxCombo: number;
  durationMs: number;
  /** 무기별 타격 횟수 (궁극기 난타 제외) */
  weaponCounts: Record<string, number>;
  /** 무기별 누적 점수(콤보배율 적용 final gain, 궁극기 제외) — 주력무기를 점수기여로 산정 */
  weaponScores: Record<string, number>;
  /** 궁극기 난타로 얻은 점수(스탯/뱃지엔 미반영, 검증용). v1 데이터엔 없음 → 0 취급 */
  ultScore: number;
  /** 카테고리(tap/swipe/throw/shoot/grab/draw)별 타격 횟수 — weaponCounts 에서 파생 */
  categoryCounts: Record<string, number>;
  ultimateCount: number;
  /** 첫 타격까지 걸린 시간(ms) */
  firstHitMs: number | null;
  /** 플레이 중 들른 배경 key 목록 */
  bgVisits: string[];
  /** 타격 간격 변동계수(CV=σ/μ) — 어뷰징 jitter 신호(S5). 봇≈0. 표본부족/구데이터면 null/undefined. */
  intervalCV?: number | null;
};

/** 원시 스냅샷(스토어 + 페이지) → GameplayStats. categoryCounts 는 weaponCounts 에서 파생. */
export function buildGameplayStats(input: {
  hitCount: number;
  maxCombo: number;
  durationMs: number;
  weaponCounts: Record<string, number>;
  weaponScores: Record<string, number>;
  ultScore: number;
  ultimateCount: number;
  firstHitMs: number | null;
  bgVisits: string[];
  intervalCV?: number | null;
}): GameplayStats {
  const categoryCounts: Record<string, number> = {};
  for (const [k, n] of Object.entries(input.weaponCounts)) {
    const cat = resolveWeapon(k).category;
    categoryCounts[cat] = (categoryCounts[cat] ?? 0) + n;
  }
  return {
    v: GAMEPLAY_STATS_VERSION,
    hitCount: input.hitCount,
    maxCombo: input.maxCombo,
    durationMs: Math.round(input.durationMs),
    weaponCounts: input.weaponCounts,
    weaponScores: input.weaponScores,
    ultScore: Math.max(0, Math.round(input.ultScore)),
    categoryCounts,
    ultimateCount: input.ultimateCount,
    firstHitMs: input.firstHitMs,
    bgVisits: input.bgVisits,
    intervalCV: input.intervalCV ?? null,
  };
}

function sumValues(obj: Record<string, number>): number {
  let s = 0;
  for (const v of Object.values(obj)) s += v;
  return s;
}

/** 페르소나/뱃지 룰이 쓰는 파생 지표 */
export type DerivedStats = {
  distinctWeapons: number;
  distinctCategories: number;
  /** 분당 타격수 (hitCount/durationMin) */
  apm: number;
  /** 카테고리별 타격 비중 0~1 */
  categoryShare: Record<string, number>;
  /** 점수 기여 최다 무기 key */
  topWeaponByScore: string | null;
};

export function deriveStats(stats: GameplayStats): DerivedStats {
  const totalHits = sumValues(stats.weaponCounts) || stats.hitCount || 1;
  const categoryShare: Record<string, number> = {};
  for (const [cat, n] of Object.entries(stats.categoryCounts)) {
    categoryShare[cat] = n / totalHits;
  }
  let topWeaponByScore: string | null = null;
  let best = -1;
  for (const [k, v] of Object.entries(stats.weaponScores)) {
    if (v > best) {
      best = v;
      topWeaponByScore = k;
    }
  }
  const minutes = stats.durationMs > 0 ? stats.durationMs / 60000 : 0;
  return {
    distinctWeapons: Object.keys(stats.weaponCounts).length,
    distinctCategories: Object.keys(stats.categoryCounts).length,
    apm: minutes > 0 ? Math.round(stats.hitCount / minutes) : 0,
    categoryShare,
    topWeaponByScore,
  };
}

/**
 * 서버 조작방지 정합성 검증 — 클라가 보낸 stats 가 제출 score 와 일관적인지.
 * 실패 시 stats 폐기(점수 저장은 항상 성공). final gain 기준.
 */
export function validateGameplayStats(
  stats: GameplayStats,
  submittedScore: number
): boolean {
  // v1/v2 둘 다 수용(배포 전환기 stale 클라). v1 은 ultScore 없음 → 0 으로 tolerant.
  if (!stats || (stats.v !== 1 && stats.v !== 2)) return false;
  const ultScore = stats.v >= 2 ? Math.max(0, stats.ultScore ?? 0) : 0;
  const hitsSum = sumValues(stats.weaponCounts);
  // 타격수 정합 (작은 오차 허용 — grab fling/wall hit 등 weaponKey 없는 경로 소수 존재 가능)
  if (Math.abs(hitsSum - stats.hitCount) > Math.max(5, stats.hitCount * 0.1))
    return false;
  // 점수 정합 — 무기별 final gain 합 ≈ (제출 score − 궁극기 점수). v1 은 ultScore=0.
  const scoreSum = sumValues(stats.weaponScores);
  const manualScore = submittedScore - ultScore;
  if (Math.abs(scoreSum - manualScore) > Math.max(50, submittedScore * 0.05))
    return false;
  return true;
}
