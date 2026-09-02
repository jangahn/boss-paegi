import "server-only";
import { cache } from "react";
import { createAdminClient } from "@/lib/supabase/admin";
import { PG_RETRY_CUTOFF_MS } from "@/lib/refund-saga";
import { kstDate } from "@/lib/admin-analytics";
import type { StatWindow } from "@/lib/admin-period";
import type {
  AdminFunnel,
  UserComposition,
  UserCompositionStage,
  OrderSummaryWindow,
  AdminOrder,
  RefundAttemptRow,
  RefundRequestRow,
  ReconIssueRow,
} from "@/lib/admin-types";
import { OPEN_ATTEMPT_STATES, ACTIVE_REQUEST_STATES, USER_COMPOSITION_STAGES } from "@/lib/admin-types";
import {
  readSupabaseRowsPaginated,
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
 * 매출/주문 정확수치는 여기(DB)서만(Sentry 아님). 기간은 v1.06 공통 윈도우(KST 달력일, lib/admin-period).
 * 매출·주문 = "현재 진실"(환불·대사 소급 반영) → orders 직조회 윈도우드 RPC.
 * 퍼널 = "역사적 사실"(그날 처음 달성) → 하이브리드: 오늘 = admin_funnel_rows_for_day 라이브,
 * 어제까지 = admin_funnel_rollups(day_kst < 오늘)만 — 0112 단일 소스 규약.
 * v1.17 유저 퍼널·구성: '처음' 행은 위 롤업(first_visit 추가), 전체·다시·회원 행은 기간 내 distinct 라
 * raw RPC admin_user_composition_window(0117) — v1.06 규약의 예외 부류(재방문·로또젠 유저 구성과 동일).
 */

export type { AdminFunnel, OrderSummaryWindow, AdminOrder };

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

const FUNNEL_STEPS = ["anon_users", "players", "members", "first_gen", "first_purchase", "first_visit"] as const;

type FunnelStepRow = { step: string; value: number | string };
const FUNNEL_STEP_SCHEMA = { step: "string", value: "nonnegativeNumeric" } as const;

/** 오늘 하루 코호트 라이브 — 렌더당 1회(React cache). cron 이 쓰는 것과 같은 단일 소스 RPC(0112). */
const liveFunnelToday = cache(async (): Promise<FunnelStepRow[]> => {
  const admin = createAdminClient();
  const data = await requireSupabaseRows(
    "admin.dashboard.funnel_live",
    () => admin.rpc("admin_funnel_rows_for_day", { p_day: kstDate(0) }),
  );
  return validateAdminRows<FunnelStepRow>(
    "admin.dashboard.funnel_live",
    data,
    FUNNEL_STEP_SCHEMA,
  );
});

/**
 * 가입·구매 퍼널(윈도우 코호트) — 하이브리드: 롤업(어제까지) + 라이브(오늘) 단계별 합산.
 * 롤업 도입(0112) 전 과거는 잔존 행 기준 근사(정리된 익명·탈퇴 회원 소급 불가) — 페이지가 각주.
 */
export async function getAdminFunnelWindow(window: StatWindow): Promise<AdminFunnel> {
  const admin = createAdminClient();
  const today = kstDate(0);
  const data = await readSupabaseRowsPaginated(
    "admin.dashboard.funnel_rollup",
    (offset, limit) => {
      let q = admin
        .from("admin_funnel_rollups")
        .select("day_kst,step,value")
        .lt("day_kst", today);
      if (window !== "all") q = q.gte("day_kst", kstDate(window - 1));
      return q
        .order("day_kst", { ascending: true })
        .order("step", { ascending: true })
        .range(offset, offset + limit - 1);
    },
    500,
  );
  const rollup = validateAdminRows<FunnelStepRow & { day_kst: string }>(
    "admin.dashboard.funnel_rollup",
    data,
    { day_kst: "date", ...FUNNEL_STEP_SCHEMA },
  );
  const sums = new Map<string, number>();
  for (const r of [...rollup, ...(await liveFunnelToday())]) {
    sums.set(r.step, (sums.get(r.step) ?? 0) + Number(r.value));
  }
  const bad = [...sums.keys()].filter((s) => !FUNNEL_STEPS.includes(s as (typeof FUNNEL_STEPS)[number]));
  if (bad.length > 0) {
    throw new SupabaseOperationError(
      "admin.dashboard.funnel_rollup",
      new Error(`unknown_funnel_step:${bad.join(",")}`),
    );
  }
  return {
    anon_users: sums.get("anon_users") ?? 0,
    players: sums.get("players") ?? 0,
    members: sums.get("members") ?? 0,
    first_gen: sums.get("first_gen") ?? 0,
    first_purchase: sums.get("first_purchase") ?? 0,
    first_visit: sums.get("first_visit") ?? 0,
  };
}

type CompositionRow = { stage: string; total: number | string; again: number | string; members: number | string };
const COMPOSITION_ROW_SCHEMA = {
  stage: "string",
  total: "nonnegativeNumeric",
  again: "nonnegativeNumeric",
  members: "nonnegativeNumeric",
} as const;

/**
 * 유저 퍼널·구성의 전체·다시·회원(v1.17) — 기간 내 distinct 유저(윈도우 간 일단위 분해 불가 → raw RPC).
 * 방문 = user_visit_days(상호작용·봇 게이트 통과 방문, 익명→회원 이관 원장으로 대표 계정에 접음),
 * 플레이 = scores, 캐릭터 생성 = dolls, 결제 = paid·not is_test 주문. 가입은 롤업 members 가 전체=처음.
 */
export async function getUserCompositionWindow(window: StatWindow): Promise<UserComposition> {
  const admin = createAdminClient();
  const data = await requireSupabaseRows(
    "admin.dashboard.user_composition",
    () => admin.rpc("admin_user_composition_window", { p_days: window === "all" ? null : window }),
  );
  const rows = validateAdminRows<CompositionRow>(
    "admin.dashboard.user_composition",
    data,
    COMPOSITION_ROW_SCHEMA,
  );
  const out = Object.fromEntries(
    USER_COMPOSITION_STAGES.map((s) => [s, { total: 0, again: 0, members: 0 }]),
  ) as UserComposition;
  for (const r of rows) {
    if (!USER_COMPOSITION_STAGES.includes(r.stage as UserCompositionStage)) {
      throw new SupabaseOperationError(
        "admin.dashboard.user_composition",
        new Error(`unknown_composition_stage:${r.stage}`),
      );
    }
    out[r.stage as UserCompositionStage] = {
      total: Number(r.total),
      again: Number(r.again),
      members: Number(r.members),
    };
  }
  return out;
}

/** 매출·주문(선택 윈도우 직조회 — 롤업 없음: 환불·대사의 소급 교정이 즉시 반영돼야 하는 "현재 진실"). */
export async function getOrderSummaryWindow(window: StatWindow): Promise<OrderSummaryWindow> {
  const admin = createAdminClient();
  const data = await requireSupabaseData(
    "admin.dashboard.order_summary_window",
    () =>
      admin.rpc("get_admin_order_summary_window", {
        p_days: window === "all" ? null : window,
      }),
  );
  const rows = validateAdminRows<
    Omit<OrderSummaryWindow, "by_status"> & { by_status: Record<string, unknown> }
  >("admin.dashboard.order_summary_window", [data], {
    revenue: "nonnegativeInteger",
    orders: "nonnegativeInteger",
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
        "admin.dashboard.order_summary_window",
        new Error("invalid_status_count"),
      );
    }
    byStatus[status] = count as number;
  }
  return { revenue: summary.revenue, orders: summary.orders, by_status: byStatus };
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
