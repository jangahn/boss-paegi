import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { PG_RETRY_CUTOFF_MS } from "@/lib/refund-saga";
import type {
  AdminFunnel,
  OrderSummary,
  AdminOrder,
  RefundAttemptRow,
  RefundRequestRow,
  ReconIssueRow,
} from "@/lib/admin-types";
import { OPEN_ATTEMPT_STATES, ACTIVE_REQUEST_STATES } from "@/lib/admin-types";
import {
  requireSupabaseData,
  requireSupabaseRows,
  SupabaseOperationError,
} from "@/lib/supabase-operation";
import {
  requireExactAdminIdCoverage,
  validateAdminRows,
} from "@/lib/admin-read-contract";

/**
 * 관리자 대시보드 데이터 — server-only, service_role(admin client).
 * 매출/주문 정확수치는 여기(DB)서만(Sentry 아님). 날짜 기준: today=KST 자정 이후, 7d/30d=rolling.
 */

export type { AdminFunnel, OrderSummary, AdminOrder };

const ORDER_SELECT =
  "order_uuid, status, amount, credits, product_id, pg_tx_id, payment_id, provider, is_test, pay_channel, created_at, paid_at, error_message, user_id, refunded_credits, refunded_amount, profiles:profiles!orders_user_id_fkey(display_name)";

type RawOrderRow = Omit<AdminOrder, "display_name"> & {
  profiles:
    | { display_name: string | null }
    | { display_name: string | null }[]
    | null;
};

function mapOrder(r: RawOrderRow): AdminOrder {
  const p = Array.isArray(r.profiles) ? r.profiles[0] : r.profiles;
  return {
    order_uuid: r.order_uuid,
    status: r.status,
    amount: r.amount,
    credits: r.credits,
    product_id: r.product_id,
    pg_tx_id: r.pg_tx_id,
    payment_id: r.payment_id,
    provider: r.provider,
    is_test: r.is_test,
    pay_channel: r.pay_channel,
    created_at: r.created_at,
    paid_at: r.paid_at,
    error_message: r.error_message,
    user_id: r.user_id,
    display_name: p?.display_name ?? null,
    refunded_credits: r.refunded_credits,
    refunded_amount: r.refunded_amount,
  };
}

const RAW_ORDER_SCHEMA = {
  order_uuid: "uuid",
  status: "string",
  amount: "nonnegativeInteger",
  credits: "nonnegativeInteger",
  product_id: "string",
  pg_tx_id: "nullableString",
  payment_id: "nullableString",
  provider: "string",
  is_test: "boolean",
  pay_channel: "nullableString",
  created_at: "timestamp",
  paid_at: "nullableTimestamp",
  error_message: "nullableString",
  user_id: "uuid",
  refunded_credits: "nonnegativeInteger",
  refunded_amount: "nonnegativeInteger",
  profiles: "embed",
} as const;

function rawOrders(operation: string, value: unknown): RawOrderRow[] {
  const rows = validateAdminRows<RawOrderRow>(
    operation,
    value,
    RAW_ORDER_SCHEMA,
  );
  for (const row of rows) {
    const profiles =
      row.profiles === null
        ? []
        : Array.isArray(row.profiles)
          ? row.profiles
          : [row.profiles];
    validateAdminRows(`${operation}.profiles`, profiles, {
      display_name: "nullableString",
    });
    if (profiles.length > 1) {
      throw new SupabaseOperationError(
        operation,
        new Error("ambiguous_profile_embed"),
      );
    }
  }
  return rows;
}

export async function getAdminFunnel(): Promise<AdminFunnel | null> {
  const admin = createAdminClient();
  const data = await requireSupabaseRows(
    "admin.dashboard.funnel",
    () => admin.rpc("get_admin_funnel"),
  );
  const rows = validateAdminRows<Record<string, number | string>>(
    "admin.dashboard.funnel",
    data,
    {
      anon_users: "nonnegativeNumeric",
      players: "nonnegativeNumeric",
      members: "nonnegativeNumeric",
      first_gen: "nonnegativeNumeric",
      first_purchase: "nonnegativeNumeric",
    },
  );
  if (rows.length !== 1) {
    throw new SupabaseOperationError(
      "admin.dashboard.funnel",
      new Error("expected_one_funnel_row"),
    );
  }
  const row = rows[0];
  return {
    anon_users: Number(row.anon_users),
    players: Number(row.players),
    members: Number(row.members),
    first_gen: Number(row.first_gen),
    first_purchase: Number(row.first_purchase),
  };
}

export async function getOrderSummary(): Promise<OrderSummary | null> {
  const admin = createAdminClient();
  const data = await requireSupabaseData(
    "admin.dashboard.order_summary",
    () => admin.rpc("get_admin_order_summary"),
  );
  const rows = validateAdminRows<
    Omit<OrderSummary, "by_status"> & { by_status: Record<string, unknown> }
  >("admin.dashboard.order_summary", [data], {
    revenue_today: "nonnegativeInteger",
    revenue_7d: "nonnegativeInteger",
    revenue_30d: "nonnegativeInteger",
    orders_today: "nonnegativeInteger",
    orders_7d: "nonnegativeInteger",
    orders_30d: "nonnegativeInteger",
    by_status: "jsonObject",
  });
  const summary = rows[0];
  const byStatus: Record<string, number> = {};
  for (const [status, count] of Object.entries(summary.by_status)) {
    if (
      status.length === 0 ||
      !Number.isSafeInteger(count) ||
      (count as number) < 0
    ) {
      throw new SupabaseOperationError(
        "admin.dashboard.order_summary",
        new Error("invalid_status_count"),
      );
    }
    byStatus[status] = count as number;
  }
  return { ...summary, by_status: byStatus };
}

/** 오래된 결제요청(확인 필요) — 결제 시도(payment_id/pg_tx_id)했으나 2시간+ pending. 미지급 단정 아님.
 *  테스트 주문 제외 — 심사관이 결제창만 열고 이탈하는 게 정상 패턴이라 경고 노이즈만 만든다. */
export async function getStalePending(): Promise<AdminOrder[]> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const data = await requireSupabaseRows(
    "admin.dashboard.stale_pending",
    () =>
      admin
        .from("orders")
        .select(ORDER_SELECT)
        .eq("status", "pending")
        .eq("is_test", false)
        .not("payment_id", "is", null)
        .lt("created_at", cutoff)
        .order("created_at", { ascending: false })
        .limit(50),
  );
  return rawOrders("admin.dashboard.stale_pending", data).map(mapOrder);
}

// ── 환불 saga(0062) 운영 경고·큐 ──────────────────────────────────────────────────────────

export type RefundWarnings = {
  /** 개입 필요 미종결 attempt — manual_review 전건 + pg_requested 가 3h(재시도 cutoff)+ 경과한 stale. */
  attentionAttempts: RefundAttemptRow[];
  /** blocked request — attempt 가 수동 계열(manual_pending/manual_review)로 멈춘 실행 단위. */
  blockedRequests: RefundRequestRow[];
  /** open 대사 이슈(운영 조치 필요 3종) — late_paid·unmatched_cancellation·cancellation_discrepancy. */
  openIssues: ReconIssueRow[];
  /** 레거시 화해 — saga 이전 PG 취소 웹훅 선도착(canceled+paid_at) 크레딧 미회수(0057 RPC 존속). */
  unreconciled: AdminOrder[];
};

// RPC(setof orders) 행은 profiles 임베드 불가 — 컬럼만 고르고 display_name 은 배치 조회로 채움.
const WARN_SELECT =
  "order_uuid, status, amount, credits, product_id, pg_tx_id, payment_id, provider, is_test, pay_channel, created_at, paid_at, error_message, user_id, refunded_credits, refunded_amount";

const ATTEMPT_SELECT =
  "id, request_id, order_uuid, user_id, state, rail, qty, amount, rate_bps, created_at, pg_requested_at";
const REQUEST_SELECT =
  "id, user_id, origin, scope_order_uuid, requested_qty, approved_amount, state, reason, created_at";
const ISSUE_SELECT = "id, type, order_uuid, user_id, cancellation_id, state, created_at";

/** 이슈 중 대시보드 경고 대상 3종 — economic_over_refund·manual_pg_cancel 은 /admin/refunds 큐에서만. */
const WARN_ISSUE_TYPES = ["late_paid", "unmatched_cancellation", "cancellation_discrepancy"];

const ATTEMPT_SCHEMA = {
  id: "uuid",
  request_id: "uuid",
  order_uuid: "uuid",
  user_id: "uuid",
  state: "string",
  rail: "string",
  qty: "nonnegativeInteger",
  amount: "nonnegativeInteger",
  rate_bps: "nonnegativeInteger",
  created_at: "timestamp",
  pg_requested_at: "nullableTimestamp",
} as const;
const REQUEST_SCHEMA = {
  id: "uuid",
  user_id: "uuid",
  origin: "string",
  scope_order_uuid: "nullableUuid",
  requested_qty: "nonnegativeInteger",
  approved_amount: "nullableNonnegativeInteger",
  state: "string",
  reason: "string",
  created_at: "timestamp",
} as const;
const ISSUE_SCHEMA = {
  id: "uuid",
  type: "string",
  order_uuid: "uuid",
  user_id: "uuid",
  cancellation_id: "nullableUuid",
  state: "string",
  created_at: "timestamp",
} as const;
const ORDER_NO_PROFILE_SCHEMA = {
  order_uuid: "uuid",
  status: "string",
  amount: "nonnegativeInteger",
  credits: "nonnegativeInteger",
  product_id: "string",
  pg_tx_id: "nullableString",
  payment_id: "nullableString",
  provider: "string",
  is_test: "boolean",
  pay_channel: "nullableString",
  created_at: "timestamp",
  paid_at: "nullableTimestamp",
  error_message: "nullableString",
  user_id: "uuid",
  refunded_credits: "nonnegativeInteger",
  refunded_amount: "nonnegativeInteger",
} as const;

/** 환불 운영 경고 — 대시보드 최상단(stale pending 보다 높은 우선순위). invariant_violation 은
 *  경고 소스가 아니다(Sentry `pay.refund_invariant_violation` 전용 — open issue 로 저장되지 않음). */
export async function getRefundWarnings(): Promise<RefundWarnings> {
  const admin = createAdminClient();
  const pgStaleIso = new Date(Date.now() - PG_RETRY_CUTOFF_MS).toISOString();
  const [attempts, requests, issues, canceledPaid] = await Promise.all([
    requireSupabaseRows(
      "admin.refund_warnings.attempts",
      () =>
        admin
          .from("order_refund_attempts")
          .select(ATTEMPT_SELECT)
          .or(
            `state.eq.manual_review,and(state.eq.pg_requested,pg_requested_at.lt.${pgStaleIso})`,
          )
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(20),
    ),
    requireSupabaseRows(
      "admin.refund_warnings.requests",
      () =>
        admin
          .from("refund_requests")
          .select(REQUEST_SELECT)
          .eq("state", "blocked")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(20),
    ),
    requireSupabaseRows(
      "admin.refund_warnings.issues",
      () =>
        admin
          .from("reconciliation_issues")
          .select(ISSUE_SELECT)
          .eq("state", "open")
          .in("type", WARN_ISSUE_TYPES)
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(20),
    ),
    requireSupabaseRows(
      "admin.refund_warnings.unreconciled",
      () =>
        admin
          .rpc("admin_unreconciled_canceled_orders")
          .select(WARN_SELECT),
    ),
  ]);
  const withName = <T>(rows: T[]) =>
    rows.map((r) => ({ ...r, display_name: null as string | null }));

  const attentionAttempts = withName(
    validateAdminRows<Omit<RefundAttemptRow, "display_name">>(
      "admin.refund_warnings.attempts",
      attempts,
      ATTEMPT_SCHEMA,
    ),
  );
  const blockedRequests = withName(
    validateAdminRows<Omit<RefundRequestRow, "display_name">>(
      "admin.refund_warnings.requests",
      requests,
      REQUEST_SCHEMA,
    ),
  );
  const openIssues = withName(
    validateAdminRows<Omit<ReconIssueRow, "display_name">>(
      "admin.refund_warnings.issues",
      issues,
      ISSUE_SCHEMA,
    ),
  );
  const unreconciled = withName(
    validateAdminRows<Omit<AdminOrder, "display_name">>(
      "admin.refund_warnings.unreconciled",
      canceledPaid,
      ORDER_NO_PROFILE_SCHEMA,
    ),
  );

  await fillDisplayNames(admin, [
    ...attentionAttempts,
    ...blockedRequests,
    ...openIssues,
    ...unreconciled,
  ]);

  return { attentionAttempts, blockedRequests, openIssues, unreconciled };
}

export type RefundQueue = {
  /** open 대사 이슈 — 전 타입(최신순). */
  openIssues: ReconIssueRow[];
  /** 비종단 request(building·prepared·processing·blocked, 최신순). */
  activeRequests: RefundRequestRow[];
  /** 미종결(open) attempt 6종(최신순). */
  openAttempts: RefundAttemptRow[];
};

/** /admin/refunds 운영 큐 — RSC 서버 직쿼리 3목록(별도 목록 API 없음). */
export async function getRefundQueue(): Promise<RefundQueue> {
  const admin = createAdminClient();
  const [issues, requests, attempts] = await Promise.all([
    requireSupabaseRows(
      "admin.refund_queue.issues",
      () =>
        admin
          .from("reconciliation_issues")
          .select(ISSUE_SELECT)
          .eq("state", "open")
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(50),
    ),
    requireSupabaseRows(
      "admin.refund_queue.requests",
      () =>
        admin
          .from("refund_requests")
          .select(REQUEST_SELECT)
          .in("state", [...ACTIVE_REQUEST_STATES])
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(50),
    ),
    requireSupabaseRows(
      "admin.refund_queue.attempts",
      () =>
        admin
          .from("order_refund_attempts")
          .select(ATTEMPT_SELECT)
          .in("state", [...OPEN_ATTEMPT_STATES])
          .order("created_at", { ascending: false })
          .order("id", { ascending: false })
          .limit(50),
    ),
  ]);

  const withName = <T>(rows: T[]) =>
    rows.map((r) => ({ ...r, display_name: null as string | null }));

  const openIssues = withName(
    validateAdminRows<Omit<ReconIssueRow, "display_name">>(
      "admin.refund_queue.issues",
      issues,
      ISSUE_SCHEMA,
    ),
  );
  const activeRequests = withName(
    validateAdminRows<Omit<RefundRequestRow, "display_name">>(
      "admin.refund_queue.requests",
      requests,
      REQUEST_SCHEMA,
    ),
  );
  const openAttempts = withName(
    validateAdminRows<Omit<RefundAttemptRow, "display_name">>(
      "admin.refund_queue.attempts",
      attempts,
      ATTEMPT_SCHEMA,
    ),
  );

  await fillDisplayNames(admin, [...openIssues, ...activeRequests, ...openAttempts]);

  return { openIssues, activeRequests, openAttempts };
}

/** 행들의 display_name 을 profiles 일괄 조회로 채움. 조회 장애는 이름 없음이 아니다. */
async function fillDisplayNames(
  admin: ReturnType<typeof createAdminClient>,
  rows: Array<{ user_id: string; display_name: string | null }>
): Promise<void> {
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  if (userIds.length === 0) return;
  const data = await requireSupabaseRows(
    "admin.refund_display_names",
    () =>
      admin
        .from("profiles")
        .select("id, display_name")
        .in("id", userIds),
  );
  const profiles = validateAdminRows<{
    id: string;
    display_name: string | null;
  }>("admin.refund_display_names", data, {
    id: "uuid",
    display_name: "nullableString",
  });
  requireExactAdminIdCoverage(
    "admin.refund_display_names",
    userIds,
    profiles.map((profile) => profile.id),
  );
  const names = new Map(
    profiles.map((profile) => [profile.id, profile.display_name]),
  );
  for (const r of rows) r.display_name = names.get(r.user_id) ?? null;
}
