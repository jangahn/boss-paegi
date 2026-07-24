import Link from "next/link";
import type { AdminOrder } from "@/lib/admin-types";
import { fmtKst, STATUS_COLOR, won, shortId, payRouteLabel } from "@/lib/admin-format";
import { RefundButton } from "@/components/admin/RefundButton";
import { TestBadge } from "@/components/admin/TestBadge";

/**
 * 주문 목록 — 환불 가능 잔량이 남은 주문 행에 환불 액션(RefundButton, client). 그 외 컬럼은 조회 전용.
 * 환불 노출 판정(소비처 책임): 결제 완료(paid_at) + 회수 잔량(크레딧·현금 모두) 존재 — begin RPC 의
 * paid_at·qty_exceeds_order_remaining·nothing_to_refund 삼중 게이트와 동일 조건. 누계는 배지 컬럼에 표시.
 */
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
            <th className="px-2 py-1.5">결제경로</th>
            <th className="px-2 py-1.5 text-right">금액</th>
            <th className="px-2 py-1.5 text-right">크레딧</th>
            <th className="px-2 py-1.5">환불</th>
            <th className="px-2 py-1.5">상품</th>
            <th className="px-2 py-1.5">유저</th>
            <th className="px-2 py-1.5">주문번호</th>
            <th className="px-2 py-1.5">액션</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            // 회수 잔량 존재 = 크레딧·현금 모두 남음(rate<100% 전액환불 꼬리에서 button 잔존 방지 — begin 이중 게이트와 일치).
            const refundable =
              r.paid_at !== null &&
              r.refunded_credits < r.credits &&
              r.refunded_amount < r.amount;
            const fullyRefunded = r.refunded_credits >= r.credits;
            return (
              <tr key={r.order_uuid} className="border-t border-foreground/5">
                <td className="px-2 py-1.5 tabular-nums">{fmtKst(r.created_at)}</td>
                <td className={`px-2 py-1.5 font-semibold ${STATUS_COLOR[r.status] ?? ""}`}>
                  {r.status}
                </td>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  {payRouteLabel(r)}
                  {r.is_test && <TestBadge />}
                </td>
                <td className="px-2 py-1.5 text-right tabular-nums">{won(r.amount)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{r.credits}</td>
                <td className="px-2 py-1.5">
                  {r.refunded_credits > 0 ? (
                    <span className="inline-flex items-center gap-1 whitespace-nowrap">
                      <span
                        className={`rounded-full px-1.5 py-0.5 text-[11px] font-semibold ${
                          fullyRefunded
                            ? "bg-zinc-500/15 text-zinc-500"
                            : "bg-orange-500/15 text-orange-600"
                        }`}
                      >
                        {fullyRefunded ? "전액 환불" : "부분 환불"}
                      </span>
                      <span className="tabular-nums text-zinc-400">
                        {r.refunded_credits}개 · {won(r.refunded_amount)}
                      </span>
                    </span>
                  ) : (
                    <span className="text-zinc-300">—</span>
                  )}
                </td>
                <td className="px-2 py-1.5">{r.product_id}</td>
                <td className="max-w-[8rem] truncate px-2 py-1.5">
                  <Link
                    href={`/admin/users/${r.user_id}`}
                    className="text-sky-600 underline-offset-2 hover:underline"
                    title="회원 상세로 이동"
                  >
                    {r.display_name ?? shortId(r.user_id)}
                  </Link>
                </td>
                <td className="px-2 py-1.5 font-mono text-zinc-400">{shortId(r.order_uuid)}</td>
                <td className="px-2 py-1.5">
                  {refundable ? (
                    <RefundButton
                      order={{
                        orderUuid: r.order_uuid,
                        userId: r.user_id,
                        amount: r.amount,
                        credits: r.credits,
                        refundedCredits: r.refunded_credits,
                        refundedAmount: r.refunded_amount,
                      }}
                    />
                  ) : (
                    <span className="text-zinc-300">—</span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
