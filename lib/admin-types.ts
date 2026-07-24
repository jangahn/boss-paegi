// 관리자 대시보드 공용 타입·상태 어휘 — server(admin-data)·client(components/admin) 공유.
// (server-only 가 아니어야 클라 컴포넌트가 타입 import 가능.)

export type AdminFunnel = {
  anon_users: number;
  players: number;
  members: number;
  first_gen: number;
  first_purchase: number;
};

export type OrderSummary = {
  revenue_today: number;
  revenue_7d: number;
  revenue_30d: number;
  orders_today: number;
  orders_7d: number;
  orders_30d: number;
  by_status: Record<string, number>;
};

export type AdminOrder = {
  order_uuid: string;
  status: string;
  amount: number;
  credits: number;
  product_id: string;
  /** 프로바이더 거래번호 — 페이앱 mul_no(레거시)/포트원 transactionId */
  pg_tx_id: string | null;
  /** 포트원 paymentId(가맹점 채번, 영숫자). 레거시 페이앱 주문은 null */
  payment_id: string | null;
  provider: string;
  /** 테스트 채널 주문(심사·테스트 계정) — 매출/KPI 집계 제외 대상. 레거시 행은 false. */
  is_test: boolean;
  /** 결제수단 채널(card|tosspay|kakaopay). 0059 이전·레거시 페이앱 주문은 null. */
  pay_channel: string | null;
  created_at: string;
  paid_at: string | null;
  user_id: string;
  display_name: string | null;
  /** 환불 saga(0062) 누계 — committed attempt 합. 부분환불>0, 전액=credits. */
  refunded_credits: number;
  /** 환불 saga(0062) 환불 현금 누계(원). */
  refunded_amount: number;
};

export type LedgerActionType =
  | "settle_stuck"
  | "cancel_refund"
  | "cs_adjust"
  // 환불 saga(0062) 신규 action_type
  | "partial_refund"
  | "refund_release"
  | "refund_switch_manual"
  | "refund_replan"
  | "cancel_intent"
  | "resolve_external_cancellation";

export type LedgerRow = {
  id: string;
  created_at: string;
  action_type: string;
  admin_user_id: string;
  admin_name: string | null;
  target_user_id: string;
  target_name: string | null;
  order_uuid: string | null;
  credit_delta: number;
  order_amount: number | null;
  before_credits: number;
  after_credits: number;
  reason: string;
  metadata: Record<string, unknown> | null;
};

export type LedgerPage = {
  rows: LedgerRow[];
  total: number;
  page: number;
  pageSize: number;
};

// ── 환불 saga(0062) — 어드민 조회 행 타입·상태 어휘 ──

/** attempt 미종결(open) 6종 — uq_refund_attempts_order_open 과 동일 집합. */
export const OPEN_ATTEMPT_STATES = [
  "prepared",
  "pg_requested",
  "pg_pending",
  "pg_succeeded",
  "manual_pending",
  "manual_review",
] as const;

/** request 비종단 4종 — idx_refund_requests_state 부분 인덱스와 동일 집합. */
export const ACTIVE_REQUEST_STATES = ["building", "prepared", "processing", "blocked"] as const;

/** order_refund_attempts 조회 행(어드민 목록·경고용 요약). */
export type RefundAttemptRow = {
  id: string;
  request_id: string;
  order_uuid: string;
  user_id: string;
  display_name: string | null;
  state: string;
  rail: string;
  qty: number;
  amount: number;
  rate_bps: number;
  created_at: string;
  pg_requested_at: string | null;
};

/** refund_requests 조회 행(어드민 목록·경고용 요약). */
export type RefundRequestRow = {
  id: string;
  user_id: string;
  display_name: string | null;
  origin: string;
  scope_order_uuid: string | null;
  requested_qty: number;
  approved_amount: number | null;
  state: string;
  reason: string;
  created_at: string;
};

/** reconciliation_issues 조회 행(어드민 목록·경고용 요약). */
export type ReconIssueRow = {
  id: string;
  type: string;
  order_uuid: string;
  user_id: string;
  display_name: string | null;
  cancellation_id: string | null;
  state: string;
  created_at: string;
};

/** credit_lots 조회 행 — 회원 상세 로트 현황. 잔여 = qty − consumed − refunded − refund_reserved. */
export type UserLotRow = {
  id: string;
  source: string;
  order_uuid: string | null;
  qty: number;
  consumed: number;
  refunded: number;
  refund_reserved: number;
  granted_at: string;
  expires_at: string;
  expired_at: string | null;
  expiration_reason: string | null;
};

// ── 유저 상세 ──
export type MemberInfo = {
  userId: string;
  displayName: string | null;
  email: string | null;
  genCredits: number;
  memberSince: string;
  isAdmin: boolean;
  /** 탈퇴(soft-delete) 시각. null=활성. 있으면 어드민 재활성 대상(0037). */
  deletedAt: string | null;
  /** 어뷰징 상태(0050): clean|flagged|banned. banned=공개 등록 차단. */
  abuseStatus: string;
};

/** 탈퇴자 원본 이메일 검색 결과(스크럽돼 search_members 가 못 찾는 계정). */
export type WithdrawnMatch = {
  userId: string;
  originalEmail: string | null;
  deletedAt: string;
  lastSignInAt: string | null;
};

export type GenerationRow = {
  id: string;
  status: string;
  role: string;
  picked_doll_id: string | null;
  created_at: string;
  candidate_count: number;
};

export type DollRow = {
  id: string;
  image_url: string;
  role: string;
  created_at: string;
  /** 숨김(takedown) soft-delete 시각. null=공개. (탈퇴=하드삭제라 목록서 사라짐.) */
  deleted_at: string | null;
  /** 영구삭제(artifact purge) 시각. null=미purge. set이면 객체 제거됨(복구 불가). */
  artifacts_purged_at: string | null;
};

export type Paged<T> = { rows: T[]; total: number; page: number; pageSize: number };
