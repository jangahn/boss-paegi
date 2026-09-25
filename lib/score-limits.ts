/**
 * 점수 한도 — 서버 (/api/score) 와 클라이언트 (GameOverModal) 가 공유.
 * 클라이언트가 제출 전 같은 공식으로 클램프하므로 정상 플레이에서
 * score_out_of_range 가 발생하지 않는다 (서버 검증은 변조 방어용으로 유지).
 */

/** 평균 점수/sec **저장 하드상한**(클라 클램프 + 서버 400 거부 + DB 함수 리터럴(0133)의 기준). v1.59: 제한 시간 판 사람 실측
 *  초당 3,748(멀티터치 투척 · 맵 6곳 · 궁극기 7회)이 종전 상한 4000 에 바짝 붙어 5500 으로(사용자 결정 — S3 4500 위 여유).
 *  (v1.36 4000 = 무기 최대 효율 750/sec × 저글링 합산 ×4 + 마진, v1.35 까지 2000.)
 *  ⚠ 봉투 계층 불변식: 이 값(5500, 저장 상한) ≥ `SCORE_PER_SEC_MAX`(4500, anti-abuse-rules S3 의심
 *  플래그) ≥ 인간 max(`HUMAN_SCORE_PER_SEC_OBSERVED` 3748, 2026-09-25 제한 시간 판 실측). 상한은 정상 플레이를 절대 거부하지 않게 넉넉히, S3 는 그보다
 *  아래에서 리뷰 플래그. 두 값은 다른 계층이라 일부러 다르다 — 같게 맞추지 말 것(상한↓=정상 거부, S3↑=봇 누락).
 *  텔레메트리는 이 클램프 전 raw 를 저장 → cron C1 이 완주 텔레에서 tscore(raw) ≥ 제출(clamp)을 보고
 *  오탐하지 않도록 one-sided(0055). DB `bp_submit_score_with_review_core`와 텔레메트리 적재 `bp_ingest_telemetry_delta_core`
 *  의 suspicious 비율 임계도 같은 값을 리터럴로 쓴다(0133) — 계약 테스트 telemetry-ingest-envelope.test.ts.*/
export const MAX_AVG_SCORE_PER_SEC = 5500;
/** 30분 — 한 판 최대 플레이타임 캡(제출 클램프). DB check(1h=3,600,000)보다 타이트 = 앱이 더 빡센 캡.
 *  ⚠ 캡 도달 제출은 clampForSubmit 이 정확히 이 값으로 안착시키고 route 400 은 strict `>` 라 통과
 *  — 정상 경로(캡 완주·탭 방치)다. anti-abuse S7 은 이를 오탐하지 않도록 점수 하한과 결합(v5). */
export const MAX_DURATION_MS = 30 * 60 * 1000;
/** 점수 하드 캡 800만(v1.36, 종전 500만) — DB check(10M)보다 타이트 = 서버·DB 함수가 8M 에서 차단(scoreCeiling).
 *  제한 시간(v1.53) 뒤 한 판 점수는 최대 플레이 시간 봉투(어드민 상한 600초 + 5초 × 5500/초 = 332.75만) 안이라 이 캡이 정상 판을
 *  먼저 막지 않는다. 무제한 시절 기준(30분 × 초당 상한 ≤ 하드 캡)은 v1.59 저장 상한 5500 에서 990만이 되어 폐기. */
export const MAX_SCORE_HARD = 8_000_000;

/** 콤보 배율 상한 — 무한 증가 시 점수가 서버 한도를 뚫는 것 방지 (4× = 콤보 30) */
export const MAX_COMBO_MULTIPLIER = 4;

/** 강제 종료 grace — 한도 도달 후 진행 중 궁극기 마무리 여유. final 이 소폭 초과해도 hard cap 내라 제출 OK(보강#4). */
export const FORCE_END_GRACE_MS = 4000;

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
