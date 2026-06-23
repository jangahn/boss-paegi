import type { LedgerRow } from "@/lib/admin-types";
import { fmtKst, shortId } from "@/lib/admin-format";

const ACTION_LABEL: Record<string, string> = {
  settle_stuck: "지급(stuck)",
  cancel_refund: "환불/취소",
  cs_adjust: "CS 조정",
};
const ACTION_COLOR: Record<string, string> = {
  settle_stuck: "text-emerald-600",
  cancel_refund: "text-red-500",
  cs_adjust: "text-sky-600",
};

const delta = (n: number) => (n > 0 ? `+${n}` : `${n}`);

/**
 * metadata 힌트 — JSONB 라 원시값/배열도 들어올 수 있어 객체로 가드 후 접근(`in` 사용 금지).
 * clamped: CS 조정 클램프(0021). shortfall: PR6 머니패스 admin_cancel_order 가 회수 부족분 기록 예정.
 */
function MetaHint({ metadata }: { metadata: Record<string, unknown> | null }) {
  const md =
    metadata && typeof metadata === "object" && !Array.isArray(metadata) ? metadata : null;
  if (!md) return null;
  const clamped = md.clamped ? "· 클램프" : "";
  const shortfall = Number(md.shortfall) > 0 ? ` · 부족 ${md.shortfall}` : "";
  if (!clamped && !shortfall) return null;
  return (
    <span className="ml-1 text-[10px] text-zinc-500">
      {clamped}
      {shortfall}
    </span>
  );
}

/** 처리 내역 — 조회 전용(presentational, RSC). */
export function LedgerTable({ rows }: { rows: LedgerRow[] }) {
  if (!rows.length) {
    return <p className="text-sm text-zinc-400">처리 내역이 없어요.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-xl border border-foreground/10">
      <table className="w-full text-left text-xs">
        <thead className="bg-foreground/5 text-zinc-500">
          <tr>
            <th className="px-2 py-1.5">시각(KST)</th>
            <th className="px-2 py-1.5">유형</th>
            <th className="px-2 py-1.5">대상 유저</th>
            <th className="px-2 py-1.5 text-right">증감</th>
            <th className="px-2 py-1.5 text-right">잔액</th>
            <th className="px-2 py-1.5">주문</th>
            <th className="px-2 py-1.5">관리자</th>
            <th className="px-2 py-1.5">사유</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-foreground/5 align-top">
              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{fmtKst(r.created_at)}</td>
              <td className={`px-2 py-1.5 font-semibold ${ACTION_COLOR[r.action_type] ?? ""}`}>
                {ACTION_LABEL[r.action_type] ?? r.action_type}
              </td>
              <td className="max-w-[8rem] truncate px-2 py-1.5">
                {r.target_name ?? shortId(r.target_user_id)}
              </td>
              <td
                className={`px-2 py-1.5 text-right tabular-nums ${
                  r.credit_delta > 0 ? "text-emerald-600" : r.credit_delta < 0 ? "text-red-500" : "text-zinc-400"
                }`}
              >
                {delta(r.credit_delta)}
              </td>
              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-zinc-400">
                {r.before_credits}→{r.after_credits}
              </td>
              <td className="px-2 py-1.5 font-mono text-zinc-400">
                {r.order_uuid ? shortId(r.order_uuid) : "—"}
              </td>
              <td className="max-w-[7rem] truncate px-2 py-1.5 text-zinc-400">
                {r.admin_name ?? shortId(r.admin_user_id)}
              </td>
              <td className="max-w-[14rem] px-2 py-1.5">
                <span title={r.metadata ? JSON.stringify(r.metadata) : undefined}>{r.reason}</span>
                <MetaHint metadata={r.metadata} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
