"use client";

import { useState } from "react";
import type { AdminOrder } from "@/lib/admin-types";
import { fmtKst, won, shortId } from "@/lib/admin-format";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";

type ActionKind = "settle" | "cancel";

export function StalePendingTable({ rows }: { rows: AdminOrder[] }) {
  const [list, setList] = useState(rows);
  const [target, setTarget] = useState<{ order: AdminOrder; kind: ActionKind } | null>(null);

  const done = (orderUuid: string) =>
    setList((l) => l.filter((o) => o.order_uuid !== orderUuid));

  if (!list.length) {
    return <p className="text-sm text-zinc-400">확인이 필요한 오래된 결제요청이 없어요.</p>;
  }

  return (
    <>
      <div className="overflow-x-auto rounded-xl border border-amber-500/30">
        <table className="w-full text-left text-xs">
          <thead className="bg-amber-500/5 text-zinc-500">
            <tr>
              <th className="px-2 py-1.5">요청시각(KST)</th>
              <th className="px-2 py-1.5 text-right">금액</th>
              <th className="px-2 py-1.5">유저</th>
              <th className="px-2 py-1.5">처리</th>
            </tr>
          </thead>
          <tbody>
            {list.map((o) => (
              <tr key={o.order_uuid} className="border-t border-amber-500/10">
                <td className="px-2 py-1.5 tabular-nums">{fmtKst(o.created_at)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{won(o.amount)} · {o.credits}개</td>
                <td className="px-2 py-1.5 truncate">{o.display_name ?? shortId(o.user_id)}</td>
                <td className="px-2 py-1.5">
                  <div className="flex gap-1">
                    <button
                      type="button"
                      onClick={() => setTarget({ order: o, kind: "settle" })}
                      className="rounded-md bg-emerald-600 px-2 py-1 text-[11px] font-semibold text-white"
                    >
                      결제완료 확인 후 지급
                    </button>
                    <button
                      type="button"
                      onClick={() => setTarget({ order: o, kind: "cancel" })}
                      className="rounded-md border border-foreground/20 px-2 py-1 text-[11px]"
                    >
                      환불 표시
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {target && (
        <ActionModal
          order={target.order}
          kind={target.kind}
          onClose={() => setTarget(null)}
          onDone={() => {
            done(target.order.order_uuid);
            setTarget(null);
          }}
        />
      )}
    </>
  );
}

function ActionModal({
  order,
  kind,
  onClose,
  onDone,
}: {
  order: AdminOrder;
  kind: ActionKind;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState("");
  const [clawback, setClawback] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      const url = kind === "settle" ? "/api/admin/settle" : "/api/admin/cancel";
      const body =
        kind === "settle"
          ? { orderUuid: order.order_uuid, reason: reason.trim() }
          : { orderUuid: order.order_uuid, clawback, reason: reason.trim() };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? "failed");
      }
      onDone();
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리 실패");
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-bold">
        {kind === "settle" ? "결제완료 확인 후 지급" : "환불/취소 표시"}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        {kind === "settle"
          ? "페이앱 관리자에서 결제완료 상태를 확인한 뒤 지급하세요. 크레딧을 실제로 지급하며 감사 로그에 기록됩니다."
          : "주문을 취소 상태로 기록합니다. 페이앱 실환불은 별도로 진행하세요. 감사 로그에 기록됩니다."}
      </p>
      <p className="mt-2 text-xs text-zinc-400">
        {won(order.amount)} · {order.credits}개 · {fmtKst(order.created_at)}
      </p>

      {kind === "cancel" && (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={clawback} onChange={(e) => setClawback(e.target.checked)} />
          크레딧 회수(잔액까지만, 0 미만 불가)
        </label>
      )}

      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="사유 (5자 이상, 감사 로그 기록)"
        maxLength={500}
        className="mt-3 h-20 w-full rounded-xl border border-foreground/15 bg-transparent p-3 text-sm outline-none focus:border-foreground/40"
      />
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 rounded-full border border-foreground/15 py-2.5 text-sm">
          취소
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || reason.trim().length < 5}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-foreground py-2.5 text-sm font-semibold text-background disabled:opacity-40"
        >
          {busy && <Spinner className="h-4 w-4" />}
          {kind === "settle" ? "지급" : "취소 표시"}
        </button>
      </div>
    </ModalShell>
  );
}
