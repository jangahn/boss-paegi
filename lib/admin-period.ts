/**
 * 어드민 분석 공통 기간 윈도우(v1.06 하이브리드) — 3페이지(대시보드·게임플레이·공유유입) 공용 규약.
 * KST 달력일 기준: 오늘=오늘 하루(라이브), 7/30=오늘 포함 최근 N일, 전체=수집 시작~오늘.
 * 데이터 경로: 오늘 = *_rows_for_day RPC 라이브, 어제까지 = 롤업(day_kst < 오늘)만 — 이중계산 차단.
 * URL 파라미터는 기존 ?days=7|30 링크 호환을 유지하고 today|all 을 추가한다.
 */

export type StatWindow = 1 | 7 | 30 | "all";

export function parseStatWindow(raw: string | undefined): StatWindow {
  if (raw === "today") return 1;
  if (raw === "30") return 30;
  if (raw === "all") return "all";
  return 7;
}

export function statWindowParam(window: StatWindow): string {
  if (window === 1) return "today";
  if (window === "all") return "all";
  return String(window);
}

export const STAT_WINDOW_TABS: readonly { window: StatWindow; label: string }[] = [
  { window: 1, label: "오늘" },
  { window: 7, label: "7일" },
  { window: 30, label: "30일" },
  { window: "all", label: "전체" },
];

/** 페이지 부제용 윈도우 서술. */
export function statWindowLabel(window: StatWindow): string {
  if (window === 1) return "오늘(KST, 실시간)";
  if (window === "all") return "전체 기간";
  return `최근 ${window}일(KST 자정 기준)`;
}
