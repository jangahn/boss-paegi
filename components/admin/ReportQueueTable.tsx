"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";
import { shortId } from "@/lib/admin-format";
import type { ReportRow } from "@/lib/admin-moderation";

const REASON_KO: Record<string, string> = {
  portrait: "비동의 얼굴/초상권",
  defamation: "명예훼손·모욕",
  obscene: "음란·부적절",
  hate: "욕설·혐오",
  other: "기타",
};

const STATUS_META: Record<string, { label: string; cls: string }> = {
  pending: { label: "대기", cls: "bg-amber-500/10 text-amber-600" },
  actioned: { label: "삭제됨", cls: "bg-red-500/10 text-red-500" },
  dismissed: { label: "기각", cls: "bg-foreground/10 text-zinc-500" },
};

type ActionMode = "takedown" | "dismiss" | "restore" | "permanent";

const MODE_META: Record<
  ActionMode,
  { title: string; desc: string; btn: string; danger: boolean }
> = {
  takedown: {
    title: "콘텐츠 숨김 (takedown)",
    desc: "이 인형의 얼굴을 앱 전 표면에서 숨깁니다(기본 부장님으로 대체). 가역 — 나중에 복구할 수 있어요. 이 인형의 대기 신고는 모두 처리됩니다. (이미 발급된 링크는 최대 10~15분 잔존)",
    btn: "숨김",
    danger: true,
  },
  dismiss: {
    title: "신고 기각",
    desc: "이 신고를 기각합니다(콘텐츠는 유지).",
    btn: "기각",
    danger: false,
  },
  restore: {
    title: "복구",
    desc: "이 인형을 복구합니다 — 얼굴이 다시 표시되고, 이 takedown 이 숨긴 하이라이트가 되살아납니다(만료 등 다른 이유로 숨긴 건 그대로).",
    btn: "복구",
    danger: false,
  },
  permanent: {
    title: "영구삭제 (artifact purge)",
    desc: "인형 이미지와 관련 하이라이트 영상을 영구 삭제(storage 객체 제거)합니다. 복구할 수 없어요. 신고/점수 기록은 보존됩니다.",
    btn: "영구삭제",
    danger: true,
  },
};

function timeShort(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
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
  const [mode, setMode] = useState<null | ActionMode>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const doll = row.doll;
  const deleted = !!doll?.deleted_at;
  const purged = !!doll?.artifacts_purged_at;
  const st = STATUS_META[row.status] ?? { label: row.status, cls: "bg-foreground/10 text-zinc-500" };

  const open = (m: ActionMode) => {
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
      const url = {
        takedown: "/api/admin/moderation/takedown",
        dismiss: "/api/admin/moderation/dismiss",
        restore: "/api/admin/moderation/restore",
        permanent: "/api/admin/moderation/permanent-delete",
      }[mode];
      // dismiss 만 reportId, 나머지(takedown/restore/permanent)는 dollId.
      const payload =
        mode === "dismiss"
          ? { reportId: row.id, reason: reason.trim() }
          : { dollId: row.dollId, reason: reason.trim() };
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
          : body.error === "already_purged"
            ? "이미 영구삭제되어 복구할 수 없어요."
            : body.error === "not_taken_down"
              ? "숨김(takedown) 상태가 아니에요(새로고침 후 확인)."
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
        {/* 미리보기 — purged(영구삭제)면 placeholder(이미지 없음), 아니면 서명 이미지(삭제돼도 어드민은 얼굴 확인). */}
        {!doll?.image_url ? (
          <div className="flex aspect-[3/4] w-16 shrink-0 items-center justify-center rounded-md border border-foreground/10 bg-foreground/10 text-xl">
            {deleted ? "🗑️" : "😠"}
          </div>
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={doll.image_url}
            alt=""
            className="aspect-[3/4] w-16 shrink-0 rounded-md border border-foreground/10 bg-foreground/10 object-contain"
          />
        )}

        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${st.cls}`}>
              {st.label}
            </span>
            <span className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-500">
              {REASON_KO[row.reason] ?? row.reason}
            </span>
          </div>

          {row.detail && (
            <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-500">
              {row.detail}
            </p>
          )}

          {/* 클릭 필터: 캐릭터 / 제작자 + 회원 링크 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <Link
              href={`/admin/moderation?dollId=${row.dollId}`}
              className="rounded-full border border-foreground/15 px-2 py-0.5 font-mono text-zinc-500 transition hover:bg-foreground/10"
              title="이 캐릭터 신고만 필터"
            >
              캐릭터 {shortId(row.dollId)}
            </Link>
            {doll?.owner_id ? (
              <>
                <Link
                  href={`/admin/moderation?ownerId=${doll.owner_id}`}
                  className="rounded-full border border-foreground/15 px-2 py-0.5 text-zinc-500 transition hover:bg-foreground/10"
                  title="이 제작자 신고만 필터"
                >
                  제작자 {doll.owner_name ?? shortId(doll.owner_id)}
                </Link>
                <Link
                  href={`/admin/users/${doll.owner_id}`}
                  className="text-sky-600 underline-offset-2 hover:underline"
                  title="회원 상세로 이동"
                >
                  회원 →
                </Link>
              </>
            ) : (
              <span className="text-zinc-400">제작자 — (탈퇴/삭제)</span>
            )}
            {row.contact && <span className="text-zinc-400">· 연락처: {row.contact}</span>}
            <span className="text-zinc-400">· {timeShort(row.created_at)}</span>
          </div>

          {/* 액션 */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {doll && !deleted && (
              <button
                type="button"
                onClick={() => open("takedown")}
                className="rounded-lg border border-red-400/50 px-2 py-1 text-xs font-medium text-red-500"
              >
                삭제(takedown)
              </button>
            )}
            {row.status === "pending" && (
              <button
                type="button"
                onClick={() => open("dismiss")}
                className="rounded-lg border border-foreground/20 px-2 py-1 text-xs font-medium"
              >
                기각
              </button>
            )}
            {deleted && !purged && (
              <>
                <button
                  type="button"
                  onClick={() => open("restore")}
                  className="rounded-lg border border-emerald-500/50 px-2 py-1 text-xs font-medium text-emerald-600"
                >
                  복구
                </button>
                <button
                  type="button"
                  onClick={() => open("permanent")}
                  className="rounded-lg border border-red-500/60 px-2 py-1 text-xs font-medium text-red-600"
                >
                  영구삭제
                </button>
              </>
            )}
            {purged && (
              <span className="text-[11px] text-zinc-400">영구삭제됨 · 복구 불가</span>
            )}
            {!deleted && (
              <a
                href={`/doll/${row.dollId}`}
                target="_blank"
                rel="noreferrer"
                className="rounded-lg border border-foreground/20 px-2 py-1 text-xs text-zinc-500"
              >
                미리보기 ↗
              </a>
            )}
          </div>
        </div>
      </div>

      {mode && (
        <ModalShell onClose={close}>
          <h3 className="text-base font-bold">{MODE_META[mode].title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">
            {MODE_META[mode].desc}
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
                MODE_META[mode].danger ? "bg-red-500 text-white" : "bg-foreground text-background"
              }`}
            >
              {busy && <Spinner className="h-3.5 w-3.5" />}
              {MODE_META[mode].btn}
            </button>
          </div>
        </ModalShell>
      )}
    </li>
  );
}
