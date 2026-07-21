import type { AdminOrder } from "@/lib/admin-types";
import { fmtKst, STATUS_COLOR, won, shortId } from "@/lib/admin-format";
import { RefundButton } from "@/components/admin/RefundButton";

/** 주문 목록 — paid/pg_done 행에 환불 액션(RefundButton, client). 그 외 컬럼은 조회 전용. */
export function OrdersTable({ rows }: { rows: AdminOrder[] }) {
  if (!rows.length) {
    return <p className="text-sm text-zinc-400">주문이 없어요.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-foreground/10">
      <table className="w-full text-left text-xs">
        <thead className="ui-surface text-zinc-500">
          <tr>
            <th className="px-2 py-1.5">시각(KST)</th>
            <th className="px-2 py-1.5">상태</th>
            <th className="px-2 py-1.5 text-right">금액</th>
            <th className="px-2 py-1.5 text-right">크레딧</th>
            <th className="px-2 py-1.5">상품</th>
            <th className="px-2 py-1.5">유저</th>
            <th className="px-2 py-1.5">주문번호</th>
            <th className="px-2 py-1.5">액션</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.order_uuid} className="border-t border-foreground/5">
              <td className="px-2 py-1.5 tabular-nums">{fmtKst(r.created_at)}</td>
              <td className={`px-2 py-1.5 font-semibold ${STATUS_COLOR[r.status] ?? ""}`}>
                {r.status}
              </td>
              <td className="px-2 py-1.5 text-right tabular-nums">{won(r.amount)}</td>
              <td className="px-2 py-1.5 text-right tabular-nums">{r.credits}</td>
              <td className="px-2 py-1.5">{r.product_id}</td>
              <td className="max-w-[8rem] truncate px-2 py-1.5">
                {r.display_name ?? shortId(r.user_id)}
              </td>
              <td className="px-2 py-1.5 font-mono text-zinc-400">{shortId(r.order_uuid)}</td>
              <td className="px-2 py-1.5">
                {r.status === "paid" || r.refund_state === "pg_done" ? (
                  <RefundButton
                    order={{
                      orderUuid: r.order_uuid,
                      amount: r.amount,
                      credits: r.credits,
                      refundState: r.refund_state ?? null,
                    }}
                  />
                ) : (
                  <span className="text-zinc-300">—</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
