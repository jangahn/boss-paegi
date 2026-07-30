// 유저(마이페이지) 공용 포맷 — client/server 양쪽 사용.

/**
 * KST 일시(연·월·일·시:분, 24시간) — 결제·생성권 등 장기 보존 이력의 연도 식별용.
 * 어드민 UI 는 lib/admin-format.fmtKst(연 포함 동일 계열이나 소비처 분리 유지).
 */
export function fmtKstDateTime(iso: string | null): string {
  if (!iso) return "—";
  try {
    const date = new Date(iso);
    if (!Number.isFinite(date.getTime())) return "—";
    return date.toLocaleString("ko-KR", {
      timeZone: "Asia/Seoul",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  } catch {
    return "—";
  }
}
