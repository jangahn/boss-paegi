"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";
import type { ReportRow } from "@/lib/admin-moderation";

const REASON_KO: Record<string, string> = {
  portrait: "비동의 얼굴/초상권",
  defamation: "명예훼손·모욕",
  obscene: "음란·부적절",
  hate: "욕설·혐오",
  other: "기타",
};

function timeShort(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ko-KR", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return iso;
  }
}

export function ReportQueueTable({ rows }: { rows: ReportRow[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <ReportRowItem key={r.id} row={r} />
      ))}
    </ul>
  );
}

function ReportRowItem({ row }: { row: ReportRow }) {
  const router = useRouter();
  const [mode, setMode] = useState<null | "takedown" | "dismiss">(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const alreadyDown = !!row.doll?.deleted_at;

  const open = (m: "takedown" | "dismiss") => {
    setMode(m);
    setReason("");
    setError(null);
  };
  const close = () => {
    if (busy) return;
    setMode(null);
    setError(null);
  };

  const submit = async () => {
    if (busy || reason.trim().length < 5 || !mode) return;
    setBusy(true);
    setError(null);
    try {
      const url =
        mode === "takedown"
          ? "/api/admin/moderation/takedown"
          : "/api/admin/moderation/dismiss";
      const payload =
        mode === "takedown"
          ? { dollId: row.dollId, reason: reason.trim() }
          : { reportId: row.id, reason: reason.trim() };
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
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
          : "처리 실패 — 잠시 후 다시 시도하세요."
      );
    } catch {
      setError("네트워크 오류 — 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-2xl border border-foreground/10 bg-foreground/5 p-3">
      <div className="flex gap-3">
        {row.doll?.image_url ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={row.doll.image_url}
            alt=""
            className="aspect-[3/4] w-16 shrink-0 rounded-md border border-foreground/10 bg-foreground/10 object-contain"
          />
        ) : (
          <div className="flex aspect-[3/4] w-16 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/10 text-xl">
            {alreadyDown ? "🗑️" : "😠"}
          </div>
        )}

        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-500">
              {REASON_KO[row.reason] ?? row.reason}
            </span>
            {row.dollPendingCount > 1 && (
              <span className="text-xs text-zinc-500">
                이 인형 신고 {row.dollPendingCount}건
              </span>
            )}
            {alreadyDown && <span className="text-xs text-zinc-500">· 이미 삭제됨</span>}
          </div>

          {row.detail && (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-500">
              {row.detail}
            </p>
          )}

          <div className="mt-1 flex flex-wrap gap-x-2 text-[11px] text-zinc-400">
            <span>제작자: {row.doll?.owner_name ?? "—"}</span>
            {row.contact && <span>· 연락처: {row.contact}</span>}
            <span>· {timeShort(row.created_at)}</span>
          </div>

          <div className="mt-2 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => open("takedown")}
              className="rounded-lg border border-red-400/50 px-2 py-1 text-xs font-medium text-red-500"
            >
              {alreadyDown ? "재삭제(파일)" : "삭제(takedown)"}
            </button>
            <button
              type="button"
              onClick={() => open("dismiss")}
              className="rounded-lg border border-foreground/20 px-2 py-1 text-xs font-medium"
            >
              기각
            </button>
            <a
              href={`/doll/${row.dollId}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-lg border border-foreground/20 px-2 py-1 text-xs text-zinc-500"
            >
              미리보기 ↗
            </a>
          </div>
        </div>
      </div>

      {mode && (
        <ModalShell onClose={close}>
          <h3 className="text-base font-bold">
            {mode === "takedown" ? "콘텐츠 삭제 (takedown)" : "신고 기각"}
          </h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {mode === "takedown"
              ? "인형 이미지와 관련 하이라이트 영상을 영구 삭제합니다. 복구할 수 없어요. 이 인형의 대기 신고는 모두 처리됩니다."
              : "이 신고를 기각합니다(콘텐츠는 유지)."}
          </p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="사유(5~500자)"
            maxLength={500}
            rows={2}
            className="mt-3 w-full rounded-lg border border-foreground/15 bg-transparent px-3 py-2 text-sm outline-none"
          />
          {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
          <div className="mt-3 flex justify-end gap-2">
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
              onClick={() => void submit()}
              disabled={busy || reason.trim().length < 5}
              className={`flex items-center gap-1 rounded-lg px-3 py-1.5 text-sm font-semibold disabled:opacity-40 ${
                mode === "takedown"
                  ? "bg-red-500 text-white"
                  : "bg-foreground text-background"
              }`}
            >
              {busy && <Spinner className="h-3.5 w-3.5" />}
              {mode === "takedown" ? "영구 삭제" : "기각"}
            </button>
          </div>
        </ModalShell>
      )}
    </li>
  );
}
