"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";

/**
 * 탈퇴 계정 재활성 — 본인 요청 시 운영자가 계정만 복구(데이터 미복구).
 * 오발 방지: 신원확인·데이터미복구 안내 2-체크 + 사유 필수. 서버(admin_reactivate_account)도 재검증.
 * 성공 시 잔액/배지는 server 단일 소스 → router.refresh() 로 페이지 갱신.
 */
const ERR_KO: Record<string, string> = {
  not_withdrawn: "이미 활성 계정이에요 (탈퇴 상태가 아님).",
  not_found: "존재하지 않는 계정이에요.",
  email_conflict: "같은 이메일을 쓰는 다른 활성 계정이 있어 복구할 수 없어요.",
  identity_email_missing: "원본 이메일을 찾을 수 없어요. 아래에 이메일을 직접 입력해 주세요.",
  reason_invalid: "사유를 5자 이상 입력하세요.",
  missing_fields: "입력값을 확인하세요.",
  not_admin: "권한이 없어요.",
};

type Target = { userId: string; originalEmail: string | null };

export function ReactivateAccountForm({ target }: { target: Target }) {
  const router = useRouter();
  const [, startRefresh] = useTransition();
  const [reason, setReason] = useState("");
  const [emailOverride, setEmailOverride] = useState("");
  const [ackIdentity, setAckIdentity] = useState(false);
  const [ackData, setAckData] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reasonValid = reason.trim().length >= 5;
  const canApply = !busy && reasonValid && ackIdentity && ackData;

  const apply = async () => {
    if (!canApply) return;
    setBusy(true);
    setError(null);
    setMsg(null);
    try {
      const res = await fetch("/api/admin/reactivate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          userId: target.userId,
          reason: reason.trim(),
          emailOverride: emailOverride.trim() || undefined,
        }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && out.ok) {
        setMsg("계정을 재활성했어요. 본인이 재로그인하면 약관·방침 재동의 후 이용할 수 있어요.");
        startRefresh(() => router.refresh());
      } else {
        setError(ERR_KO[out.error ?? ""] ?? "재활성에 실패했어요. 다시 시도해 주세요.");
      }
    } catch {
      setError("네트워크 오류 — 다시 시도해 주세요.");
    } finally {
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
    </div>
  );
}
