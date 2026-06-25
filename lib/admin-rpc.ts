import "server-only";

// 운영 RPC 가 raise 하는 알려진 에러 코드 화이트리스트.
// 클라(관리자)엔 이 코드들만 노출 — 예상 외 DB 내부 에러는 generic 으로 가려 정보누출 방지.
const KNOWN_ADMIN_ERRORS = [
  "order_not_found",
  "not_settleable",
  "already_canceled",
  "not_cancelable",
  "member_not_found",
  "reason_invalid",
  "delta_invalid",
  "order_status_changed",
  "status_changed",
  "insufficient_credits",
  // 모더레이션(0034)
  "doll_not_found",
  "report_not_found",
  "report_not_pending",
  "not_admin",
  // 모더레이션 Phase 2(0035) — restore 가 이미 영구삭제(purged)된 doll 에 대해 raise.
  "already_purged",
];

/** RPC 에러 → 안전한 코드(화이트리스트 매칭, 아니면 action_failed). */
export function adminRpcErrorCode(error: { message?: string } | null): string {
  const m = error?.message ?? "";
  return KNOWN_ADMIN_ERRORS.find((k) => m.includes(k)) ?? "action_failed";
}
