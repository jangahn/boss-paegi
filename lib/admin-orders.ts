import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import type { AdminOrder } from "@/lib/admin-types";
import { requireSupabaseRows } from "@/lib/supabase-operation";
import {
  parseAdminWindowTotal,
  requireExactAdminIdCoverage,
  validateAdminRows,
} from "@/lib/admin-read-contract";

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

type SearchOrderRow = Omit<
  AdminOrder,
  "refunded_credits" | "refunded_amount" | "error_message"
> & {
  total_count: number | string;
};

export async function getOrders(opts: {
  page?: number;
  status?: string | null;
  q?: string | null;
}): Promise<OrdersPage> {
  const page = Math.max(1, opts.page ?? 1);
  const admin = createAdminClient();
  const readRows = async (
    operation: string,
    limit: number,
    offset: number,
  ): Promise<SearchOrderRow[]> => {
    const data = await requireSupabaseRows(
      operation,
      () =>
        admin.rpc("search_orders", {
          p_q: opts.q?.trim() || null,
          p_status: opts.status || null,
          p_limit: limit,
          p_offset: offset,
        }),
    );
    return validateAdminRows<SearchOrderRow>(operation, data, {
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
      user_id: "uuid",
      display_name: "nullableString",
      total_count: "nonnegativeNumeric",
    });
  };
  const raw = await readRows(
    "admin.orders.search",
    ORDERS_PAGE_SIZE,
    (page - 1) * ORDERS_PAGE_SIZE,
  );
  // Window count is absent on an out-of-range empty page. Probe offset 0 so a
  // forged/stale high `page` URL cannot turn a nonempty order set into total=0.
  const totalRows =
    raw.length > 0 || page === 1
      ? raw
      : await readRows("admin.orders.search_total_probe", 1, 0);
  const total = parseAdminWindowTotal(
    "admin.orders.search",
    totalRows as unknown as Record<string, unknown>[],
  );

  // 환불 누계 보강 — 같은 주문 집합을 정확히 재조회한다. 실패/부분 응답을
  // 0(미환불)로 축소하면 운영자가 잘못된 결정을 내릴 수 있으므로 전체 실패.
  const financialState = new Map<
    string,
    {
      refunded_credits: number;
      refunded_amount: number;
      error_message: string | null;
    }
  >();
  if (raw.length) {
    const refundedData = await requireSupabaseRows(
      "admin.orders.refund_totals",
      () =>
        admin
          .from("orders")
          .select(
            "order_uuid, refunded_credits, refunded_amount, error_message",
          )
          .in(
            "order_uuid",
            raw.map((r) => r.order_uuid),
          ),
    );
    const refundedRows = validateAdminRows<{
      order_uuid: string;
      refunded_credits: number;
      refunded_amount: number;
      error_message: string | null;
    }>("admin.orders.refund_totals", refundedData, {
      order_uuid: "uuid",
      refunded_credits: "nonnegativeInteger",
      refunded_amount: "nonnegativeInteger",
      error_message: "nullableString",
    });
    requireExactAdminIdCoverage(
      "admin.orders.refund_totals",
      raw.map((row) => row.order_uuid),
      refundedRows.map((row) => row.order_uuid),
    );
    for (const r of refundedRows) {
      financialState.set(r.order_uuid, r);
    }
  }

  const rows: AdminOrder[] = raw.map((r) => {
    // Exact coverage above proves this exists for every searched row.
    const financial = financialState.get(r.order_uuid)!;
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
      error_message: financial.error_message,
      user_id: r.user_id,
      display_name: r.display_name,
      refunded_credits: financial.refunded_credits,
      refunded_amount: financial.refunded_amount,
    };
  });
  return { rows, total, page, pageSize: ORDERS_PAGE_SIZE };
}
