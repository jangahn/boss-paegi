import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { PG_RETRY_CUTOFF_MS } from "@/lib/refund-saga";
import { log, errInfo } from "@/lib/log";
import type {
  AdminFunnel,
  OrderSummary,
  AdminOrder,
  RefundAttemptRow,
  RefundRequestRow,
  ReconIssueRow,
} from "@/lib/admin-types";
import { OPEN_ATTEMPT_STATES, ACTIVE_REQUEST_STATES } from "@/lib/admin-types";

/**
 * 관리자 대시보드 데이터 — server-only, service_role(admin client).
 * 매출/주문 정확수치는 여기(DB)서만(Sentry 아님). 날짜 기준: today=KST 자정 이후, 7d/30d=rolling.
 */

export type { AdminFunnel, OrderSummary, AdminOrder };

const ORDER_SELECT =
  "order_uuid, status, amount, credits, product_id, pg_tx_id, payment_id, provider, is_test, pay_channel, created_at, paid_at, user_id, refunded_credits, refunded_amount, profiles(display_name)";

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
    user_id: r.user_id,
    display_name: p?.display_name ?? null,
    refunded_credits: r.refunded_credits,
    refunded_amount: r.refunded_amount,
  };
}

export async function getAdminFunnel(): Promise<AdminFunnel | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_admin_funnel");
  if (error || !data) {
    log.warn("admin.funnel_fail", errInfo(error));
    return null;
  }
  const row = Array.isArray(data) ? data[0] : data;
  return (row as AdminFunnel) ?? null;
}

export async function getOrderSummary(): Promise<OrderSummary | null> {
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("get_admin_order_summary");
  if (error || !data) {
    log.warn("admin.summary_fail", errInfo(error));
    return null;
  }
  return data as OrderSummary;
}

/** 오래된 결제요청(확인 필요) — 결제 시도(payment_id/pg_tx_id)했으나 2시간+ pending. 미지급 단정 아님.
 *  테스트 주문 제외 — 심사관이 결제창만 열고 이탈하는 게 정상 패턴이라 경고 노이즈만 만든다. */
export async function getStalePending(): Promise<AdminOrder[]> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("orders")
    .select(ORDER_SELECT)
    .eq("status", "pending")
    .eq("is_test", false)
    .not("payment_id", "is", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    log.warn("admin.stale_pending_fail", errInfo(error));
    return [];
  }
  return ((data ?? []) as unknown as RawOrderRow[]).map(mapOrder);
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
  "order_uuid, status, amount, credits, product_id, pg_tx_id, payment_id, provider, is_test, pay_channel, created_at, paid_at, user_id, refunded_credits, refunded_amount";

const ATTEMPT_SELECT =
  "id, request_id, order_uuid, user_id, state, rail, qty, amount, rate_bps, created_at, pg_requested_at";
const REQUEST_SELECT =
  "id, user_id, origin, scope_order_uuid, requested_qty, approved_amount, state, reason, created_at";
const ISSUE_SELECT = "id, type, order_uuid, user_id, cancellation_id, state, created_at";

/** 이슈 중 대시보드 경고 대상 3종 — economic_over_refund·manual_pg_cancel 은 /admin/refunds 큐에서만. */
const WARN_ISSUE_TYPES = ["late_paid", "unmatched_cancellation", "cancellation_discrepancy"];

/** 환불 운영 경고 — 대시보드 최상단(stale pending 보다 높은 우선순위). invariant_violation 은
 *  경고 소스가 아니다(Sentry `pay.refund_invariant_violation` 전용 — open issue 로 저장되지 않음). */
export async function getRefundWarnings(): Promise<RefundWarnings> {
  const admin = createAdminClient();
  const pgStaleIso = new Date(Date.now() - PG_RETRY_CUTOFF_MS).toISOString();
  const [attempts, requests, issues, canceledPaid] = await Promise.all([
    admin
      .from("order_refund_attempts")
      .select(ATTEMPT_SELECT)
      .or(`state.eq.manual_review,and(state.eq.pg_requested,pg_requested_at.lt.${pgStaleIso})`)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
    admin
      .from("refund_requests")
      .select(REQUEST_SELECT)
      .eq("state", "blocked")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
    admin
      .from("reconciliation_issues")
      .select(ISSUE_SELECT)
      .eq("state", "open")
      .in("type", WARN_ISSUE_TYPES)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(20),
    admin.rpc("admin_unreconciled_canceled_orders").select(WARN_SELECT),
  ]);
  if (attempts.error) log.warn("admin.refund_warnings_attempts_fail", errInfo(attempts.error));
  if (requests.error) log.warn("admin.refund_warnings_requests_fail", errInfo(requests.error));
  if (issues.error) log.warn("admin.refund_warnings_issues_fail", errInfo(issues.error));
  if (canceledPaid.error)
    log.warn("admin.refund_unreconciled_rpc_fail", errInfo(canceledPaid.error));

  const withName = <T>(rows: T[] | null | undefined) =>
    (rows ?? []).map((r) => ({ ...r, display_name: null as string | null }));

  const attentionAttempts = withName(
    attempts.data as Omit<RefundAttemptRow, "display_name">[] | null
  );
  const blockedRequests = withName(
    requests.data as Omit<RefundRequestRow, "display_name">[] | null
  );
  const openIssues = withName(issues.data as Omit<ReconIssueRow, "display_name">[] | null);
  const unreconciled = withName(
    canceledPaid.data as Omit<AdminOrder, "display_name">[] | null
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
    admin
      .from("reconciliation_issues")
      .select(ISSUE_SELECT)
      .eq("state", "open")
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(50),
    admin
      .from("refund_requests")
      .select(REQUEST_SELECT)
      .in("state", [...ACTIVE_REQUEST_STATES])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(50),
    admin
      .from("order_refund_attempts")
      .select(ATTEMPT_SELECT)
      .in("state", [...OPEN_ATTEMPT_STATES])
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(50),
  ]);
  if (issues.error) log.warn("admin.refund_queue_issues_fail", errInfo(issues.error));
  if (requests.error) log.warn("admin.refund_queue_requests_fail", errInfo(requests.error));
  if (attempts.error) log.warn("admin.refund_queue_attempts_fail", errInfo(attempts.error));

  const withName = <T>(rows: T[] | null | undefined) =>
    (rows ?? []).map((r) => ({ ...r, display_name: null as string | null }));

  const openIssues = withName(issues.data as Omit<ReconIssueRow, "display_name">[] | null);
  const activeRequests = withName(
    requests.data as Omit<RefundRequestRow, "display_name">[] | null
  );
  const openAttempts = withName(
    attempts.data as Omit<RefundAttemptRow, "display_name">[] | null
  );

  await fillDisplayNames(admin, [...openIssues, ...activeRequests, ...openAttempts]);

  return { openIssues, activeRequests, openAttempts };
}

/** 행들의 display_name 을 profiles 일괄 조회로 채움(실패 시 그대로 null — 표기는 shortId 폴백). */
async function fillDisplayNames(
  admin: ReturnType<typeof createAdminClient>,
  rows: Array<{ user_id: string; display_name: string | null }>
): Promise<void> {
  const userIds = [...new Set(rows.map((r) => r.user_id))];
  if (userIds.length === 0) return;
  const { data, error } = await admin.from("profiles").select("id, display_name").in("id", userIds);
  if (error) {
    log.warn("admin.refund_warnings_names_fail", errInfo(error));
    return;
  }
  const names = new Map((data ?? []).map((p) => [p.id as string, p.display_name as string | null]));
  for (const r of rows) r.display_name = names.get(r.user_id) ?? null;
}
