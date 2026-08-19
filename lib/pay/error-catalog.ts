/**
 * 결제 오류 카탈로그 — 코드→HTTP status→사용자 문구→클라 동작의 **단일 소스**.
 *
 * 2026-08-19 사고의 구조 원인이 "RPC 문자열 → 매퍼 Set → route 분기 → 클라 문구
 * 사전"의 4계층 수동 동기화였다(등록 하나 빠지면 가짜 fatal 500 + 무정보 문구).
 * 이 파일이 그 4계층을 대체한다:
 *  - 서버: `resolvePayError(code)` 로 status/심각도 결정 (lib/refund-saga.ts 매퍼가 위임)
 *  - 클라: 같은 카탈로그에서 `message`/`action` 을 읽는다 (문구 이중화 없음)
 *  - CI: __tests__/payments/error-catalog-contract.test.ts 가
 *    DB raise 전수(db-raise-codes.gen.ts)와의 정합을 강제 — 등록 누락은 머지 불가.
 *
 * 서버·클라 공용 순수 데이터 모듈 — server-only 금지.
 */

/** 클라 특수 동작. 문구 표시 외에 화면 전환/자가치유가 필요한 코드에만 부여. */
export type PayErrorAction = "login" | "consent" | "stale_reload";

export type PayErrorEntry = {
  /** HTTP 응답 status — 서버 응답과 클라 해석이 공유하는 값. */
  status: 400 | 401 | 403 | 404 | 409 | 429 | 503;
  /**
   * 사용자 표면(/credits) 문구. 어드민/운영 표면 전용 코드는 생략 —
   * 그 표면에서는 코드 자체가 운영자 정보이고, 클라 fallback 이 코드를 노출한다.
   */
  message?: string;
  action?: PayErrorAction;
  /** db = 마이그레이션 raise 유래(P0001), route = 앱 라우트가 직접 생성. */
  origin: "db" | "route";
};

const STALE_RELOAD_MESSAGE =
  "결제 화면 정보가 갱신됐어요. 페이지를 새로고침한 뒤 다시 시도해주세요.";
const PRIOR_INTENT_MESSAGE =
  "직전 결제 요청을 정리하지 못했어요. 잠시 후 다시 시도해주세요.";

/**
 * 정상 거절 전수. 여기 없는 DB raise 는 db-raise-codes.gen.ts 스냅샷에 있으면
 * 불변식 위반(500 + Sentry fatal — 도달 자체가 버그), 스냅샷에도 없으면
 * 등록 누락 결함(500 + `pay.uncataloged_reject`, fatal 아님)으로 처리된다.
 */
export const PAY_ERROR_CATALOG = {
  // ── checkout: 화면이 든 상품/문구/증거가 서버 최신과 어긋남 → 자가치유(새로고침)
  withdrawal_limit_confirmation_required: {
    status: 400,
    message: STALE_RELOAD_MESSAGE,
    action: "stale_reload",
    origin: "db",
  },
  checkout_offer_evidence_mismatch: {
    status: 400,
    message: STALE_RELOAD_MESSAGE,
    action: "stale_reload",
    origin: "db",
  },
  checkout_product_name_changed: {
    status: 400,
    message: STALE_RELOAD_MESSAGE,
    action: "stale_reload",
    origin: "db",
  },
  client_refresh_required: {
    status: 400,
    message: STALE_RELOAD_MESSAGE,
    action: "stale_reload",
    origin: "db",
  },
  legacy_checkout_refresh_required: {
    status: 409,
    message: STALE_RELOAD_MESSAGE,
    action: "stale_reload",
    origin: "db",
  },
  checkout_upgrade_required: {
    status: 409,
    message: STALE_RELOAD_MESSAGE,
    action: "stale_reload",
    origin: "db",
  },
  checkout_state_changed: {
    status: 409,
    message: STALE_RELOAD_MESSAGE,
    action: "stale_reload",
    origin: "route",
  },
  invalid_product: {
    status: 400,
    message: STALE_RELOAD_MESSAGE,
    action: "stale_reload",
    origin: "db",
  },
  product_amount_mismatch: {
    status: 400,
    message: STALE_RELOAD_MESSAGE,
    action: "stale_reload",
    origin: "db",
  },

  // ── checkout: 직전 결제 요청 잔존(자동 해소 실패 잔여 케이스)
  checkout_prior_intent_unresolved: {
    status: 409,
    message: PRIOR_INTENT_MESSAGE,
    origin: "db",
  },
  checkout_reuse_ambiguous: {
    status: 409,
    message: PRIOR_INTENT_MESSAGE,
    origin: "db",
  },
  checkout_prior_intent_paid: {
    status: 409,
    message:
      "직전 결제가 완료된 것으로 확인됐어요. 잠시 후 크레딧 지급 내역을 확인해주세요.",
    origin: "route",
  },
  checkout_reuse_required: {
    status: 409,
    message: PRIOR_INTENT_MESSAGE,
    origin: "db",
  },

  // ── checkout: 요청/영수증 정합
  checkout_receipt_invalid: {
    status: 400,
    message: "결제 요청 정보가 올바르지 않아요. 새로고침 후 다시 시도해주세요.",
    origin: "db",
  },
  checkout_request_conflict: {
    status: 409,
    message: "같은 결제 요청이 이미 처리 중이에요. 잠시 후 다시 시도해주세요.",
    origin: "db",
  },
  request_conflict: {
    status: 409,
    message: "같은 결제 요청이 이미 처리 중이에요. 잠시 후 다시 시도해주세요.",
    origin: "db",
  },
  checkout_evidence_conflict: {
    status: 409,
    message: "같은 결제 요청이 이미 처리 중이에요. 잠시 후 다시 시도해주세요.",
    origin: "db",
  },
  invalid_payment_evidence_snapshot: {
    status: 400,
    message: "결제 요청 정보가 올바르지 않아요. 새로고침 후 다시 시도해주세요.",
    origin: "db",
  },

  // ── checkout: 계정 상태
  account_not_found: {
    status: 404,
    message: "계정 정보를 찾지 못했어요. 다시 로그인해주세요.",
    action: "login",
    origin: "db",
  },
  account_deleted: {
    status: 400,
    message: "탈퇴한 계정이에요. 새 계정으로 로그인해주세요.",
    action: "login",
    origin: "db",
  },

  // ── route 게이트(인증·한도·설정) — /api/pay/checkout 이 직접 생성
  unauthorized: {
    status: 401,
    action: "login",
    origin: "route",
  },
  member_only: {
    status: 403,
    action: "login",
    origin: "route",
  },
  consent_required: {
    status: 403,
    action: "consent",
    origin: "route",
  },
  rate_limited: {
    status: 429,
    message: "결제 요청이 너무 잦아요. 잠시 후 다시 시도해주세요.",
    origin: "route",
  },
  payment_unavailable: {
    status: 503,
    message: "결제 기능이 잠시 비활성화돼 있어요. 잠시 후 다시 시도해주세요.",
    origin: "route",
  },
  payment_misconfigured: {
    status: 503,
    message: "결제 설정에 문제가 있어요. 잠시 후 다시 시도해주세요.",
    origin: "route",
  },
  channel_unavailable: {
    status: 503,
    message: "선택한 결제 수단을 지금 사용할 수 없어요. 다른 수단을 선택해주세요.",
    origin: "route",
  },
  invalid_request: {
    status: 400,
    message: "요청 형식이 올바르지 않아요. 새로고침 후 다시 시도해주세요.",
    origin: "route",
  },

  // ── 웹훅/정산/취소 표면(운영·어드민) — 사용자 문구 없음, 코드가 곧 운영 정보
  payment_evidence_incomplete: { status: 503, origin: "route" },
  payment_evidence_mismatch: { status: 409, origin: "route" },
  payment_evidence_snapshot_conflict: { status: 409, origin: "db" },
  checkout_withdrawal_evidence_immutable: { status: 409, origin: "db" },
  commerce_display_evidence_immutable: { status: 409, origin: "db" },
  cancel_intent_receipt_invalid: { status: 400, origin: "db" },
  user_id_required: { status: 400, origin: "db" },
  order_status_changed: { status: 409, origin: "db" },
  stale_cancel_lease: { status: 409, origin: "db" },
  payment_pending: { status: 409, origin: "db" },
  invalid_state: { status: 409, origin: "db" },
  version_conflict: { status: 409, origin: "db" },
  order_has_open_refund: { status: 409, origin: "db" },
  refund_preflight_mismatch: { status: 409, origin: "db" },
  cancellation_amount_mismatch: { status: 409, origin: "db" },
  cancellation_status_mismatch: { status: 409, origin: "db" },
  cancellation_event_conflict: { status: 409, origin: "db" },
  order_not_found: { status: 404, origin: "db" },
  attempt_not_found: { status: 404, origin: "db" },
  generation_not_found: { status: 404, origin: "db" },
  purchase_lot_not_found: { status: 404, origin: "db" },
  event_not_found: { status: 404, origin: "db" },
  issue_not_found: { status: 404, origin: "db" },
  member_not_found: { status: 404, origin: "db" },
  reason_invalid: { status: 400, origin: "db" },
  qty_invalid: { status: 400, origin: "db" },
  rail_invalid: { status: 400, origin: "db" },
  cra_future: { status: 400, origin: "db" },
  amount_nonpositive: { status: 400, origin: "db" },
  payout_ref_invalid: { status: 400, origin: "db" },
  order_not_paid: { status: 400, origin: "db" },
  qty_exceeds_available: { status: 400, origin: "db" },
  qty_exceeds_order_remaining: { status: 400, origin: "db" },
  nothing_to_refund: { status: 400, origin: "db" },
  insufficient_credits: { status: 400, origin: "db" },
  rail_not_pg: { status: 400, origin: "db" },
  rail_not_manual: { status: 400, origin: "db" },
  malformed: { status: 400, origin: "route" },
  note_invalid: { status: 400, origin: "db" },
  resolution_invalid: { status: 400, origin: "db" },
  evidence_invalid: { status: 400, origin: "route" },
  verification_source_invalid: { status: 400, origin: "db" },
  cancel_id_required: { status: 400, origin: "db" },
  result_invalid: { status: 400, origin: "db" },
  economic_exceeds_remaining: { status: 400, origin: "db" },
  no_cancel_intent: { status: 400, origin: "db" },
  event_requires_resolution: { status: 400, origin: "db" },
  event_still_unmatched: { status: 400, origin: "db" },
  economic_resolution_required: { status: 400, origin: "db" },
  delta_invalid: { status: 400, origin: "db" },
  not_cancelable: { status: 400, origin: "db" },
  already_canceled: { status: 400, origin: "db" },
  use_refund_saga: { status: 400, origin: "db" },
  cancellation_id_invalid: { status: 400, origin: "db" },
  amount_invalid: { status: 400, origin: "db" },
  open_refund_blocks_delete: { status: 400, origin: "db" },
  open_issue_blocks_delete: { status: 400, origin: "db" },
  paid_at_required: { status: 400, origin: "db" },
  paid_at_future: { status: 400, origin: "db" },
  invalid_provider: { status: 400, origin: "db" },
  invalid_channel: { status: 400, origin: "db" },
  payment_id_format: { status: 400, origin: "db" },
  not_settleable: { status: 400, origin: "db" },
  status_changed: { status: 409, origin: "db" },
  invalid_job: { status: 400, origin: "db" },
  invalid_phase: { status: 400, origin: "db" },
} as const satisfies Record<string, PayErrorEntry>;

export type PayErrorCode = keyof typeof PAY_ERROR_CATALOG;

export type ResolvedPayError =
  | { kind: "cataloged"; code: PayErrorCode; entry: PayErrorEntry }
  | { kind: "invariant"; code: string }
  | { kind: "uncataloged"; code: string };

/**
 * 서버측 분류. `dbRaiseCodes` 는 lib/pay/db-raise-codes.gen.ts 의 전수 스냅샷 —
 * 카탈로그 밖이지만 스냅샷 안이면 불변식 위반(도달=버그, fatal), 스냅샷 밖이면
 * 등록 누락(비-fatal 결함 신호).
 */
export function resolvePayError(
  code: string,
  dbRaiseCodes: ReadonlySet<string>,
): ResolvedPayError {
  if (Object.prototype.hasOwnProperty.call(PAY_ERROR_CATALOG, code)) {
    const key = code as PayErrorCode;
    return { kind: "cataloged", code: key, entry: PAY_ERROR_CATALOG[key] };
  }
  if (dbRaiseCodes.has(code)) return { kind: "invariant", code };
  return { kind: "uncataloged", code };
}

function catalogEntry(code: string): PayErrorEntry | null {
  return Object.prototype.hasOwnProperty.call(PAY_ERROR_CATALOG, code)
    ? (PAY_ERROR_CATALOG[code as PayErrorCode] as PayErrorEntry)
    : null;
}

/** 클라 문구 조회 — 사전에 없으면 코드를 숨기지 않는다(사유 코드 노출 원칙). */
export function payErrorMessage(code: string): string {
  const message = catalogEntry(code)?.message;
  if (message) return message;
  return `결제 요청이 거절됐어요(사유 코드: ${code}). 잠시 후 다시 시도해주세요.`;
}

export function payErrorAction(code: string): PayErrorAction | null {
  return catalogEntry(code)?.action ?? null;
}
