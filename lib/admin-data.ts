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
