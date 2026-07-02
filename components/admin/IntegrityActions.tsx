"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * 무결성 상세 조치 버튼 — clear/void(점수) · ban/unban(유저).
 * 각 조치는 사유(5~500자) 입력 후 서버 route → RPC(감사 원장 기록). 성공 시 새로고침.
 */
export function IntegrityActions({
  scoreId,
  ownerId,
  reviewStatus,
  abuseStatus,
}: {
  scoreId: string;
  ownerId: string;
  reviewStatus: string;
  abuseStatus: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = async (
    label: string,
    path: string,
    payload: Record<string, unknown>
  ) => {
    const reason = window.prompt(`${label} 사유(5~500자):`);
    if (reason == null) return;
    if (reason.trim().length < 5) {
      setErr("사유는 5자 이상이어야 합니다.");
      return;
    }
    setBusy(label);
    setErr(null);
    try {
      const r = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...payload, reason: reason.trim() }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error ?? "action_failed");
      router.refresh();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "action_failed");
    } finally {
      setBusy(null);
    }
  };

  const banned = abuseStatus === "banned";
  const btn =
    "rounded-md px-3 py-2 text-sm font-medium transition disabled:opacity-40";

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap gap-2">
        {reviewStatus !== "cleared" && (
          <button
            className={`${btn} bg-emerald-600 text-white hover:opacity-90`}
            disabled={!!busy}
            onClick={() => run("정상 확인(clear)", "/api/admin/integrity/clear", { scoreId })}
          >
            {busy === "정상 확인(clear)" ? "처리 중…" : "정상 확인 (노출)"}
          </button>
        )}
        {reviewStatus !== "voided" && (
          <button
            className={`${btn} bg-red-600 text-white hover:opacity-90`}
            disabled={!!busy}
            onClick={() => run("무효(void)", "/api/admin/integrity/void", { scoreId })}
          >
            {busy === "무효(void)" ? "처리 중…" : "무효 처리 (숨김)"}
          </button>
        )}
      </div>
      <div className="flex flex-wrap gap-2 border-t border-white/10 pt-2">
        {!banned ? (
          <button
            className={`${btn} border border-red-500/50 text-red-400 hover:bg-red-500/10`}
            disabled={!!busy}
            onClick={() => run("유저 정지(ban)", "/api/admin/integrity/ban", { memberId: ownerId })}
          >
            {busy === "유저 정지(ban)" ? "처리 중…" : "유저 정지 (전 점수 숨김)"}
          </button>
        ) : (
          <button
            className={`${btn} border border-white/30 text-zinc-200 hover:bg-white/10`}
            disabled={!!busy}
            onClick={() => run("정지 해제(unban)", "/api/admin/integrity/unban", { memberId: ownerId })}
          >
            {busy === "정지 해제(unban)" ? "처리 중…" : "정지 해제 (점수 자동복구 안 함)"}
          </button>
        )}
      </div>
      {err && <p className="text-xs text-red-400">조치 실패: {err}</p>}
    </div>
  );
}
