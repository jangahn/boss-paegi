import { fmtKst, shortId } from "@/lib/admin-format";
import type { CreditHistoryRow } from "@/lib/admin-users";

// 통합 크레딧 변동 kind 라벨·색 — 뱃지 토큰 패턴(bg-<색>/15 + text-<색>)은 refund-saga-ui 와 동일.
const EVENT_META: Record<string, { label: string; cls: string }> = {
  signup_bonus: { label: "가입 보너스", cls: "bg-emerald-500/15 text-emerald-600" },
  purchase: { label: "충전(구매)", cls: "bg-sky-500/15 text-sky-600" },
  gen_consume: { label: "생성 차감", cls: "bg-zinc-500/15 text-zinc-500" },
  gen_refund: { label: "생성 환불", cls: "bg-emerald-500/15 text-emerald-600" },
  cs_adjust: { label: "운영자 조정", cls: "bg-violet-500/15 text-violet-600" },
  refund: { label: "환불", cls: "bg-red-500/15 text-red-500" },
  refund_policy_close: { label: "미회수분 마감", cls: "bg-orange-500/15 text-orange-600" },
  expire: { label: "만료", cls: "bg-amber-500/15 text-amber-600" },
};

/** 통합 크레딧 변동 내역(가입 보너스·구매·생성 차감/환불·운영자 조정·환불·만료) 표 — 서버 렌더, 읽기 전용 병합. */
export function CreditLedgerTable({ rows }: { rows: CreditHistoryRow[] }) {
  if (rows.length === 0) {
    return (
      <p className="rounded-xl border border-dashed border-foreground/15 p-4 text-center text-xs text-zinc-500">
        크레딧 변동 내역이 없어요.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-1.5">
      {rows.map((r) => {
        const ev = EVENT_META[r.kind] ?? {
          label: r.kind,
          cls: "bg-foreground/10 text-zinc-500",
        };
        // ref 표기 — 생성/주문/로트(0062) 순. 각각 존재하는 것만 칩으로(credit_ledger 소스만 보유).
        const refs: string[] = [];
        if (r.refs.genId) refs.push(`생성 ${shortId(r.refs.genId)}`);
        if (r.refs.orderUuid) refs.push(`주문 ${shortId(r.refs.orderUuid)}`);
        if (r.refs.lotId) refs.push(`로트 ${shortId(r.refs.lotId)}`);
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
              <span className="tabular-nums text-xs text-zinc-400">
                {r.balanceBefore !== null && <>{r.balanceBefore}개 </>}
                <span className="text-zinc-500">→</span>{" "}
                <span className="font-semibold text-foreground/70">{r.balanceAfter}개</span>
              </span>
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
