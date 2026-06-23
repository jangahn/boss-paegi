"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";
import { won } from "@/lib/admin-format";

/**
 * 정상결제 환불 버튼 + 확인 모달 — 페이앱 자동취소 + 크레딧 회수.
 * payapp_done(커밋실패 복구) 행은 "환불 재시도"로 라벨. 사유 필수, submit 중 차단(auto-retry 없음).
 */
type Order = { orderUuid: string; amount: number; credits: number; refundState: string | null };

type RefundResp = {
  ok?: boolean;
  error?: string;
  message?: string;
  manual?: boolean;
  clawback?: number;
  shortfall?: number;
  before?: number;
  after?: number;
};

const ERR_KO: Record<string, string> = {
  insufficient_credits: "보유 크레딧이 회수량보다 적어 환불을 차단했어요(유저가 이미 사용).",
  cancel_unavailable: "취소 연동(PAYAPP_LINKKEY)이 설정되지 않았어요.",
  already_processed: "이미 처리된(또는 처리 중인) 주문이에요.",
  not_cancelable: "취소할 수 없는 상태의 주문이에요.",
  no_mul_no: "결제번호(mul_no)가 없어 페이앱 취소가 불가해요.",
  order_not_found: "주문을 찾지 못했어요.",
  reason_invalid: "사유는 5~500자여야 해요.",
  member_not_found: "회원 정보를 찾지 못했어요.",
  action_failed: "처리 중 오류가 발생했어요. 잠시 후 다시 시도하세요.",
};

export function RefundButton({ order }: { order: Order }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RefundResp | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isRetry = order.refundState === "payapp_done";

  const submit = async () => {
    if (busy || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await fetch("/api/admin/refund", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderUuid: order.orderUuid, reason: reason.trim() }),
      });
      const body = (await res.json().catch(() => ({}))) as RefundResp;
      if (res.ok && !body.manual) {
        setResult(body);
      } else if (body.manual) {
        setError(body.message ?? "수동 처리 필요");
      } else {
        setError(body.message ?? ERR_KO[body.error ?? ""] ?? body.error ?? "환불 실패");
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "환불 실패");
    } finally {
      setBusy(false);
      // 성공/실패/수동 모든 결과 후 목록·잔액·라벨·대시보드 경고 재조회(pending 가시화).
      startRefresh(() => router.refresh());
    }
  };

  const close = () => {
    if (busy) return;
    setOpen(false);
    setReason("");
    setResult(null);
    setError(null);
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={`rounded-lg border px-2 py-1 text-xs font-medium ${
          isRetry ? "border-amber-500/50 text-amber-600" : "border-red-400/50 text-red-500"
        }`}
      >
        {isRetry ? "환불 재시도" : "환불"}
      </button>

      {open && (
        <ModalShell onClose={close}>
          <h3 className="text-base font-bold">정상결제 환불</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            페이앱 결제 취소 + 크레딧 회수({order.credits}개). 결제액 {won(order.amount)}.
            {isRetry && " (페이앱 환불됨 — 로컬 반영 재시도)"}
            <br />
            보유 크레딧이 회수량보다 적으면 환불이 차단돼요(이미 사용분).
          </p>

          {!result && (
            <>
              <textarea
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="환불 사유(5~500자)"
                maxLength={500}
                rows={2}
                className="mt-3 w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none"
              />
              {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
              <div className="mt-3 flex justify-end gap-2">
                <button type="button" onClick={close} disabled={busy} className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm disabled:opacity-40">
                  닫기
                </button>
                <button
                  type="button"
                  onClick={() => void submit()}
                  disabled={busy || reason.trim().length < 5}
                  className="flex items-center gap-1 rounded-lg bg-red-500 px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-40"
                >
                  {busy && <Spinner className="h-3.5 w-3.5" />}환불 실행
                </button>
              </div>
            </>
          )}

          {result && (
            <div className="mt-3 text-sm">
              <p className="font-semibold text-emerald-600">환불 완료</p>
              <p className="mt-1 text-xs text-zinc-500">
                회수 {result.clawback ?? 0}개 ({result.before} → {result.after})
                {(result.shortfall ?? 0) > 0 && (
                  <span className="text-amber-600"> · 부족분 {result.shortfall}개(유저 사용분, 회수 못함)</span>
                )}
              </p>
              {refreshing && <p className="mt-1 text-[11px] text-zinc-400">목록 갱신 중…</p>}
              <div className="mt-3 flex justify-end">
                <button type="button" onClick={close} className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm">
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
