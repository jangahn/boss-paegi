import { fmtKst, shortId } from "@/lib/admin-format";
import type { CreditLedgerRow } from "@/lib/admin-users";

const EVENT_META: Record<string, { label: string; cls: string }> = {
  gen_consume: { label: "생성 차감", cls: "bg-zinc-500/15 text-zinc-500" },
  gen_refund: { label: "생성 환불", cls: "bg-emerald-500/15 text-emerald-600" },
  purchase: { label: "충전(구매)", cls: "bg-sky-500/15 text-sky-600" },
};

/** 크레딧 변동(생성 차감/환불·충전) 표 — 서버 렌더. 운영자 조정은 별도 '크레딧 조정' 섹션에. */
export function CreditLedgerTable({ rows }: { rows: CreditLedgerRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-foreground/15 p-4 text-center text-xs text-zinc-500">
        생성 차감/환불 기록이 없어요. (credit_ledger 적용 후 신규 발생분부터 쌓여요.)
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const ev = EVENT_META[r.eventType] ?? {
          label: r.eventType,
          cls: "bg-foreground/10 text-zinc-500",
        };
        const ref = r.refGenId
          ? `생성 ${shortId(r.refGenId)}`
          : r.refOrderUuid
            ? `주문 ${shortId(r.refOrderUuid)}`
            : null;
        return (
          <li
            key={r.id}
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-xl border border-foreground/10 ui-surface p-2.5 text-sm"
          >
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${ev.cls}`}>
              {ev.label}
            </span>
            <span
              className={`tabular-nums font-bold ${r.delta >= 0 ? "text-emerald-600" : "text-red-500"}`}
            >
              {r.delta >= 0 ? `+${r.delta}` : r.delta}
            </span>
            {r.balanceAfter !== null && (
              <span className="text-xs text-zinc-400">→ {r.balanceAfter}개</span>
            )}
            {ref && <span className="font-mono text-[11px] text-zinc-400">{ref}</span>}
            <span className="ml-auto text-xs text-zinc-400">{fmtKst(r.createdAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}
