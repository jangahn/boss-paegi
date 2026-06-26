"use client";

import { useState } from "react";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";

// 사유 코드 = /api/report allowlist 와 일치. label 만 한국어.
const REASONS: { value: string; label: string }[] = [
  { value: "portrait", label: "비동의 내 얼굴 / 초상권 침해" },
  { value: "defamation", label: "명예훼손 · 모욕" },
  { value: "obscene", label: "음란 · 부적절" },
  { value: "hate", label: "욕설 · 혐오" },
  { value: "other", label: "기타" },
];

/** 콘텐츠 신고 다이얼로그 — 비로그인도 제출 가능. Phase 1 target=doll. */
export function ReportDialog({
  dollId,
  onClose,
}: {
  dollId: string;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const [detail, setDetail] = useState("");
  const [contact, setContact] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    if (busy || !reason) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          targetId: dollId,
          reason,
          detail: detail.trim() || undefined,
          contact: contact.trim() || undefined,
        }),
      });
      if (res.ok) {
        setDone(true);
        return;
      }
      const out = (await res.json().catch(() => ({}))) as { error?: string };
      setError(
        out.error === "rate_limited"
          ? "신고가 너무 잦아요. 잠시 후 다시 시도해 주세요."
          : "신고 접수에 실패했어요. 잠시 후 다시 시도해 주세요."
      );
    } catch {
      setError("네트워크 오류 — 다시 시도해 주세요.");
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <ModalShell onClose={onClose}>
        <h2 className="text-lg font-bold">신고가 접수됐어요</h2>
        <p className="mt-2 text-sm text-zinc-500">
          검토 후 조치하겠습니다. 연락처를 남기셨다면 처리 관련 연락을 드릴 수 있어요.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 w-full rounded-full bg-foreground py-2.5 text-sm font-semibold text-paper-2 transition hover:opacity-90"
        >
          닫기
        </button>
      </ModalShell>
    );
  }

  return (
    <ModalShell onClose={onClose}>
      <h2 className="text-lg font-bold">콘텐츠 신고</h2>
      <p className="mt-1 text-sm text-zinc-500">
        동의 없이 올라간 얼굴 등 문제가 있으면 신고해 주세요.
      </p>

      <div className="mt-3 space-y-1.5">
        {REASONS.map((r) => (
          <label key={r.value} className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              name="report-reason"
              value={r.value}
              checked={reason === r.value}
              onChange={() => setReason(r.value)}
              className="shrink-0"
            />
            <span>{r.label}</span>
          </label>
        ))}
      </div>

      <textarea
        value={detail}
        onChange={(e) => setDetail(e.target.value)}
        maxLength={2000}
        rows={3}
        placeholder="상세 내용 (선택)"
        className="mt-3 w-full resize-none rounded-xl border border-foreground/15 ui-field p-2.5 text-sm outline-none focus:border-foreground/30"
      />
      <input
        value={contact}
        onChange={(e) => setContact(e.target.value)}
        maxLength={200}
        placeholder="연락처 (선택) — 처리 관련 연락을 받을 수 있어요"
        className="mt-2 w-full rounded-xl border border-foreground/15 ui-field p-2.5 text-sm outline-none focus:border-foreground/30"
      />

      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}

      <div className="mt-4 flex gap-2">
        <button
          type="button"
          onClick={onClose}
          className="flex-1 rounded-full border border-foreground/15 ui-surface py-2.5 text-sm font-medium transition hover:bg-foreground/5"
        >
          취소
        </button>
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !reason}
          className="flex flex-1 items-center justify-center gap-2 rounded-full bg-red-500 py-2.5 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
        >
          {busy && <Spinner className="h-4 w-4" />}
          신고
        </button>
      </div>
    </ModalShell>
  );
}
