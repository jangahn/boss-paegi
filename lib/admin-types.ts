// 관리자 대시보드 공용 타입 — server(admin-data)·client(components/admin) 공유.
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
  // 머니 패스(0023)에서 환불 진행 상태. 목록(search_orders)만 채움 — 대시보드 조회는 생략(undefined).
  refund_state?: string | null;
};

export type LedgerActionType = "settle_stuck" | "cancel_refund" | "cs_adjust";

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
