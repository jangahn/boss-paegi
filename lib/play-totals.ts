/**
 * 누적 합계(v1.55) — 본인 이전 공개 판(registered · cleared, 판 통계 있는 판)의 타격 · 궁극기 · 플레이 시간 합.
 * `get_play_totals` · `get_my_play_totals`(0132) 응답. 누적 뱃지(타격 · 궁극기 · 플레이)의 달성값 = 이전 합계 + 이 판.
 * 서버 부여는 지금 제출 중인 판을 뺀 합계, 인게임 도전과 종료 화면은 판 시작 때 읽은 합계를 쓴다.
 * 의존성 없는 모듈(서버 · 클라 · 로더 없는 테스트 공용).
 */
export type PlayTotals = { hits: number; ultimates: number; playMs: number };

export const PLAY_TOTALS_ZERO: PlayTotals = { hits: 0, ultimates: 0, playMs: 0 };

/** 합계 RPC 한 행 응답 검증 — 형식이 다르면 null(서버는 리포트 재시도, 인게임 도전은 중지). */
export function parsePlayTotals(data: unknown): PlayTotals | null {
  if (!Array.isArray(data) || data.length !== 1) return null;
  const row = data[0] as { hits?: unknown; ultimates?: unknown; play_ms?: unknown } | null;
  const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (!row || !count(row.hits) || !count(row.ultimates) || !count(row.play_ms)) return null;
  return { hits: row.hits, ultimates: row.ultimates, playMs: row.play_ms };
}
