import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { log, errInfo } from "@/lib/log";
import type { AdminOrder } from "@/lib/admin-types";

/**
 * 전체 주문 목록 — server-only, service_role. 검색/필터/페이징은 `search_orders` RPC(0022)로.
 * RPC 가 order_uuid::text·pg_tx_id/payment_id prefix + status 필터 + window total_count 를 서버에서 처리(정확 totalPages).
 * 환불 누계(refunded_credits·refunded_amount, 0062)는 RPC 반환에 없어 orders 보강 select(in 절 1회)로 채움.
 */
export const ORDERS_PAGE_SIZE = 10;

export type OrdersPage = {
  rows: AdminOrder[];
  total: number;
  page: number;
  pageSize: number;
};

type SearchOrderRow = Omit<AdminOrder, "refunded_credits" | "refunded_amount"> & {
  total_count: number | string;
};

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

  // 환불 누계 보강 — 조회 실패 시 0 폴백(경고만) — 표시는 미환불처럼 보여도 실행은 RPC 가 재검증.
  const refunded = new Map<string, { refunded_credits: number; refunded_amount: number }>();
  if (raw.length) {
    const { data: refundedRows, error: refundedError } = await admin
      .from("orders")
      .select("order_uuid, refunded_credits, refunded_amount")
      .in("order_uuid", raw.map((r) => r.order_uuid));
    if (refundedError) {
      log.warn("admin.orders_refunded_fail", errInfo(refundedError));
    }
    for (const r of (refundedRows ?? []) as Array<{
      order_uuid: string;
      refunded_credits: number;
      refunded_amount: number;
    }>) {
      refunded.set(r.order_uuid, r);
    }
  }

  const rows: AdminOrder[] = raw.map((r) => ({
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
    display_name: r.display_name,
    refunded_credits: refunded.get(r.order_uuid)?.refunded_credits ?? 0,
    refunded_amount: refunded.get(r.order_uuid)?.refunded_amount ?? 0,
  }));
  return { rows, total, page, pageSize: ORDERS_PAGE_SIZE };
}
