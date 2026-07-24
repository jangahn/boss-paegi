import { fmtKst, shortId } from "@/lib/admin-format";
import type { CreditLedgerRow } from "@/lib/admin-users";

// credit_ledger.event_type 라벨·색(0047·0062) — 뱃지 토큰 패턴(bg-<색>/15 + text-<색>)은 refund-saga-ui 와 동일.
const EVENT_META: Record<string, { label: string; cls: string }> = {
  gen_consume: { label: "생성 차감", cls: "bg-zinc-500/15 text-zinc-500" },
  gen_refund: { label: "생성 환불", cls: "bg-emerald-500/15 text-emerald-600" },
  purchase: { label: "충전(구매)", cls: "bg-sky-500/15 text-sky-600" },
  // 환불 saga(0062) 신규 event_type
  expire: { label: "만료", cls: "bg-amber-500/15 text-amber-600" },
  refund_reserve: { label: "환불 예약", cls: "bg-sky-500/15 text-sky-600" },
  refund_release: { label: "환불 해제", cls: "bg-zinc-500/15 text-zinc-500" },
  refund_commit: { label: "환불 확정", cls: "bg-emerald-500/15 text-emerald-600" },
  refund_policy_close: { label: "미회수분 마감", cls: "bg-orange-500/15 text-orange-600" },
};

/** 크레딧 변동(생성 차감/환불·충전·만료·환불 예약/해제/확정) 표 — 서버 렌더. 운영자 조정은 별도 '크레딧 조정' 섹션에. */
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
        // ref 표기 — 생성/주문/로트(0062) 순. 각각 존재하는 것만 칩으로.
        const refs: string[] = [];
        if (r.refGenId) refs.push(`생성 ${shortId(r.refGenId)}`);
        if (r.refOrderUuid) refs.push(`주문 ${shortId(r.refOrderUuid)}`);
        if (r.refLotId) refs.push(`로트 ${shortId(r.refLotId)}`);
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
            {refs.map((t) => (
              <span key={t} className="font-mono text-[11px] text-zinc-400">
                {t}
              </span>
            ))}
            <span className="ml-auto text-xs text-zinc-400">{fmtKst(r.createdAt)}</span>
          </li>
        );
      })}
    </ul>
  );
}
