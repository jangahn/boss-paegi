"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";

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

  const d = Number(delta);
  const entered = delta.trim() !== "";
  const notInt = entered && !Number.isInteger(d);
  const outOfRange = entered && Number.isInteger(d) && (d > 100 || d < -100);
  const isZero = entered && Number.isInteger(d) && d === 0;
  const deltaValid = entered && Number.isInteger(d) && d !== 0 && d >= -100 && d <= 100;
  const reasonValid = reason.trim().length >= 5;
  const canApply = !busy && deltaValid && reasonValid;

  const hint = notInt
    ? "정수만 입력하세요"
    : outOfRange
      ? "범위 초과 (-100~100), 변경 불가"
      : isZero
        ? "0은 변경할 수 없어요"
        : entered && deltaValid && !reasonValid
          ? "사유를 5자 이상 입력하세요"
          : null;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/adjust", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetUserId: target.userId, delta: d, reason: reason.trim() }),
      });
      const out = (await res.json().catch(() => ({}))) as {
        error?: string;
        before?: number;
        after?: number;
        applied?: number;
        requested?: number;
      };
      if (!res.ok) throw new Error(out.error ?? "failed");
      const clamped =
        out.applied !== undefined && out.requested !== undefined && out.applied !== out.requested;
      setMsg(
        `완료: ${out.before} → ${out.after} 크레딧` +
          (clamped ? ` (요청 ${out.requested}, 실제 ${out.applied} 적용 — 0 클램프)` : "")
      );
      setDelta("");
      setReason("");
      startRefresh(() => router.refresh()); // 페이지 잔액 + 조정 이력 ledger 재조회(단일 소스, pending 가시화).
    } catch (e) {
      setError(e instanceof Error ? e.message : "적용 실패");
    } finally {
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
          placeholder="±delta(-100~100, ≠0)"
          aria-invalid={notInt || outOfRange || isZero}
          className="w-32 rounded-lg border border-foreground/15 ui-field px-2 py-1.5 text-sm outline-none aria-invalid:border-red-400"
        />
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="사유(5~500자)"
          maxLength={500}
          className="min-w-0 flex-1 rounded-lg border border-foreground/15 ui-field px-2 py-1.5 text-sm outline-none"
        />
        <button
          type="button"
          onClick={() => void apply()}
          disabled={!canApply}
          className="flex items-center gap-1 rounded-lg bg-foreground px-3 py-1.5 text-sm font-semibold text-paper-2 disabled:opacity-40"
        >
          {busy && <Spinner className="h-3.5 w-3.5" />}적용
        </button>
      </div>
      {hint && <p className="text-xs text-amber-600">{hint}</p>}
      {msg && <p className="text-xs text-emerald-600">{msg}</p>}
      {refreshing && <p className="text-[11px] text-zinc-400">갱신 중…</p>}
      {error && <p className="text-xs text-red-400">{error}</p>}
    </div>
  );
}
