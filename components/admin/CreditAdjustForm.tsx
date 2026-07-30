"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import {
  CreditAdjustmentHttpError,
  readPendingCreditAdjustment,
  recoverCreditAdjustment,
  submitCreditAdjustment,
  type PendingCreditAdjustment,
} from "@/lib/admin-credit-adjust";
import { useClientOperationScope } from "@/lib/use-client-operation-scope";

/**
 * CS 크레딧 조정 — 유저 상세에 통합(대상 prefill, lookup 단계 없음).
 * #4: 범위 초과/0/비정수는 무반응이 아니라 명시 메시지 + 적용 차단.
 * 잔액은 server(target.genCredits)가 단일 소스 — 성공 후 router.refresh()로 페이지·ledger 동시 갱신.
 * target 은 필요한 3필드만 받음(email 등 PII 를 클라 payload 로 직렬화하지 않음).
 * 서버(admin_adjust_credits)도 -100~100·≠0·사유 5~500 강제(이중 방어).
 */
type Target = { userId: string; displayName: string | null; genCredits: number };

export function CreditAdjustForm({ target }: { target: Target }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [delta, setDelta] = useState("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingCreditAdjustment | null>(null);
  const [pendingPayload, setPendingPayload] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<"checking" | "ready" | "blocked">("checking");
  const busyRef = useRef(false);
  const runScopedOperation = useClientOperationScope();

  const clearPendingState = useCallback(() => {
    setPending(null);
    setPendingPayload(null);
  }, []);

  const recoverPending = useCallback(async () => {
    setRecovery("checking");
    setError(null);
    try {
      const saved = readPendingCreditAdjustment(target.userId, localStorage);
      if (!saved) {
        setRecovery("ready");
        return;
      }
      setPending(saved);
      const outcome = await runScopedOperation((signal) =>
        recoverCreditAdjustment(target.userId, {
          storage: localStorage,
          signal,
        }),
      );
      if (outcome.kind === "completed") {
        setMsg(
          `이전 요청 완료 확인: ${outcome.result.before} → ${outcome.result.after} 크레딧`,
        );
        clearPendingState();
        startRefresh(() => router.refresh());
      } else if (outcome.kind === "aborted") {
        setMsg("이전 요청은 적용되지 않았음을 확인했어요. 새 조정을 실행할 수 있습니다.");
        clearPendingState();
      }
      setRecovery("ready");
    } catch {
      setRecovery("blocked");
      setError("이전 조정 결과를 확인할 수 없어 새 조정을 차단했어요. 결과 확인을 다시 시도하세요.");
    }
  }, [
    clearPendingState,
    router,
    runScopedOperation,
    startRefresh,
    target.userId,
  ]);

  useEffect(() => {
    const timer = window.setTimeout(() => void recoverPending(), 0);
    return () => window.clearTimeout(timer);
  }, [recoverPending]);

  const d = Number(delta);
  const entered = delta.trim() !== "";
  const notInt = entered && !Number.isInteger(d);
  const outOfRange = entered && Number.isInteger(d) && (d > 100 || d < -100);
  const isZero = entered && Number.isInteger(d) && d === 0;
  const deltaValid = entered && Number.isInteger(d) && d !== 0 && d >= -100 && d <= 100;
  const reasonLength = Array.from(reason.trim()).length;
  const reasonValid = reasonLength >= 5 && reasonLength <= 500;
  const payloadKey = JSON.stringify({
    targetUserId: target.userId,
    delta: d,
    reason: reason.trim(),
  });
  const canApply =
    recovery === "ready" &&
    !busy &&
    deltaValid &&
    reasonValid &&
    (!pending || pendingPayload === payloadKey);

  const hint = notInt
    ? "정수만 입력하세요"
    : outOfRange
      ? "범위 초과 (-100~100), 변경 불가"
      : isZero
        ? "0은 변경할 수 없어요"
        : entered && deltaValid && !reasonValid
          ? reasonLength > 500
            ? "사유는 500자 이하여야 해요"
            : "사유를 5자 이상 입력하세요"
          : null;

  const apply = async () => {
    if (busyRef.current || !canApply) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const out = await runScopedOperation((signal) =>
        submitCreditAdjustment(
          {
            targetUserId: target.userId,
            delta: d,
            reason: reason.trim(),
          },
          {
            storage: localStorage,
            signal,
            onPending: (activePending) => {
              setPending(activePending);
              setPendingPayload(payloadKey);
            },
          },
        ),
      );
      const clamped = out.applied !== out.requested;
      setMsg(
        `완료: ${out.before} → ${out.after} 크레딧` +
          (clamped ? ` (요청 ${out.requested}, 실제 ${out.applied} 적용 — 0 클램프)` : ""),
      );
      clearPendingState();
      setDelta("");
      setReason("");
      startRefresh(() => router.refresh()); // 페이지 잔액 + 조정 이력 ledger 재조회(단일 소스, pending 가시화).
    } catch (e) {
      if (e instanceof CreditAdjustmentHttpError && e.code === "request_aborted") {
        clearPendingState();
        setMsg("요청이 적용되지 않았음을 확인했어요. 다시 실행할 수 있습니다.");
      } else {
        // Any non-acknowledged outcome is uncertain. Do not keep offering an
        // apply button (which can loop on a cross-tab payload conflict);
        // force the durable receipt recovery path first.
        setRecovery("blocked");
        setError(
          e instanceof Error
            ? `${e.message} — 새 조정 전에 결과 확인이 필요합니다.`
            : "적용 결과가 불확실해 새 조정을 차단했어요. 결과를 먼저 확인하세요.",
        );
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-xl border border-foreground/10 ui-surface p-3">
      <div className="text-xs">
        <b>{target.displayName ?? "(닉네임 없음)"}</b> · 현재{" "}
        <b className="tabular-nums">{target.genCredits}</b>개
      </div>
      <div className="flex flex-wrap gap-2">
        <input
          type="number"
          value={delta}
          onChange={(e) => setDelta(e.target.value)}
          disabled={busy || recovery !== "ready" || pending !== null}
          placeholder="±delta(-100~100, ≠0)"
          aria-invalid={notInt || outOfRange || isZero}
          className="w-32 rounded-lg border border-foreground/15 ui-field px-2 py-1.5 text-sm outline-none aria-invalid:border-red-400"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          disabled={busy || recovery !== "ready" || pending !== null}
          placeholder="사유(5~500자)"
          maxLength={1000}
          className="min-w-0 flex-1 rounded-lg border border-foreground/15 ui-field px-2 py-1.5 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => void apply()}
          disabled={!canApply}
          className="flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-sm font-semibold text-paper-2 disabled:opacity-40"
        >
          {busy && <Spinner className="h-3.5 w-3.5" />}
          {pending ? "동일 요청 재시도" : "적용"}
        </button>
      </div>
      {recovery === "checking" && (
        <p className="text-xs text-zinc-500">미확정 조정 결과 확인 중…</p>
      )}
      {recovery === "blocked" && (
        <button
          type="button"
          onClick={() => void recoverPending()}
          className="self-start rounded-lg border border-amber-500/40 px-2.5 py-1 text-xs text-amber-700"
        >
          결과 확인 다시 시도
        </button>
      )}
      {hint && <p className="text-xs text-amber-600">{hint}</p>}
      {msg && <p className="text-xs text-emerald-600">{msg}</p>}
      {refreshing && <p className="text-[11px] text-zinc-400">갱신 중…</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
