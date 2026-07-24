"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { AdminOrder } from "@/lib/admin-types";
import { fmtKst, won, shortId } from "@/lib/admin-format";
import { CANCEL_OUTCOME_LABELS, refundErrMsg } from "@/components/admin/refund-saga-ui";
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
                <td className="px-2 py-1.5 truncate">
                  <Link
                    href={`/admin/users/${o.user_id}`}
                    className="text-sky-600 underline-offset-2 hover:underline"
                    title="회원 상세로 이동"
                  >
                    {o.display_name ?? shortId(o.user_id)}
                  </Link>
                </td>
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

// settle 경로 전용 오류 라벨(불변) — 지급 검증 실패 코드. cancel 은 refundErrMsg(saga 어휘)를 쓴다.
const SETTLE_ERR_KO: Record<string, string> = {
  not_settleable: "지급할 수 없는 상태의 주문이에요(pending + 결제 시도 흔적 필요).",
  not_paid: "포트원 결제상태가 PAID 가 아니에요 — 지급 대상이 아니에요.",
  amount_mismatch: "포트원 결제금액이 주문 금액과 달라요 — 운영 확인 필요.",
  pg_unreachable: "포트원 조회 실패 — 잠시 후 재시도하세요.",
  pg_unavailable: "포트원 취소 연동이 설정되지 않았어요.",
  order_not_found: "주문을 찾지 못했어요.",
  reason_invalid: "사유는 5~500자여야 해요.",
  action_failed: "처리에 실패했어요. 잠시 후 다시 시도하세요.",
};

// cancel intent 흐름(§B.8.2)에서 즉시 종결되는 outcome — 모달을 닫고 대시보드를 재조회한다.
// 그 외 ok outcome(refund_prepared·ineligible·observed 등)은 환불 큐 후속이 필요해 결과 화면에 안내.
const CANCEL_TERMINAL = new Set(["canceled", "canceled_unpaid", "already_canceled", "resolved_full"]);

const pad = (n: number) => String(n).padStart(2, "0");
/** Date → datetime-local input 값(로컬 타임존, 분 단위). */
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(
    d.getMinutes()
  )}`;

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
  const [craLocal, setCraLocal] = useState(() => toLocalInput(new Date()));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // cancel 이 환불 큐 후속을 요구하는 비종결 outcome 로 끝난 경우의 안내(종결이면 즉시 onDone).
  const [cancelOutcome, setCancelOutcome] = useState<string | null>(null);

  const reasonOk = reason.trim().length >= 5;

  /** datetime-local → ISO(빈/무효면 ""). */
  const craIso = () => {
    const d = new Date(craLocal);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  };

  const submit = async () => {
    if (busy || !reasonOk) return;
    const trimmed = reason.trim();

    if (kind === "cancel") {
      const cra = craIso();
      if (!cra) {
        setError("고객 요청 시각이 올바르지 않아요.");
        return;
      }
      setBusy(true);
      setError(null);
      try {
        const res = await fetch("/api/admin/cancel", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            orderUuid: order.order_uuid,
            reason: trimmed,
            customerRequestedAt: cra,
          }),
        });
        const out = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          outcome?: string;
          error?: string;
          message?: string;
        };
        if (res.ok && out.outcome) {
          if (CANCEL_TERMINAL.has(out.outcome)) {
            onDone();
            return;
          }
          // 비종결(환불 준비·경제 화해 필요 등) — 결과 안내 후 환불 큐로 유도. 닫으면 대시보드 재조회.
          setCancelOutcome(out.outcome);
          setBusy(false);
          return;
        }
        setError(out.message ?? refundErrMsg(out.error));
        setBusy(false);
      } catch {
        setError(refundErrMsg("action_failed"));
        setBusy(false);
      }
      return;
    }

    // settle — 포트원 검증 후 지급(불변).
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/settle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderUuid: order.order_uuid, reason: trimmed }),
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
      setError(out.message ?? SETTLE_ERR_KO[out.error ?? ""] ?? out.error ?? "처리 실패");
      setBusy(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "처리 실패");
      setBusy(false);
    }
  };

  // cancel 비종결 outcome 결과 화면 — 환불 큐 후속 안내.
  if (cancelOutcome) {
    return (
      <ModalShell onClose={onDone}>
        <h2 className="text-lg font-bold">주문 취소 — 후속 필요</h2>
        <p className="mt-2 text-sm text-zinc-600">
          {CANCEL_OUTCOME_LABELS[cancelOutcome] ?? cancelOutcome}
        </p>
        <Link
          href="/admin/refunds"
          className="mt-2 inline-block text-xs text-sky-600 underline underline-offset-2"
        >
          환불 큐로 이동 →
        </Link>
        <div className="mt-4 flex justify-end">
          <button
            type="button"
            onClick={onDone}
            className="rounded-full bg-foreground px-4 py-2.5 text-sm font-semibold text-paper-2"
          >
            확인
          </button>
        </div>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-bold">
        {kind === "settle" ? "포트원 검증 후 지급" : "주문 취소 (포트원 연동)"}
      </h2>
      <p className="mt-1 text-xs leading-relaxed text-zinc-500">
        {kind === "settle"
          ? "지급 전에 서버가 포트원 단건 조회로 결제완료(PAID)·금액 일치를 검증해요. 검증 통과 시에만 크레딧을 지급하며 감사 로그에 기록됩니다."
          : "고객 취소 의사를 먼저 기록한 뒤 포트원 상태를 확인해요. 미결제면 즉시 취소(회수 없음), 이미 결제됐던 것으로 확인되면 환불 요청을 준비해 환불 큐에서 실행해요. 감사 로그 기록."}
      </p>
      <p className="mt-2 text-xs text-zinc-400">
        {won(order.amount)} · {order.credits}개 · {fmtKst(order.created_at)}
      </p>

      {kind === "cancel" && (
        <label className="mt-3 flex flex-col gap-1 text-xs text-zinc-500">
          고객 요청 시각
          <input
            type="datetime-local"
            value={craLocal}
            onChange={(e) => setCraLocal(e.target.value)}
            className="w-full rounded-xl border border-foreground/15 ui-field px-3 py-2 text-sm outline-none focus:border-foreground/40"
          />
          <span className="text-[11px] text-zinc-400">
            결제로 확인되면 이 시각 기준으로 환불 환급률(7일 이내 전액/이후 90%)을 계산해요.
          </span>
        </label>
      )}

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
          disabled={busy || !reasonOk}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-foreground py-2.5 text-sm font-semibold text-paper-2 disabled:opacity-40"
        >
          {busy && <Spinner className="h-4 w-4" />}
          {kind === "settle" ? "지급" : "주문 취소"}
        </button>
      </div>
    </ModalShell>
  );
}
