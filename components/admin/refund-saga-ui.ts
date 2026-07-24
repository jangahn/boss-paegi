// 환불 saga(v0.76) 어드민 UI 공용 어휘 — 상태/이슈 라벨·색, 오류 코드 한글화.
// server(RSC)·client 양쪽 사용(server-only 아님). 코드 정본은 0062 DDL·lib/refund-saga.ts §38 매핑.

/** attempt.state 라벨·색 — CreditLedgerTable EVENT_META 와 동일 뱃지 토큰(bg-<색>/15 + text-<색>). */
export const ATTEMPT_STATE_META: Record<string, { label: string; cls: string }> = {
  prepared: { label: "준비됨", cls: "bg-zinc-500/15 text-zinc-500" },
  pg_requested: { label: "PG 요청됨", cls: "bg-sky-500/15 text-sky-600" },
  pg_pending: { label: "PG 처리 중", cls: "bg-amber-500/15 text-amber-600" },
  pg_succeeded: { label: "PG 성공·확정 대기", cls: "bg-emerald-500/15 text-emerald-600" },
  manual_pending: { label: "수동 지급 대기", cls: "bg-orange-500/15 text-orange-600" },
  manual_review: { label: "수동 검토", cls: "bg-red-500/15 text-red-500" },
  committed: { label: "확정", cls: "bg-emerald-500/15 text-emerald-600" },
  released: { label: "해제됨", cls: "bg-zinc-500/15 text-zinc-500" },
};

/** request.state 라벨·색 — 비종단(building·prepared·processing·blocked)은 운영 큐 대상. */
export const REQUEST_STATE_META: Record<string, { label: string; cls: string }> = {
  building: { label: "작성 중", cls: "bg-zinc-500/15 text-zinc-500" },
  prepared: { label: "준비됨", cls: "bg-sky-500/15 text-sky-600" },
  processing: { label: "처리 중", cls: "bg-amber-500/15 text-amber-600" },
  blocked: { label: "차단됨", cls: "bg-red-500/15 text-red-500" },
  partial: { label: "부분 완료", cls: "bg-orange-500/15 text-orange-600" },
  completed: { label: "완료", cls: "bg-emerald-500/15 text-emerald-600" },
  cancelled: { label: "취소됨", cls: "bg-zinc-500/15 text-zinc-500" },
  failed: { label: "실패", cls: "bg-red-500/15 text-red-500" },
};

/** 대사 이슈(reconciliation_issues.type) 한글 라벨. invariant_violation 은 이슈가 아님(Sentry 전용). */
export const ISSUE_TYPE_LABELS: Record<string, string> = {
  late_paid: "늦은 결제 확정",
  unmatched_cancellation: "미귀속 PG 취소",
  cancellation_discrepancy: "취소 재관측 불일치",
  economic_over_refund: "경제 초과",
  manual_pg_cancel: "수동 PG 취소",
};

/** credit_lots.source 라벨 — 회원 상세 로트 현황. */
export const LOT_SOURCE_LABELS: Record<string, string> = {
  purchase: "구매",
  signup_bonus: "가입 보너스",
  cs_grant: "CS 지급",
  legacy_free: "전환 보전",
};

/** credit_lots.expiration_reason 라벨. */
export const LOT_EXPIRATION_LABELS: Record<string, string> = {
  natural: "자연 만료",
  account_deleted: "탈퇴 회수",
  order_canceled: "주문 취소",
};

/** /api/admin/refund-credits process outcome 라벨(§B.8.1). */
export const PROCESS_OUTCOME_LABELS: Record<string, string> = {
  processed: "환불 완료",
  pending: "PG 처리 대기 중 — 잠시 후 재시도로 확정하세요",
  outstanding: "PG 상태 확인 실패 — 재시도가 필요해요",
  manual_review: "수동 검토 필요 — 환불 큐에서 처리하세요",
  blocked: "차단됨",
  no_op: "이미 처리된 시도예요",
};

/** /api/admin/cancel outcome 라벨(§B.8.2). */
export const CANCEL_OUTCOME_LABELS: Record<string, string> = {
  canceled: "취소 완료(미지급 주문 — 회수 없음)",
  already_canceled: "이미 취소된 주문이에요",
  refund_prepared: "환불 요청이 준비됐어요 — 환불 큐에서 실행하세요",
  resolved_full: "PG 전액 취소 관측 — 자동 종결 완료",
  ineligible: "자동 종결 불가 — 환불 큐에서 수동 화해가 필요해요",
  canceled_unpaid: "취소 완료(미지급 주문 — 회수 없음)",
  observed: "PG 취소 관측 기록됨 — 경제 해소는 환불 큐에서 진행하세요",
};

/** saga 오류 코드(§38) → 한글. 미등록 코드는 refundErrMsg 가 원문 코드로 폴백. */
export const REFUND_ERR_KO: Record<string, string> = {
  // 409 충돌
  request_conflict: "같은 요청 ID 가 다른 내용으로 이미 존재해요.",
  invalid_state: "현재 상태에서 허용되지 않는 동작이에요 — 새로고침 후 확인하세요.",
  version_conflict: "다른 처리와 충돌했어요 — 새로고침 후 다시 시도하세요.",
  order_has_open_refund: "이 주문에 진행 중인 환불 시도가 있어요 — 환불 큐에서 처리하세요.",
  payout_ref_duplicate: "이미 사용된 지급 참조번호예요.",
  pg_state_mismatch: "포트원 상태가 로컬과 모순돼요 — 운영 확인이 필요해요.",
  pg_state_pending: "포트원 결제상태가 아직 진행형이라 종단 확정이 불가해요 — 잠시 후 재시도하세요.",
  // 404
  order_not_found: "주문을 찾지 못했어요.",
  attempt_not_found: "환불 시도를 찾지 못했어요.",
  request_not_found: "환불 요청을 찾지 못했어요.",
  purchase_lot_not_found: "구매 로트를 찾지 못했어요.",
  issue_not_found: "이슈를 찾지 못했어요.",
  event_not_found: "취소 이벤트를 찾지 못했어요.",
  member_not_found: "회원 정보를 찾지 못했어요.",
  // 400 검증
  missing_fields: "필수 값이 빠졌어요.",
  malformed: "요청 형식이 올바르지 않아요.",
  reason_invalid: "사유는 5~500자여야 해요.",
  note_invalid: "메모는 5~500자여야 해요.",
  qty_invalid: "수량이 올바르지 않아요.",
  qty_exceeds_available: "로트 잔여 수량을 초과했어요.",
  qty_exceeds_order_remaining: "주문 환불 가능 잔량을 초과했어요.",
  nothing_to_refund: "환불할 잔량이 없어요.",
  order_not_paid: "결제 완료된 주문이 아니에요.",
  cra_future: "고객 요청 시점이 미래예요.",
  payout_ref_invalid: "지급 참조번호 형식이 올바르지 않아요(영숫자 . _ : - 128자 이내).",
  evidence_invalid: "증빙이 올바르지 않아요(지급 참조·증빙 uuid·PG 무이동 확인).",
  economic_exceeds_remaining: "경제 수량이 남은 회수 가능분을 초과했어요.",
  issue_not_open: "이미 종결된 이슈예요.",
  event_requires_resolution: "이 취소 이벤트는 무시할 수 없어요 — 경제 화해가 필요해요.",
  event_still_unmatched: "미종단 이벤트예요 — 취소 화해(경제 귀속)가 선행돼야 해요.",
  not_cancelable: "취소할 수 없는 상태의 주문이에요.",
  already_canceled: "이미 취소된 주문이에요.",
  use_refund_saga: "이미 결제된 주문 — 환불(수량 환불 saga)로 처리하세요.",
  paid_at_required: "PG 결제시각을 확인할 수 없어 지급 종결이 불가해요.",
  status_changed: "주문 상태가 방금 변경됐어요 — 새로고침 후 다시 확인하세요.",
  invalid_action: "지원하지 않는 액션이에요.",
  invalid_mode: "지원하지 않는 모드예요.",
  // 5xx·연동
  pg_unreachable: "포트원 연결 실패 — 잠시 후 재시도하세요.",
  portone_not_configured: "포트원 연동(PORTONE_V2_API_SECRET)이 설정되지 않았어요.",
  service_maintenance: "크레딧 유지보수 모드예요 — 컷오버 완료 후 다시 시도하세요.",
  invariant_violation: "불변식 위반으로 전체 롤백됐어요 — Sentry 확인이 필요해요.",
  action_failed: "처리 중 오류가 발생했어요. 잠시 후 다시 시도하세요.",
};

/** 오류 코드 → 사용자 메시지(미등록 코드는 코드 원문 노출 — blocked 디버깅용). */
export const refundErrMsg = (code: string | null | undefined): string =>
  (code && REFUND_ERR_KO[code]) || (code ? `오류: ${code}` : "처리 실패");
