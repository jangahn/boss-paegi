"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";
import { won, fmtKst } from "@/lib/admin-format";
import { PROCESS_OUTCOME_LABELS, refundErrMsg } from "@/components/admin/refund-saga-ui";
import {
  AdminRefundIntentError,
  beginOrRecoverAdminRefund,
  clearPendingAdminRefundIntent,
  recoverPendingAdminRefund,
} from "@/lib/admin-refund-intent";
import {
  parseRefundPreviewHttpAck,
  parseRefundProcessHttpAck,
  type RefundPreviewPlan,
  type RefundProcessHttpAck,
} from "@/lib/pay/refund-http-contract";
import {
  clientMutationResponseNeedsReconciliation,
  runReplayedJsonMutation,
} from "@/lib/client-mutation";
import { useClientOperationScope } from "@/lib/use-client-operation-scope";

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
/** process 결과 — 재시도/큐 안내 분기용(attemptId 는 begin 반환값을 그대로 승계). */
type ProcessResult = { outcome: string; detail?: string; attemptId: string };
type RefundDelivery =
  | { kind: "preview"; plan: RefundPreviewPlan }
  | { kind: "process"; result: RefundProcessHttpAck };

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
  const [plan, setPlan] = useState<RefundPreviewPlan | null>(null);
  const [result, setResult] = useState<ProcessResult | null>(null);
  const [intentState, setIntentState] = useState<
    "idle" | "checking" | "ready" | "blocked"
  >("idle");
  const busyRef = useRef(false);
  const runScopedOperation = useClientOperationScope();

  const trimmedReason = reason.trim();
  const reasonOk = trimmedReason.length >= 5 && trimmedReason.length <= 500;
  const qtyOk = Number.isInteger(qty) && qty > 0;

  /** datetime-local → ISO(빈 값이면 ""). */
  const craIso = () => {
    const d = new Date(craLocal);
    return Number.isNaN(d.getTime()) ? "" : d.toISOString();
  };

  const post = async (
    payload: Record<string, unknown>,
    expected:
      | { mode: "preview"; qty: number }
      | { mode: "process"; attemptId: string },
  ) => {
    const requestBody = JSON.stringify(payload);
    return runScopedOperation((signal) =>
      runReplayedJsonMutation<RefundDelivery>({
        input: ENDPOINT,
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
        signal,
        classify: (response, body) => {
          if (response.ok && expected.mode === "preview") {
            const plan = parseRefundPreviewHttpAck(
              body,
              expected.qty,
            );
            if (plan) {
              return {
                kind: "confirmed",
                value: { kind: "preview", plan },
              };
            }
          }
          if (response.ok && expected.mode === "process") {
            const result = parseRefundProcessHttpAck(
              body,
              expected.attemptId,
            );
            if (result) {
              return {
                kind: "confirmed",
                value: { kind: "process", result },
              };
            }
          }
          const error =
            body &&
            typeof body === "object" &&
            !Array.isArray(body) &&
            typeof (body as Record<string, unknown>).error === "string"
              ? String((body as Record<string, unknown>).error)
              : null;
          if (
            clientMutationResponseNeedsReconciliation(
              response.status,
              response.ok,
            )
          ) {
            return {
              kind: "unconfirmed",
              reason: "refund_response_unconfirmed",
              error,
            };
          }
          return {
            kind: "rejected",
            error: error ?? `refund_http_${response.status}`,
          };
        },
      }),
    );
  };

  // ② preview — plan 계산·표시(무기록, 재시도 무해)
  const runPreview = async () => {
    if (
      busyRef.current ||
      intentState !== "ready" ||
      !qtyOk ||
      !reasonOk
    ) return;
    const cra = craIso();
    if (!cra) {
      setError("고객 요청 시각이 올바르지 않아요.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await post(
        {
          mode: "preview",
          userId: order.userId,
          orderUuid: order.orderUuid,
          qty,
          customerRequestedAt: cra,
        },
        { mode: "preview", qty },
      );
      if (outcome.kind === "aborted") return;
      if (
        outcome.kind === "confirmed" &&
        outcome.value.kind === "preview"
      ) {
        setPlan(outcome.value.plan);
        setPhase("preview");
      } else {
        const responseError =
          outcome.kind === "rejected" &&
          typeof outcome.error === "string"
            ? outcome.error
            : "action_unconfirmed";
        setError(refundErrMsg(responseError));
      }
    } catch {
      setError(refundErrMsg("action_failed"));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  // ③ 확정 — begin(requestId 멱등) → ④ process(auto)
  const confirm = async () => {
    if (busyRef.current || intentState !== "ready") return;
    const cra = craIso();
    if (!cra) {
      setError("고객 요청 시각이 올바르지 않아요.");
      return;
    }
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const begin = await runScopedOperation((signal) =>
        beginOrRecoverAdminRefund(
          {
            orderUuid: order.orderUuid,
            userId: order.userId,
            qty,
            customerRequestedAt: cra,
            reason: trimmedReason,
          },
          { storage: localStorage, signal },
        ),
      );
      busyRef.current = false;
      await runProcess(begin.pending.attemptId!);
    } catch (caught) {
      busyRef.current = false;
      setIntentState("blocked");
      setError(
        caught instanceof AdminRefundIntentError
          ? `${refundErrMsg(caught.message)} 결과 확인 전에는 새 환불을 시작할 수 없어요.`
          : "환불 영수증을 확인할 수 없어 새 환불을 차단했어요.",
      );
      setBusy(false);
    }
  };

  // ④ process(auto) — 최초 실행·재시도 공용(pending/outstanding 는 같은 attempt 재호출)
  const runProcess = async (attemptId: string) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const outcome = await post(
        {
          mode: "process",
          attemptId,
          action: "auto",
        },
        { mode: "process", attemptId },
      );
      if (outcome.kind === "aborted") return;
      if (
        outcome.kind !== "confirmed" ||
        outcome.value.kind !== "process"
      ) {
        const responseError =
          outcome.kind === "rejected" &&
          typeof outcome.error === "string"
            ? outcome.error
            : "action_unconfirmed";
        setResult({
          outcome: "outstanding",
          detail: responseError,
          attemptId,
        });
        setPhase("result");
        setError(
          "처리 결과가 불확실해 같은 환불 시도만 재시도할 수 있어요.",
        );
        return;
      }
      const process = outcome.value.result;
      setResult({
        outcome: process.outcome,
        detail: process.detail,
        attemptId,
      });
      setPhase("result");
      if (
        process.outcome === "processed" ||
        process.outcome === "no_op" ||
        process.outcome === "manual_review"
      ) {
        try {
          clearPendingAdminRefundIntent(
            order.orderUuid,
            attemptId,
            localStorage,
          );
        } catch {
          setError(
            "처리는 확인됐지만 로컬 영수증 정리에 실패했어요. 다음 열기에서 같은 시도를 다시 확인합니다.",
          );
        }
      }
    } catch {
      setResult({
        outcome: "outstanding",
        detail: "action_failed",
        attemptId,
      });
      setPhase("result");
      setError(
        "네트워크 응답이 불확실해 같은 환불 시도만 재시도할 수 있어요.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
      // 성공/부분/실패 모든 결과 후 목록·잔액·상태 배지·대시보드 경고 재조회.
      startRefresh(() => router.refresh());
    }
  };

  const openRefund = async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setOpen(true);
    setIntentState("checking");
    setBusy(true);
    setError(null);
    try {
      const recovery = await runScopedOperation((signal) =>
        recoverPendingAdminRefund(order.orderUuid, {
          storage: localStorage,
          signal,
        }),
      );
      if (recovery.kind === "none") {
        setIntentState("ready");
        return;
      }
      const pending = recovery.pending;
      setQty(pending.qty);
      setCraLocal(toLocalInput(new Date(pending.customerRequestedAt)));
      setReason(pending.reason);
      setPlan(null);
      setIntentState("ready");
      busyRef.current = false;
      await runProcess(pending.attemptId!);
    } catch (caught) {
      setIntentState("blocked");
      setError(
        caught instanceof AdminRefundIntentError
          ? `${refundErrMsg(caught.message)} 이전 환불 결과 확인이 필요해요.`
          : "이전 환불 영수증을 확인할 수 없어 새 환불을 차단했어요.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const close = () => {
    if (busyRef.current) return;
    setOpen(false);
    // 다음 오픈을 위해 초기화(결과 무관).
    setPhase("input");
    setQty(remainingQty);
    setCraLocal(toLocalInput(new Date()));
    setReason("");
    setPlan(null);
    setResult(null);
    setError(null);
    setIntentState("idle");
  };

  const done = result?.outcome === "processed" || result?.outcome === "no_op";
  const retryable = result?.outcome === "pending" || result?.outcome === "outstanding";
  const needsQueue = result?.outcome === "manual_review" || result?.outcome === "blocked";

  return (
    <>
      <button
        type="button"
        onClick={() => void openRefund()}
        className="rounded-lg border border-red-400/50 px-2 py-1 text-xs font-medium text-red-500"
      >
        {label ?? "환불"}
      </button>

      {open && (
        <ModalShell ariaLabel="수량 환불" onClose={close}>
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
                  disabled={
                    busy ||
                    intentState !== "ready" ||
                    !qtyOk ||
                    !reasonOk
                  }
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
                  disabled={busy || intentState !== "ready"}
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
