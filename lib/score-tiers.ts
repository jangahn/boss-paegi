/**
 * 점수 단계(구간) — 단일 소스. **순수 모듈**(import 0): 클라/서버/node --test/config 도메인이 공용.
 *
 * 단계 개수(TIER_COUNT=5)는 코드 고정(롤 콘텐츠 튜플·등급 배열 길이가 컴파일/스키마로 결합).
 * 단계 **경계 4값은 `score_config.thresholds`(어드민 콘솔)** 가 소유하며 이 파일의 기본값은
 * 콘솔 미발행/검증실패 폴백이다. 소비자는 반드시 cfg 의 thresholds 를 전달한다(누락 = 기본 경계로 드리프트).
 *
 * v1.24: 10단계(1만 간격)→5단계(경계 1만·3만·6만·10만). 롤 콘텐츠는 인접 쌍 병합으로 이관.
 */

export const TIER_COUNT = 5;

/** 경계 배열(길이 = TIER_COUNT-1). 오름차순, 1,000점 단위(어드민 「점수 구간 분포」 1,000점 버킷 합산 정합 조건). */
export type ScoreThresholds = readonly number[];

export const SCORE_THRESHOLDS_DEFAULT: ScoreThresholds = [10_000, 30_000, 60_000, 100_000];

/** 경계 입력 단위(score_config zod 와 에디터 안내 공용). */
export const THRESHOLD_STEP = 1_000;

/** 점수 → 0..TIER_COUNT-1 단계. 음수/NaN/0 은 0, 마지막 경계 이상은 최상위. */
export function scoreTier(score: number, thresholds: ScoreThresholds = SCORE_THRESHOLDS_DEFAULT): number {
  if (!Number.isFinite(score) || score <= 0) return 0;
  let tier = 0;
  for (const t of thresholds) {
    if (score >= t) tier += 1;
    else break;
  }
  return Math.min(TIER_COUNT - 1, tier);
}

/** 단계 i 의 점수 구간 표기 — 에디터 칸 라벨·분포 섹션 공용(중복 정의 금지). 예: "0~9,999" · "100,000+". */
export function tierBandLabel(i: number, thresholds: ScoreThresholds = SCORE_THRESHOLDS_DEFAULT): string {
  const idx = Math.max(0, Math.min(i, TIER_COUNT - 1));
  const lo = idx === 0 ? 0 : (thresholds[idx - 1] ?? 0);
  if (idx >= TIER_COUNT - 1) return `${lo.toLocaleString()}+`;
  const hi = (thresholds[idx] ?? lo + 1) - 1;
  return `${lo.toLocaleString()}~${hi.toLocaleString()}`;
}

/** 경계 배열 유효성 — 정수·THRESHOLD_STEP 배수·엄격 오름차순·[min,max] 안. zod refine·에디터 공용. */
export function isValidThresholds(
  v: unknown,
  min = THRESHOLD_STEP,
  max = Number.MAX_SAFE_INTEGER,
): v is ScoreThresholds {
  if (!Array.isArray(v) || v.length !== TIER_COUNT - 1) return false;
  let prev = -Infinity;
  for (const t of v) {
    if (typeof t !== "number" || !Number.isSafeInteger(t) || t % THRESHOLD_STEP !== 0 || t < min || t > max) {
      return false;
    }
    if (t <= prev) return false;
    prev = t;
  }
  return true;
}

/** 등급 1개 — 라벨 + 한 줄 평. */
export type ReportGrade = {
  /** 등급 라벨 — "패는 사람"(직장인)의 스트레스 해소 경지 */
  label: string;
  /** 등급 한 줄 평 */
  comment: string;
};

/** 단계를 결정하는 데 필요한 config 단면 — score_config 값이 그대로 만족(구조적 타입, 순환 import 회피). */
export type ScoreTierConfig = {
  thresholds: ScoreThresholds;
  grades: readonly ReportGrade[];
};
