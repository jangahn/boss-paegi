"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";

/**
 * 무결성 상세 조치 — 정상확인(clear)·무효(void)·유저정지(ban)·정지해제(unban).
 * 신고 모더레이션(ModerationQueueTable)과 동일 패턴: ModalShell + 패널티 설명 + 사유(5~500자) → RPC.
 */
type ActionKey = "clear" | "void" | "ban" | "unban";

const ACTION_META: Record<
  ActionKey,
  { title: string; desc: string; btn: string; danger: boolean; endpoint: string; target: "score" | "member" }
> = {
  clear: {
    title: "정상 확인",
    desc: "이 점수를 정상으로 확정합니다. 리더보드·백분위·기록 등 공개면에 다시 노출되고, 자동 재검토(cron)에서 제외됩니다.",
    btn: "정상 확인",
    danger: false,
    endpoint: "/api/admin/integrity/clear",
    target: "score",
  },
  void: {
    title: "무효 처리",
    desc: "이 점수를 무효로 숨깁니다. 리더보드·백분위·공유·기록 등 모든 공개면에서 제외되고, 이 점수로 획득한 뱃지가 회수됩니다. 유저 계정 자체는 정지되지 않아요. 가역 — 나중에 정상 확인으로 되돌릴 수 있습니다.",
    btn: "무효 처리",
    danger: true,
    endpoint: "/api/admin/integrity/void",
    target: "score",
  },
  ban: {
    title: "유저 정지",
    desc: "이 유저를 정지합니다. 이 유저의 모든 점수가 즉시 무효(숨김) 처리되고 뱃지가 회수되며, 앞으로 제출하는 점수도 공개 랭킹에 등록되지 않습니다. 로그인·게임 플레이·캐릭터 생성은 계속 가능합니다.",
    btn: "유저 정지",
    danger: true,
    endpoint: "/api/admin/integrity/ban",
    target: "member",
  },
  unban: {
    title: "정지 해제",
    desc: "유저 정지를 해제합니다. 앞으로의 점수는 정상 등록되지만, 이미 무효 처리된 과거 점수는 자동 복구되지 않습니다(개별 점수를 정상 확인으로 되돌려야 함).",
    btn: "정지 해제",
    danger: false,
    endpoint: "/api/admin/integrity/unban",
    target: "member",
  },
};

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
  const [mode, setMode] = useState<ActionKey | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !mode || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    const meta = ACTION_META[mode];
    try {
      const res = await fetch(meta.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          meta.target === "score"
            ? { scoreId, reason: reason.trim() }
            : { memberId: ownerId, reason: reason.trim() }
        ),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (res.ok) {
        setMode(null);
        setReason("");
        router.refresh();
        return;
      }
      setError(
        body.error === "reason_invalid"
          ? "사유는 5~500자여야 해요."
          : body.error === "score_not_found"
            ? "점수를 찾을 수 없어요(새로고침 후 확인)."
            : body.error === "not_admin"
              ? "권한이 없어요."
              : "처리 실패 — 잠시 후 다시 시도하세요."
      );
    } catch {
      setError("네트워크 오류 — 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  };

  const btnCls = (danger: boolean, positive = false) =>
    `rounded-lg border px-3 py-1.5 text-sm font-medium transition ${
      danger
        ? "border-red-400/50 text-red-500 hover:bg-red-500/10"
        : positive
          ? "border-emerald-500/50 text-emerald-600 hover:bg-emerald-500/10"
          : "border-foreground/20 text-foreground hover:bg-foreground/5"
    }`;

  const banned = abuseStatus === "banned";
  const meta = mode ? ACTION_META[mode] : null;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {reviewStatus !== "cleared" && (
          <button type="button" className={btnCls(false, true)} onClick={() => { setMode("clear"); setReason(""); setError(null); }}>
            정상 확인 (노출)
          </button>
        )}
        {reviewStatus !== "voided" && (
          <button type="button" className={btnCls(true)} onClick={() => { setMode("void"); setReason(""); setError(null); }}>
            무효 처리 (숨김)
          </button>
        )}
        {!banned ? (
          <button type="button" className={btnCls(true)} onClick={() => { setMode("ban"); setReason(""); setError(null); }}>
            유저 정지
          </button>
        ) : (
          <button type="button" className={btnCls(false)} onClick={() => { setMode("unban"); setReason(""); setError(null); }}>
            정지 해제
          </button>
        )}
      </div>

      {mode && meta && (
        <ModalShell onClose={() => !busy && setMode(null)}>
          <h3 className="text-base font-bold">{meta.title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">{meta.desc}</p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="사유(5~500자) — 감사 기록에 남습니다"
            maxLength={500}
            rows={2}
            className="mt-3 w-full rounded-lg border border-foreground/15 ui-field px-3 py-2 text-sm outline-none"
          />
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => !busy && setMode(null)}
              disabled={busy}
              className="rounded-lg border border-foreground/20 px-3 py-1.5 text-sm disabled:opacity-40"
            >
              닫기
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={busy || reason.trim().length < 5}
              className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ${
                meta.danger ? "bg-red-500 text-white" : "bg-foreground text-paper-2"
              }`}
            >
              {busy && <Spinner className="h-3.5 w-3.5" />}
              {meta.btn}
            </button>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
