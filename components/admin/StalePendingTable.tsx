"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { AdminOrder } from "@/lib/admin-types";
import { fmtKst, won, shortId } from "@/lib/admin-format";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";

type ActionKind = "settle" | "cancel";

// rows 를 직접 렌더(로컬 state 없음) — 처리 후 router.refresh 가 서버 재조회로 행 제거 + 대시보드 일관.
// drift 없음(server = single source). 처리~refresh 사이 잠깐의 잔존은 "갱신 중" 표시로 커버.
export function StalePendingTable({ rows }: { rows: AdminOrder[] }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [target, setTarget] = useState<{ order: AdminOrder; kind: ActionKind } | null>(null);

  if (!rows.length) {
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
            {rows.map((o) => (
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
                      주문 취소
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
            setTarget(null);
            startRefresh(() => router.refresh()); // 서버 재조회 — 처리된 행 제거 + 대시보드 카운트·매출·퍼널·경고 일관
          }}
        />
      )}
      {refreshing && <p className="mt-2 text-xs text-zinc-400">대시보드 갱신 중…</p>}
    </>
  );
}

const ERR_KO: Record<string, string> = {
  not_settleable: "지급할 수 없는 상태의 주문이에요(pending + 결제 시도 흔적 필요).",
  not_paid: "포트원 결제상태가 PAID 가 아니에요 — 지급 대상이 아니에요.",
  amount_mismatch: "포트원 결제금액이 주문 금액과 달라요 — 운영 확인 필요.",
  pg_unreachable: "포트원 조회 실패 — 잠시 후 재시도하세요.",
  not_cancelable: "취소할 수 없는 상태의 주문이에요.",
  use_refund: "이미 결제된 주문 — 주문/회원 상세의 '환불'로 처리하세요.",
  member_not_found: "회원 정보를 찾지 못했어요.",
  order_not_found: "주문을 찾지 못했어요.",
  reason_invalid: "사유는 5~500자여야 해요.",
  already_canceled: "이미 취소된 주문이에요.",
  order_status_changed: "주문 상태가 방금 변경됐어요(예: 결제 완료). 새로고침 후 다시 확인하세요.",
  action_failed: "처리에 실패했어요. 잠시 후 다시 시도하세요.",
  insufficient_credits: "회수할 크레딧이 부족해요.",
};

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
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      const url = kind === "settle" ? "/api/admin/settle" : "/api/admin/cancel";
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderUuid: order.order_uuid, reason: reason.trim() }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        manual?: boolean;
      };
      if (res.ok && !out.manual) {
        onDone();
        return;
      }
      // 실패/수동(미결제·상태 불일치·연결실패 등) → 메시지 표시, 모달 유지.
      setError(out.message ?? ERR_KO[out.error ?? ""] ?? out.error ?? "처리 실패");
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리 실패");
      setBusy(false);
    }
  };

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-bold">
        {kind === "settle" ? "포트원 검증 후 지급" : "주문 취소 (포트원 연동)"}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        {kind === "settle"
          ? "지급 전에 서버가 포트원 단건 조회로 결제완료(PAID)·금액 일치를 검증해요. 검증 통과 시에만 크레딧을 지급하며 감사 로그에 기록됩니다."
          : "포트원에서 결제를 취소합니다(결제됐으면 환불, 미승인 요청이면 로컬 취소만) + 주문을 취소 처리해요. pending 이라 회수할 크레딧은 없어요. 감사 로그 기록."}
      </p>
      <p className="mt-2 text-xs text-zinc-400">
        {won(order.amount)} · {order.credits}개 · {fmtKst(order.created_at)}
      </p>

      <textarea
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="사유 (5자 이상, 감사 로그 기록)"
        maxLength={500}
        className="mt-3 h-20 w-full rounded-xl border border-foreground/15 ui-field p-3 text-sm outline-none focus:border-foreground/40"
      />
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button type="button" onClick={onClose} className="flex-1 rounded-full border border-foreground/15 ui-surface py-2.5 text-sm">
          닫기
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || reason.trim().length < 5}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-foreground py-2.5 text-sm font-semibold text-paper-2 disabled:opacity-40"
        >
          {busy && <Spinner className="h-4 w-4" />}
          {kind === "settle" ? "지급" : "주문 취소"}
        </button>
      </div>
    </ModalShell>
  );
}
