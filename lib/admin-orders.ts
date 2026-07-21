import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import type { AdminOrder } from "@/lib/admin-types";

/**
 * 전체 주문 목록 — server-only, service_role. 검색/필터/페이징은 `search_orders` RPC(0022)로.
 * RPC 가 order_uuid::text·pg_tx_id/payment_id prefix + status 필터 + window total_count 를 서버에서 처리(정확 totalPages).
 */
export const ORDERS_PAGE_SIZE = 10;

export type OrdersPage = {
  rows: AdminOrder[];
  total: number;
  page: number;
  pageSize: number;
};

type SearchOrderRow = AdminOrder & { refund_state: string | null; total_count: number | string };

export async function getOrders(opts: {
  page?: number;
  status?: string | null;
  q?: string | null;
}): Promise<OrdersPage> {
  const page = Math.max(1, opts.page ?? 1);
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("search_orders", {
    p_q: opts.q?.trim() || null,
    p_status: opts.status || null,
    p_limit: ORDERS_PAGE_SIZE,
    p_offset: (page - 1) * ORDERS_PAGE_SIZE,
  });
  if (error) {
    log.warn("admin.orders_fail", errInfo(error));
    return { rows: [], total: 0, page, pageSize: ORDERS_PAGE_SIZE };
  }
  const raw = (data ?? []) as SearchOrderRow[];
  const total = raw.length ? Number(raw[0].total_count) : 0;
  const rows: AdminOrder[] = raw.map((r) => ({
    order_uuid: r.order_uuid,
    status: r.status,
    amount: r.amount,
    credits: r.credits,
    product_id: r.product_id,
    pg_tx_id: r.pg_tx_id,
    payment_id: r.payment_id,
    provider: r.provider,
    created_at: r.created_at,
    paid_at: r.paid_at,
    user_id: r.user_id,
    display_name: r.display_name,
    refund_state: r.refund_state,
  }));
  return { rows, total, page, pageSize: ORDERS_PAGE_SIZE };
}
