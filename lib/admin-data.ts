import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import type { AdminFunnel, OrderSummary, AdminOrder } from "@/lib/admin-types";

/**
 * 관리자 대시보드 데이터 — server-only, service_role(admin client).
 * 매출/주문 정확수치는 여기(DB)서만(Sentry 아님). 날짜 기준: today=KST 자정 이후, 7d/30d=rolling.
 */

export type { AdminFunnel, OrderSummary, AdminOrder };

const ORDER_SELECT =
  "order_uuid, status, amount, credits, product_id, mul_no, created_at, paid_at, user_id, profiles(display_name)";

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
    mul_no: r.mul_no,
    created_at: r.created_at,
    paid_at: r.paid_at,
    user_id: r.user_id,
    display_name: p?.display_name ?? null,
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

/** 오래된 결제요청(확인 필요) — 결제 시도(mul_no)했으나 2시간+ pending. 미지급 단정 아님. */
export async function getStalePending(): Promise<AdminOrder[]> {
  const admin = createAdminClient();
  const cutoff = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("payapp_orders")
    .select(ORDER_SELECT)
    .eq("status", "pending")
    .not("mul_no", "is", null)
    .lt("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(50);
  if (error) {
    log.warn("admin.stale_pending_fail", errInfo(error));
    return [];
  }
  return ((data ?? []) as unknown as RawOrderRow[]).map(mapOrder);
}

export type RefundWarnings = {
  commitFail: AdminOrder[]; // refund_state='payapp_done' — 페이앱 환불됨·로컬 미반영(최우선, 재처리 필요)
  unreconciled: AdminOrder[]; // 페이앱 취소 웹훅 선도착(canceled+paid_at·refund_state null·ledger 없음) → 크레딧 미회수
  stuckCount: number; // refund_state='in_progress' 가 10분+ (함수 죽음 등 고착 — 확인 필요)
};

const WARN_SELECT =
  "order_uuid, status, amount, credits, product_id, mul_no, created_at, paid_at, user_id, refund_state";

/** 환불 운영 경고 — 대시보드 최상단(stale pending 보다 높은 우선순위). */
export async function getRefundWarnings(): Promise<RefundWarnings> {
  const admin = createAdminClient();
  const staleCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  const [done, stuck, canceledPaid] = await Promise.all([
    admin
      .from("payapp_orders")
      .select(WARN_SELECT)
      .eq("refund_state", "payapp_done")
      .order("updated_at", { ascending: true })
      .limit(20),
    admin
      .from("payapp_orders")
      .select("order_uuid", { count: "exact", head: true })
      .eq("refund_state", "in_progress")
      .lt("updated_at", staleCutoff),
    // 미회수 = 웹훅 선도착(canceled+paid_at·refund_state null)이면서 cancel_refund ledger 가 없는 건.
    // 회수 여부 판정은 SQL anti-join(0057) — 후보를 limit 으로 자른 뒤 앱에서 거르면, 오래된
    // 후보 20건이 전부 기회수일 때 실제 미회수 건이 경고에서 통째로 누락된다(false negative).
    admin.rpc("admin_unreconciled_canceled_orders").select(WARN_SELECT),
  ]);
  if (done.error) log.warn("admin.refund_warnings_fail", errInfo(done.error));
  const toOrder = (r: Omit<AdminOrder, "display_name">) => ({ ...r, display_name: null });
  const commitFail = ((done.data ?? []) as Array<Omit<AdminOrder, "display_name">>).map(toOrder);

  let unreconciled: AdminOrder[];
  if (canceledPaid.error) {
    // 0057 미적용 환경 폴백(마이그레이션 수동 적용 관례) — 종전 limit-후-필터 로직.
    log.warn("admin.refund_unreconciled_rpc_fail", errInfo(canceledPaid.error));
    unreconciled = await legacyUnreconciled(admin, toOrder);
  } else {
    unreconciled = ((canceledPaid.data ?? []) as Array<Omit<AdminOrder, "display_name">>).map(toOrder);
  }

  return { commitFail, unreconciled, stuckCount: stuck.count ?? 0 };
}

/** 0057(anti-join RPC) 미적용 환경용 종전 로직 — 후보 20건 한정 후 ledger 앱 필터(완전성 한계 有). */
async function legacyUnreconciled(
  admin: ReturnType<typeof createAdminClient>,
  toOrder: (r: Omit<AdminOrder, "display_name">) => AdminOrder
): Promise<AdminOrder[]> {
  const { data } = await admin
    .from("payapp_orders")
    .select(WARN_SELECT)
    .eq("status", "canceled")
    .not("paid_at", "is", null)
    .is("refund_state", null)
    .order("canceled_at", { ascending: true })
    .limit(20);
  const candidates = (data ?? []) as Array<Omit<AdminOrder, "display_name">>;
  if (candidates.length === 0) return [];
  const { data: ledgers } = await admin
    .from("admin_actions_ledger")
    .select("order_uuid")
    .eq("action_type", "cancel_refund")
    .in("order_uuid", candidates.map((c) => c.order_uuid));
  const reconciled = new Set((ledgers ?? []).map((l) => l.order_uuid as string));
  return candidates.filter((c) => !reconciled.has(c.order_uuid)).map(toOrder);
}
