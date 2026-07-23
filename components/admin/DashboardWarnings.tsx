import Link from "next/link";
import type { AdminOrder } from "@/lib/admin-types";
import { won, shortId } from "@/lib/admin-format";
import { RefundButton } from "@/components/admin/RefundButton";
import { TestBadge } from "@/components/admin/TestBadge";

/** 경고 행 — 주문 식별 + TEST 뱃지(테스트 주문도 경고에 포함됨, 0059) + 회원 링크 + 환불 재시도. */
function WarningRow({ order: o }: { order: AdminOrder }) {
  return (
    <li className="flex flex-wrap items-center gap-2 rounded-lg bg-background/60 p-2 text-xs">
      <span className="font-mono text-zinc-400">{shortId(o.order_uuid)}</span>
      {o.is_test && <TestBadge />}
      <span>{won(o.amount)}</span>
      <span className="text-zinc-500">크레딧 {o.credits}</span>
      <Link
        href={`/admin/users/${o.user_id}`}
        className="max-w-[8rem] truncate text-sky-600 underline-offset-2 hover:underline"
        title="회원 상세로 이동"
      >
        {o.display_name ?? shortId(o.user_id)}
      </Link>
      <span className="ml-auto">
        <RefundButton
          order={{
            orderUuid: o.order_uuid,
            amount: o.amount,
            credits: o.credits,
            refundState: o.refund_state ?? null,
          }}
        />
      </span>
    </li>
  );
}

/**
 * 환불 운영 경고 — 대시보드 최상단(stale pending 보다 우선).
 * commitFail(pg_done): 포트원 환불됨·로컬 미반영 = 가장 위험 → 각 행에 '환불 재시도'.
 * stuck(in_progress >10분): 함수 중단 등 고착 → 확인 필요(자동 해제 안 함).
 */
export function DashboardWarnings({
  commitFail,
  unreconciled,
  stuckCount,
}: {
  commitFail: AdminOrder[];
  unreconciled: AdminOrder[];
  stuckCount: number;
}) {
  if (commitFail.length === 0 && unreconciled.length === 0 && stuckCount === 0) return null;
  return (
    <div className="flex flex-col gap-3">
      {commitFail.length > 0 && (
        <section className="rounded-xl border border-red-400/40 bg-red-400/5 p-3">
          <h2 className="text-sm font-bold text-red-500">
            ⚠ 환불 로컬반영 필요: {commitFail.length}건
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
            포트원 환불은 성공했으나 로컬 DB(취소·크레딧 회수) 반영이 안 됐어요. 각 건 &lsquo;환불 재시도&rsquo;로 마무리하세요.
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {commitFail.map((o) => (
              <WarningRow key={o.order_uuid} order={o} />
            ))}
          </ul>
        </section>
      )}
      {unreconciled.length > 0 && (
        <section className="rounded-xl border border-orange-500/40 bg-orange-500/5 p-3">
          <h2 className="text-sm font-bold text-orange-600">
            PG 취소됨 · 크레딧 미회수: {unreconciled.length}건
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
            PG 에서 취소(분쟁·콘솔 취소 등)됐지만 크레딧이 아직 회수되지 않았어요. &lsquo;환불 재시도&rsquo;로 회수하세요(PG 재호출 없이 회수만).
          </p>
          <ul className="mt-2 flex flex-col gap-1.5">
            {unreconciled.map((o) => (
              <WarningRow key={o.order_uuid} order={o} />
            ))}
          </ul>
        </section>
      )}
      {stuckCount > 0 && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-500/5 p-3">
          <h2 className="text-sm font-bold text-amber-600">
            환불 진행 중 고착(&gt;10분): {stuckCount}건 — 확인 필요
          </h2>
          <p className="mt-0.5 text-xs leading-relaxed text-zinc-500">
            환불 처리가 중간에 멈춘 주문이에요(함수 중단 등). 주문 목록에서 상태를 확인하고 재시도하세요. 자동 해제는 하지 않아요.
          </p>
        </section>
      )}
    </div>
  );
}
