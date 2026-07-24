"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";
import { won, fmtKst } from "@/lib/admin-format";
import { PROCESS_OUTCOME_LABELS, refundErrMsg } from "@/components/admin/refund-saga-ui";

/**
 * 수량 환불 saga 진입 버튼 + 확인 모달(v0.76 §B.8.1).
 * 흐름: 수량·고객 요청 시각·사유 입력 → preview(plan 표시) → begin(requestId 멱등) → process(auto).
 * process outcome 분기: processed/no_op=완료, pending/outstanding=재시도(process 재호출),
 * manual_review/blocked=환불 큐(/admin/refunds) 안내.
 * 소비처(OrdersTable·DashboardWarnings·회원 상세) 공유 — order 최소필드 + optional label.
 */
export type RefundButtonOrder = {
  orderUuid: string;
  userId: string;
  amount: number;
  credits: number;
  refundedCredits: number;
  refundedAmount: number;
};

const ENDPOINT = "/api/admin/refund-credits";

/** preview plan(§B.8.1) — 표시용. 확정 권위는 begin locked planner. */
type PreviewPlan = {
  qty: number;
  amount: number;
  rateBps: number;
  lotAvailable: number;
  orderRemainingQty: number;
  remainingCash: number;
  paidAt: string;
  deadline: string;
};

/** process 결과 — 재시도/큐 안내 분기용(attemptId 는 begin 반환값을 그대로 승계). */
type ProcessResult = { outcome: string; detail?: string; attemptId: string };

type Phase = "input" | "preview" | "result";

const pad = (n: number) => String(n).padStart(2, "0");
/** Date → datetime-local input 값(로컬 타임존, 분 단위). */
const toLocalInput = (d: Date) =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours()
  )}:${pad(d.getMinutes())}`;

export function RefundButton({
  order,
  label,
}: {
  order: RefundButtonOrder;
  /** 버튼 라벨 변형(예: 경고 행의 "환불 시도"). 기본 "환불". */
  label?: string;
}) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("input");

  const remainingQty = Math.max(1, order.credits - order.refundedCredits);
  const [qty, setQty] = useState(remainingQty);
  const [craLocal, setCraLocal] = useState(() => toLocalInput(new Date()));
  const [reason, setReason] = useState("");

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PreviewPlan | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);

  const trimmedReason = reason.trim();
  const reasonOk = trimmedReason.length >= 5 && trimmedReason.length <= 500;
  const qtyOk = Number.isInteger(qty) && qty > 0;

  /** datetime-local → ISO(빈 값이면 ""). */
  const craIso = () => {
    const d = new Date(craLocal);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  };

  const post = async <T,>(
    payload: Record<string, unknown>
  ): Promise<{ ok: boolean; body: T & { error?: string } }> => {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const body = (await res.json().catch(() => ({}))) as T & { error?: string };
    return { ok: res.ok, body };
  };

  // ② preview — plan 계산·표시(무기록, 재시도 무해)
  const runPreview = async () => {
    if (busy || !qtyOk || !reasonOk) return;
    const cra = craIso();
    if (!cra) {
      setError("고객 요청 시각이 올바르지 않아요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { ok, body } = await post<{ plan?: PreviewPlan }>({
        mode: "preview",
        userId: order.userId,
        orderUuid: order.orderUuid,
        qty,
        customerRequestedAt: cra,
      });
      if (ok && body.plan) {
        setPlan(body.plan);
        setPhase("preview");
      } else {
        setError(refundErrMsg(body.error));
      }
    } catch {
      setError(refundErrMsg("action_failed"));
    } finally {
      setBusy(false);
    }
  };

  // ③ 확정 — begin(requestId 멱등) → ④ process(auto)
  const confirm = async () => {
    if (busy) return;
    const cra = craIso();
    if (!cra) {
      setError("고객 요청 시각이 올바르지 않아요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const requestId = crypto.randomUUID();
      const begin = await post<{ attempt_id?: string }>({
        mode: "begin",
        requestId,
        userId: order.userId,
        orderUuid: order.orderUuid,
        qty,
        customerRequestedAt: cra,
        reason: trimmedReason,
      });
      if (!begin.ok || !begin.body.attempt_id) {
        setError(refundErrMsg(begin.body.error));
        setBusy(false);
        return;
      }
      await runProcess(begin.body.attempt_id);
    } catch {
      setError(refundErrMsg("action_failed"));
      setBusy(false);
    }
  };

  // ④ process(auto) — 최초 실행·재시도 공용(pending/outstanding 는 같은 attempt 재호출)
  const runProcess = async (attemptId: string) => {
    setBusy(true);
    setError(null);
    try {
      const { ok, body } = await post<{ outcome?: string; detail?: string }>({
        mode: "process",
        attemptId,
        action: "auto",
      });
      if (!ok || !body.outcome) {
        setError(refundErrMsg(body.error));
        setBusy(false);
        return;
      }
      setResult({ outcome: body.outcome, detail: body.detail, attemptId });
      setPhase("result");
    } catch {
      setError(refundErrMsg("action_failed"));
    } finally {
      setBusy(false);
      // 성공/부분/실패 모든 결과 후 목록·잔액·상태 배지·대시보드 경고 재조회.
      startRefresh(() => router.refresh());
    }
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    // 다음 오픈을 위해 초기화(결과 무관).
    setPhase("input");
    setQty(remainingQty);
    setCraLocal(toLocalInput(new Date()));
    setReason("");
    setPlan(null);
    setResult(null);
    setError(null);
  };

  const done = result?.outcome === "processed" || result?.outcome === "no_op";
  const retryable = result?.outcome === "pending" || result?.outcome === "outstanding";
  const needsQueue = result?.outcome === "manual_review" || result?.outcome === "blocked";

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-red-400/50 px-2 py-1 text-xs font-medium text-red-500"
      >
        {label ?? "환불"}
      </button>

      {open && (
        <ModalShell onClose={close}>
          <h3 className="text-base font-bold">수량 환불</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            주문 결제액 {won(order.amount)} · {order.credits}개.
            {order.refundedCredits > 0 &&
              ` 이미 ${order.refundedCredits}개 · ${won(order.refundedAmount)} 환불됨.`}
          </p>

          {/* ① 입력 */}
          {phase === "input" && (
            <div className="mt-3 flex flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                환불 수량(개)
                <input
                  type="number"
                  min={1}
                  value={qty}
                  onChange={(e) => setQty(Math.floor(Number(e.target.value)) || 0)}
                  className="w-full rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm tabular-nums outline-none focus:border-foreground/40"
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-zinc-500">
                고객 요청 시각
                <input
                  type="datetime-local"
                  value={craLocal}
                  onChange={(e) => setCraLocal(e.target.value)}
                  className="w-full rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm outline-none focus:border-foreground/40"
                />
                <span className="text-[11px] text-zinc-400">
                  결제 후 7일 이내 요청이면 전액(100%), 이후면 90% 환급.
                </span>
              </label>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="환불 사유(5~500자)"
                maxLength={500}
                rows={2}
                className="w-full rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm outline-none focus:border-foreground/40"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={close}
                  disabled={busy}
                  className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  닫기
                </button>
                <button
                  type="button"
                  onClick={() => void runPreview()}
                  disabled={busy || !qtyOk || !reasonOk}
                  className="flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-sm font-semibold text-paper-2 disabled:opacity-40"
                >
                  {busy && <Spinner className="h-3.5 w-3.5" />}미리보기
                </button>
              </div>
            </div>
          )}

          {/* ② 미리보기(plan) */}
          {phase === "preview" && plan && (
            <div className="mt-3 flex flex-col gap-3 text-sm">
              <dl className="flex flex-col gap-1.5 rounded-lg border border-foreground/10 ui-surface p-3 text-xs">
                <div className="flex justify-between">
                  <dt className="text-zinc-500">환불 크레딧</dt>
                  <dd className="tabular-nums font-semibold">{plan.qty}개</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">환불 현금(환급률 {plan.rateBps / 100}%)</dt>
                  <dd className="tabular-nums font-semibold">{won(plan.amount)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">주문 환불가능 잔량</dt>
                  <dd className="tabular-nums">
                    {plan.orderRemainingQty}개 · 로트 잔여 {plan.lotAvailable}개
                  </dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">주문 잔여 현금</dt>
                  <dd className="tabular-nums">{won(plan.remainingCash)}</dd>
                </div>
                <div className="flex justify-between">
                  <dt className="text-zinc-500">환불 기한</dt>
                  <dd className="tabular-nums">{fmtKst(plan.deadline)}</dd>
                </div>
              </dl>
              <p className="text-[11px] text-zinc-400">
                확정 시 포트원 결제 취소(부분) + 크레딧 회수를 진행해요. 표시값은 안내용이며 확정은 서버가 재계산해요.
              </p>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  onClick={() => {
                    setPhase("input");
                    setError(null);
                  }}
                  disabled={busy}
                  className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  뒤로
                </button>
                <button
                  type="button"
                  onClick={() => void confirm()}
                  disabled={busy}
                  className="flex items-center gap-1 rounded-lg bg-red-500 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {busy && <Spinner className="h-3.5 w-3.5" />}환불 확정
                </button>
              </div>
            </div>
          )}

          {/* ③ 결과 */}
          {phase === "result" && result && (
            <div className="mt-3 text-sm">
              <p
                className={`font-semibold ${
                  done ? "text-emerald-600" : retryable ? "text-amber-600" : "text-red-500"
                }`}
              >
                {PROCESS_OUTCOME_LABELS[result.outcome] ?? result.outcome}
              </p>
              {result.detail && !done && (
                <p className="mt-1 text-xs text-zinc-500">{refundErrMsg(result.detail)}</p>
              )}
              {needsQueue && (
                <Link
                  href="/admin/refunds"
                  className="mt-2 inline-block text-xs text-sky-600 underline underline-offset-2"
                >
                  환불 큐로 이동 →
                </Link>
              )}
              {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
              {refreshing && <p className="mt-1 text-[11px] text-zinc-400">목록 갱신 중…</p>}
              <div className="mt-3 flex justify-end gap-2">
                {retryable && (
                  <button
                    type="button"
                    onClick={() => void runProcess(result.attemptId)}
                    disabled={busy}
                    className="flex items-center gap-1 rounded-lg bg-amber-500 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
                  >
                    {busy && <Spinner className="h-3.5 w-3.5" />}재시도
                  </button>
                )}
                <button
                  type="button"
                  onClick={close}
                  disabled={busy}
                  className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm disabled:opacity-40"
                >
                  닫기
                </button>
              </div>
            </div>
          )}
        </ModalShell>
      )}
    </>
  );
}
