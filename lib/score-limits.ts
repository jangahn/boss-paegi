/**
 * 점수 한도 — 서버 (/api/score) 와 클라이언트 (GameOverModal) 가 공유.
 * 클라이언트가 제출 전 같은 공식으로 클램프하므로 정상 플레이에서
 * score_out_of_range 가 발생하지 않는다 (서버 검증은 변조 방어용으로 유지).
 */

/** 평균 점수/sec 상한. v0.5 무기 최대 효율 (싸대기 연타 × 속도 2× × 콤보 4×
 *  ≈ 750/sec, fling+벽콤보 spike 포함) 에 안전 마진. */
export const MAX_AVG_SCORE_PER_SEC = 2000;
/** 1시간 — 사실상 무제한 체감이되 점수 상한 (duration × 2000/sec) 방어선 유지.
 *  DB check (migration 0004) 와 동일해야 함. */
export const MAX_DURATION_MS = 60 * 60 * 1000;
export const MAX_SCORE_HARD = 10_000_000; // DB check constraint 와 동일

/** 콤보 배율 상한 — 무한 증가 시 점수가 서버 한도를 뚫는 것 방지 (4× = 콤보 30) */
export const MAX_COMBO_MULTIPLIER = 4;

/** durationMs 에 대한 서버 허용 최대 점수 */
export function scoreCeiling(durationMs: number): number {
  return Math.min(
    Math.ceil((durationMs / 1000) * MAX_AVG_SCORE_PER_SEC),
    MAX_SCORE_HARD
  );
}

/** 제출 직전 클라이언트 클램프 — 서버 검증과 동일 공식 */
export function clampForSubmit(score: number, durationMs: number) {
  const duration = Math.min(Math.max(1, Math.round(durationMs)), MAX_DURATION_MS);
  return {
    score: Math.min(Math.max(0, Math.round(score)), scoreCeiling(duration)),
    durationMs: duration,
  };
}
