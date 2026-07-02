/**
 * 점수 공개 가시성 — 어뷰징 방지의 단일 판정 헬퍼(공개면 누락 방지용 공용화).
 *
 * `scores.review_status` 가 공개 가시성의 source of truth 다(0050).
 *  - registered: 자동 제출 판정 clean
 *  - pending:    자동/cron 이 어뷰징 의심 → 운영자 검토 대기(숨김)
 *  - cleared:    운영자가 수동으로 정상 확인(노출)
 *  - voided:     운영자 무효 처리 또는 banned 유저 제출(숨김)
 *
 * 공개면(리더보드/백분위/공유/OG/히스토리)은 반드시 visible 만 노출한다.
 * SQL 경로는 `SCORE_VISIBLE_STATUS_SQL` 를 where 절에 쓴다.
 */
export type ReviewStatus = "registered" | "pending" | "cleared" | "voided";

/** 공개면에 노출 가능한 상태. */
export const SCORE_VISIBLE_STATUSES: readonly ReviewStatus[] = [
  "registered",
  "cleared",
];

/** SQL where 절용 리터럴 — `review_status in ('registered','cleared')`. */
export const SCORE_VISIBLE_STATUS_SQL = "('registered','cleared')";

/** 공개면 노출 가능 여부. null/undefined(구 스키마)는 registered 취급 → 노출. */
export function isVisibleReviewStatus(status: string | null | undefined): boolean {
  if (status == null) return true; // 0050 미적용 환경 호환(기존 행=registered)
  return status === "registered" || status === "cleared";
}
