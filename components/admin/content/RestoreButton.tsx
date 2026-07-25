"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Spinner } from "@/components/Spinner";

const ERR_KO: Record<string, string> = {
  version_conflict: "그 사이 다른 발행이 있었어요. 새로고침 후 다시 시도하세요.",
  validation_failed: "이 버전 값이 현재 형식에 맞지 않아 복원할 수 없어요.",
  target_not_found: "복원 대상을 찾을 수 없어요.",
  update_failed: "복원 실패. 잠시 후 다시 시도하세요.",
};

/**
 * 감사행 1건을 그 시점 값으로 재발행(롤백). 전 config 도메인 공용.
 * 서버가 auditId 로 값을 조회하므로 클라는 복원 value 를 보내지 않는다(action:"restore").
 * baseVersion = 현재 발행 버전 → CAS 로 동시 변경 시 409.
 */
export function RestoreButton({
  configKey,
  auditId,
  targetVersion,
  currentVersion,
  isCurrent,
}: {
  configKey: string;
  auditId: string;
  targetVersion: number;
  currentVersion: number;
  isCurrent: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (isCurrent) {
    return <span className="text-[11px] font-medium text-emerald-600">현재 버전</span>;
  }

  const restore = async () => {
    if (busy) return;
    if (
      !window.confirm(
        `이 도메인 전체 설정을 v${targetVersion} 시점 값으로 되돌립니다(새 발행으로 기록). 계속할까요?`
      )
    )
      return;
    setBusy(true);
    setErr(null);
    try {
      const res = await fetch("/api/admin/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          action: "restore",
          key: configKey,
          auditId,
          baseVersion: currentVersion,
        }),
      });
      const out = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (res.ok && out.ok) {
        router.refresh();
      } else {
        setErr(ERR_KO[out.error ?? ""] ?? out.error ?? "복원 실패");
      }
    } catch {
      setErr("네트워크 오류 — 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-col items-end gap-1">
      <button
        type="button"
        onClick={() => void restore()}
        disabled={busy}
        className="flex items-center gap-1.5 rounded-full border border-foreground/15 ui-surface px-3 py-1 text-[11px] font-medium transition hover:bg-foreground/5 disabled:opacity-40"
      >
        {busy && <Spinner className="h-3 w-3" />}
        이 버전으로 되돌리기
      </button>
      {err && <span className="text-[11px] text-red-400">{err}</span>}
    </div>
  );
}
