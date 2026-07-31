"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";
import {
  isOperationRequestId,
  parseAccountReactivationCancelledResult,
  parseAccountReactivationCompleteResult,
} from "@/lib/admin-mutation";
import {
  clientMutationResponseNeedsReconciliation,
  runReplayedJsonMutation,
} from "@/lib/client-mutation";
import { useClientOperationScope } from "@/lib/use-client-operation-scope";

/**
 * 탈퇴 계정 재활성 — 본인 요청 시 운영자가 계정만 복구(데이터 미복구).
 * 오발 방지: 신원확인·데이터미복구 안내 2-체크 + 사유 필수. 서버(admin_reactivate_account)도 재검증.
 * 성공 시 잔액/배지는 server 단일 소스 → router.refresh() 로 페이지 갱신.
 */
const ERR_KO: Record<string, string> = {
  not_withdrawn: "이미 활성 계정이에요 (탈퇴 상태가 아님).",
  account_cleanup_pending:
    "탈퇴 자산 정리가 아직 끝나지 않았어요. 자산이 남은 계정은 정리 완료(최대 수 시간) 후 다시 시도해 주세요.",
  not_found: "존재하지 않는 계정이에요.",
  email_conflict: "같은 이메일을 쓰는 다른 활성 계정이 있어 복구할 수 없어요.",
  identity_email_missing: "원본 이메일을 찾을 수 없어요. 아래에 이메일을 직접 입력해 주세요.",
  reason_invalid: "사유를 5자 이상 입력하세요.",
  missing_fields: "입력값을 확인하세요.",
  not_admin: "권한이 없어요.",
  action_failed: "재활성 상태를 확인하지 못했어요. 잠시 후 다시 시도해 주세요.",
  auth_email_restore_failed:
    "로그인 이메일 복원이 아직 끝나지 않았어요. 계정은 계속 탈퇴 상태이며, 같은 작업을 다시 실행하면 이어서 처리해요.",
  reactivation_finalize_failed:
    "로그인 이메일은 복원됐지만 계정 활성화 커밋이 아직 끝나지 않았어요. 같은 작업을 다시 실행해 주세요.",
  reactivation_pending:
    "재활성 작업을 안전하게 이어서 처리하고 있어요. 잠시 후 새로고침하면 완료 여부를 확인할 수 있어요.",
  state_conflict:
    "탈퇴 상태가 다른 작업으로 변경됐어요. 새로고침 후 현재 상태를 확인해 주세요.",
  reactivation_in_progress:
    "다른 재활성 작업이 진행 중이에요. 동일한 사유·이메일로 다시 시도하거나 잠시 후 확인해 주세요.",
  reactivation_cancellation_pending:
    "취소 요청을 안전하게 보상 처리하고 있어요. 잠시 후 다시 확인해 주세요.",
  reactivation_cancellation_in_progress:
    "이미 다른 취소 요청이 진행 중이에요.",
  reactivation_cancelled:
    "이 재활성 요청은 취소됐어요. 다시 복구하려면 새 사유로 요청해 주세요.",
  reactivation_already_completed:
    "재활성이 먼저 완료되어 취소할 수 없어요. 현재 계정 상태를 새로고침해 확인해 주세요.",
};

type Target = {
  userId: string;
  originalEmail: string | null;
  deletedAt: string;
  withdrawalGeneration: number;
};

type PendingOperation = {
  operationRequestId: string;
  expectedDeletedAt: string;
  expectedWithdrawalGeneration: number;
  cancelRequested: boolean;
};

type ReactivationDelivery =
  | { kind: "completed" }
  | {
      kind: "pending";
      operationRequestId: string;
      cancelRequested: boolean;
    };

export function ReactivateAccountForm({
  target,
  initialPending,
}: {
  target: Target;
  initialPending: PendingOperation | null;
}) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [reason, setReason] = useState("");
  const [emailOverride, setEmailOverride] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [pendingOperation, setPendingOperation] =
    useState<PendingOperation | null>(initialPending);
  const [ackIdentity, setAckIdentity] = useState(false);
  const [ackData, setAckData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const runScopedOperation = useClientOperationScope();

  const reasonValid = reason.trim().length >= 5;
  const canApply =
    !busy &&
    !pendingOperation &&
    reasonValid &&
    ackIdentity &&
    ackData;

  const post = async (
    requestBody: string,
    action: "activate" | "cancel",
    expectedOperationRequestId?: string,
  ) =>
    runScopedOperation((signal) =>
      runReplayedJsonMutation<ReactivationDelivery>({
        input: "/api/admin/reactivate",
        init: {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: requestBody,
        },
        signal,
        classify: (response, body) => {
          const complete =
            action === "activate" && response.ok
              ? parseAccountReactivationCompleteResult(body)
              : null;
          if (complete && complete.userId === target.userId) {
            return {
              kind: "confirmed",
              value: { kind: "completed" },
            };
          }
          const cancelled =
            action === "cancel" && response.ok
              ? parseAccountReactivationCancelledResult(body)
              : null;
          if (cancelled && cancelled.userId === target.userId) {
            return {
              kind: "confirmed",
              value: { kind: "completed" },
            };
          }

          const record =
            body && typeof body === "object" && !Array.isArray(body)
              ? (body as Record<string, unknown>)
              : null;
          const code =
            typeof record?.error === "string" ? record.error : null;
          const operationRequestId =
            typeof record?.operationRequestId === "string" &&
            isOperationRequestId(record.operationRequestId)
              ? record.operationRequestId
              : null;
          const pending =
            action === "activate"
              ? code === "reactivation_pending" ||
                code === "auth_email_restore_failed" ||
                code === "reactivation_finalize_failed"
              : code === "reactivation_cancellation_pending";
          if (
            pending &&
            operationRequestId &&
            (action === "activate" ||
              operationRequestId === expectedOperationRequestId)
          ) {
            return {
              kind: "confirmed",
              value: {
                kind: "pending",
                operationRequestId,
                cancelRequested: action === "cancel",
              },
            };
          }
          if (
            clientMutationResponseNeedsReconciliation(
              response.status,
              response.ok,
            )
          ) {
            return {
              kind: "unconfirmed",
              reason: "reactivation_response_unconfirmed",
              error: code,
            };
          }
          return {
            kind: "rejected",
            error: code ?? `reactivation_http_${response.status}`,
          };
        },
      }),
    );

  const apply = async () => {
    if (!canApply) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const requestBody = JSON.stringify({
          userId: target.userId,
          reason: reason.trim(),
          emailOverride: emailOverride.trim() || undefined,
          expectedDeletedAt: target.deletedAt,
          expectedWithdrawalGeneration: target.withdrawalGeneration,
      });
      const outcome = await post(requestBody, "activate");
      if (outcome.kind === "aborted") return;
      if (
        outcome.kind === "confirmed" &&
        outcome.value.kind === "completed"
      ) {
        setPendingOperation(null);
        setMsg("계정을 재활성했어요. 본인이 재로그인하면 약관·방침 재동의 후 이용할 수 있어요.");
        startRefresh(() => router.refresh());
        return;
      }
      if (
        outcome.kind === "confirmed" &&
        outcome.value.kind === "pending"
      ) {
        setPendingOperation({
          operationRequestId: outcome.value.operationRequestId,
          expectedDeletedAt: target.deletedAt,
          expectedWithdrawalGeneration: target.withdrawalGeneration,
          cancelRequested: false,
        });
        setError(ERR_KO.reactivation_pending);
        return;
      }
      const code =
        outcome.kind === "rejected" &&
        typeof outcome.error === "string"
          ? outcome.error
          : "action_failed";
      setError(
        ERR_KO[code] ??
          "재활성 결과를 확인하지 못했어요. 같은 요청으로 다시 시도해 주세요.",
      );
    } catch {
      setError("네트워크 오류 — 다시 시도해 주세요.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (
      busyRef.current ||
      !pendingOperation ||
      (
        !pendingOperation.cancelRequested &&
        cancelReason.trim().length < 5
      )
    ) return;
    const submittedPending = pendingOperation;
    const submittedCancelReason = submittedPending.cancelRequested
      ? "resume existing cancellation"
      : cancelReason.trim();
    busyRef.current = true;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const requestBody = JSON.stringify({
          action: "cancel",
          operationRequestId: submittedPending.operationRequestId,
          userId: target.userId,
          reason: submittedCancelReason,
          expectedDeletedAt: submittedPending.expectedDeletedAt,
          expectedWithdrawalGeneration:
            submittedPending.expectedWithdrawalGeneration,
      });
      const outcome = await post(
        requestBody,
        "cancel",
        submittedPending.operationRequestId,
      );
      if (outcome.kind === "aborted") return;
      if (
        outcome.kind === "confirmed" &&
        outcome.value.kind === "completed"
      ) {
        setPendingOperation(null);
        setMsg("재활성 요청을 취소했고 로그인 이메일을 탈퇴 마커로 안전하게 되돌렸어요.");
        startRefresh(() => router.refresh());
        return;
      }
      if (
        outcome.kind === "confirmed" &&
        outcome.value.kind === "pending"
      ) {
        setPendingOperation({
          ...submittedPending,
          cancelRequested: true,
        });
        setError(ERR_KO.reactivation_cancellation_pending);
        return;
      }
      const code =
        outcome.kind === "rejected" &&
        typeof outcome.error === "string"
          ? outcome.error
          : "action_failed";
      setError(
        ERR_KO[code] ??
          "재활성 취소 결과를 확인하지 못했어요. 같은 요청으로 다시 시도해 주세요.",
      );
    } catch {
      setError("네트워크 오류 — 취소 요청을 다시 시도해 주세요.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-amber-500/40 bg-amber-500/5 p-4">
      <div className="text-sm font-semibold text-amber-700 dark:text-amber-300">
        탈퇴 계정 재활성
      </div>

      <div className="space-y-1 rounded-xl bg-foreground/5 p-3 text-xs leading-relaxed text-zinc-500">
        <p>· <b className="text-foreground">계정(로그인)만 복구</b>됩니다. 캐릭터·하이라이트·생성권은 이미 삭제되어 복구되지 않아요.</p>
        <p>· 재활성 즉시 <b className="text-foreground">과거 점수의 표시 이름이 복원된 닉네임으로 다시 노출</b>될 수 있어요.</p>
        <p>· 본인이 재로그인하면 현재 약관·개인정보처리방침에 재동의해야 이용할 수 있어요.</p>
      </div>

      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        원본 이메일을 못 찾을 때만 입력 (보통 비워둠)
        <input
          type="email"
          value={emailOverride}
          onChange={(e) => setEmailOverride(e.target.value)}
          placeholder={target.originalEmail ?? "user@example.com"}
          className="rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm text-foreground"
        />
      </label>

      <label className="flex flex-col gap-1 text-xs text-zinc-500">
        사유 (요청 채널·근거)
        <textarea
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={2}
          placeholder="예: 2026-06 고객센터 메일 요청, 본인 이메일로 신원 확인"
          className="rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm text-foreground"
        />
      </label>

      <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
        <input type="checkbox" checked={ackIdentity} onChange={(e) => setAckIdentity(e.target.checked)} className="mt-0.5" />
        <span>본인 요청 및 신원 확인을 완료했습니다.</span>
      </label>
      <label className="flex items-start gap-2 text-xs text-zinc-600 dark:text-zinc-300">
        <input type="checkbox" checked={ackData} onChange={(e) => setAckData(e.target.checked)} className="mt-0.5" />
        <span>계정만 복구되며 캐릭터·하이라이트·생성권은 복구되지 않음을 안내했습니다.</span>
      </label>

      {error && <p className="text-xs text-red-500">{error}</p>}
      {msg && <p className="text-xs text-emerald-600">{msg}</p>}

      <button
        type="button"
        onClick={() => void apply()}
        disabled={!canApply}
        className="flex items-center justify-center gap-2 rounded-full bg-amber-600 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {busy && <Spinner className="h-4 w-4" />}
        계정 재활성
      </button>

      {pendingOperation && (
        <div className="space-y-2 rounded-xl border border-red-500/30 p-3">
          <p className="text-xs leading-relaxed text-zinc-500">
            {pendingOperation.cancelRequested
              ? "이미 접수된 취소 보상 작업을 다시 실행할 수 있어요. 계정은 완료될 때까지 탈퇴 상태로 유지됩니다."
              : "재활성 작업이 계속 실패한다면 요청을 취소할 수 있어요. 이미 복원된 로그인 이메일이 있으면 정확한 탈퇴 마커로 되돌린 뒤 계정은 탈퇴 상태로 유지됩니다."}
          </p>
          {!pendingOperation.cancelRequested && (
            <textarea
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
              rows={2}
              placeholder="취소 사유 (5자 이상)"
              className="w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm text-foreground"
            />
          )}
          <button
            type="button"
            onClick={() => void cancel()}
            disabled={
              busy ||
              (
                !pendingOperation.cancelRequested &&
                cancelReason.trim().length < 5
              )
            }
            className="flex w-full items-center justify-center gap-2 rounded-full border border-red-500/50 py-2 text-sm font-semibold text-red-500 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy && <Spinner className="h-4 w-4" />}
            {pendingOperation.cancelRequested
              ? "취소 보상 재개"
              : "재활성 요청 취소"}
          </button>
        </div>
      )}
    </div>
  );
}
