"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ModalShell } from "@/components/ModalShell";
import { Spinner } from "@/components/Spinner";
import { FadeImg } from "@/components/FadeImg";
import { shortId, fmtKst } from "@/lib/admin-format";
import type { ModerationRow, ModState, ModReport } from "@/lib/admin-moderation";

const REASON_KO: Record<string, string> = {
  portrait: "비동의 얼굴/초상권",
  defamation: "명예훼손·모욕",
  obscene: "음란·부적절",
  hate: "욕설·혐오",
  other: "기타",
};

const STATE_META: Record<ModState, { label: string; cls: string }> = {
  pending: { label: "대기", cls: "bg-amber-500/15 text-amber-600" },
  hidden: { label: "숨김", cls: "bg-yellow-500/15 text-yellow-600" },
  purged: { label: "영구삭제", cls: "bg-red-500/15 text-red-500" },
  dismissed: { label: "기각", cls: "bg-foreground/10 text-zinc-500" },
};

type ActionMode = "hide" | "dismiss" | "restore" | "permanent";

const MODE_META: Record<
  ActionMode,
  { title: string; desc: string; btn: string; danger: boolean; endpoint: string }
> = {
  hide: {
    title: "숨김",
    desc: "이 캐릭터 얼굴을 앱 전 표면에서 가립니다(기본 부장님 대체). 가역 — 나중에 복구할 수 있어요. 이 캐릭터의 대기 신고는 모두 처리됩니다. (이미 발급된 링크는 최대 10~15분 잔존)",
    btn: "숨김",
    danger: true,
    endpoint: "/api/admin/moderation/takedown",
  },
  dismiss: {
    title: "신고 기각",
    desc: "이 캐릭터의 대기중 신고를 모두 무효처리합니다(콘텐츠는 공개 유지).",
    btn: "기각",
    danger: false,
    endpoint: "/api/admin/moderation/dismiss",
  },
  restore: {
    title: "복구",
    desc: "숨김을 해제해 얼굴을 다시 표시하고, 이 숨김이 가린 하이라이트를 되살립니다(만료 등 다른 이유로 숨긴 건 그대로).",
    btn: "복구",
    danger: false,
    endpoint: "/api/admin/moderation/restore",
  },
  permanent: {
    title: "영구삭제",
    desc: "캐릭터 이미지와 관련 하이라이트 영상을 영구 삭제(storage 객체 제거)합니다. 복구할 수 없어요. 신고/점수 기록은 보존됩니다.",
    btn: "영구삭제",
    danger: true,
    endpoint: "/api/admin/moderation/permanent-delete",
  },
};

const ACTIONS_BY_STATE: Record<ModState, ActionMode[]> = {
  pending: ["hide", "dismiss"],
  hidden: ["restore", "permanent"],
  purged: [],
  dismissed: ["hide"],
};


export function ModerationQueueTable({ rows }: { rows: ModerationRow[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <ModerationRowItem key={r.dollId} row={r} />
      ))}
    </ul>
  );
}

function ModerationRowItem({ row }: { row: ModerationRow }) {
  const router = useRouter();
  const [mode, setMode] = useState<ActionMode | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  const st = STATE_META[row.state];
  const purged = row.state === "purged";

  const submit = async () => {
    if (busy || !mode || reason.trim().length < 5) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(MODE_META[mode].endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dollId: row.dollId, reason: reason.trim() }),
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
              ? "숨김 상태가 아니에요(새로고침 후 확인)."
              : "처리 실패 — 잠시 후 다시 시도하세요."
      );
    } catch {
      setError("네트워크 오류 — 다시 시도하세요.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="rounded-2xl border border-foreground/10 ui-surface p-3">
      <div className="flex gap-3">
        {/* 얼굴 미리보기 — 영구삭제면 placeholder(객체 없음), 숨김/공개는 서명 이미지(+숨김 오버레이) */}
        <div className="relative aspect-[3/4] w-16 shrink-0 overflow-hidden rounded-md border border-foreground/10 bg-foreground/10">
          {purged || !row.image_url ? (
            <div className="flex h-full w-full items-center justify-center text-xl">
              {purged ? "🗑️" : "😠"}
            </div>
          ) : (
            <>
              <FadeImg src={row.image_url} placeholder="shimmer" fit="contain" className="h-full w-full" />
              {row.state === "hidden" && (
                <span className="absolute inset-x-0 bottom-0 bg-yellow-500/80 py-0.5 text-center text-[9px] font-bold text-black">
                  숨김
                </span>
              )}
            </>
          )}
        </div>

        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${st.cls}`}>
              {st.label}
            </span>
            {row.report_count > 0 && (
              <button
                type="button"
                onClick={() => setOpen((v) => !v)}
                className="rounded-full bg-red-500/10 px-2 py-0.5 text-xs font-semibold text-red-500"
              >
                신고 {row.report_count}건
                {row.pending_count > 0 && row.state !== "pending" && ` (대기 ${row.pending_count})`}
                <span className="ml-0.5 text-[10px]">{open ? "▴" : "▾"}</span>
              </button>
            )}
            {row.latest_report_at && (
              <span className="text-[11px] text-zinc-400">· {fmtKst(row.latest_report_at)}</span>
            )}
          </div>

          {/* 신고 상세(접힘) — 펼치면 각 신고 사유·내용·연락처·시각 전체 */}
          {open && row.reports.length > 0 && (
            <ul className="mt-2 space-y-1.5 rounded-lg border border-foreground/10 bg-background/40 p-2">
              {row.reports.map((rep) => (
                <ReportDetail key={rep.id} rep={rep} />
              ))}
            </ul>
          )}

          {/* 클릭 필터: 캐릭터 / 제작자 + 회원 링크 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <Link
              href={`/admin/moderation?dollId=${row.dollId}`}
              className="rounded-full border border-foreground/15 px-2 py-0.5 font-mono text-zinc-500 transition hover:bg-foreground/10"
              title="이 캐릭터만 필터"
            >
              캐릭터 {shortId(row.dollId)}
            </Link>
            {row.owner_id ? (
              <>
                <Link
                  href={`/admin/moderation?ownerId=${row.owner_id}`}
                  className="rounded-full border border-foreground/15 px-2 py-0.5 text-zinc-500 transition hover:bg-foreground/10"
                  title="이 제작자만 필터"
                >
                  제작자 {row.owner_name ?? shortId(row.owner_id)}
                </Link>
                <Link
                  href={`/admin/users/${row.owner_id}`}
                  className="text-sky-600 underline-offset-2 hover:underline"
                  title="회원 상세로 이동"
                >
                  회원 →
                </Link>
              </>
            ) : (
              <span className="text-zinc-400">제작자 — (탈퇴/삭제)</span>
            )}
          </div>

          {/* 상태별 액션 */}
          <div className="mt-2 flex flex-wrap items-center gap-2">
            {ACTIONS_BY_STATE[row.state].map((m) => (
              <button
                key={m}
                type="button"
                onClick={() => {
                  setMode(m);
                  setReason("");
                  setError(null);
                }}
                className={`rounded-lg border px-2 py-1 text-xs font-medium ${
                  MODE_META[m].danger
                    ? "border-red-400/50 text-red-500"
                    : m === "restore"
                      ? "border-emerald-500/50 text-emerald-600"
                      : "border-foreground/20"
                }`}
              >
                {MODE_META[m].btn}
              </button>
            ))}
            {purged && (
              <span className="text-[11px] text-zinc-400">영구삭제됨 · 복구 불가</span>
            )}
            {!purged && (
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
        <ModalShell onClose={() => !busy && setMode(null)}>
          <h3 className="text-base font-bold">{MODE_META[mode].title}</h3>
          <p className="mt-1 text-xs leading-relaxed text-zinc-500">{MODE_META[mode].desc}</p>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="사유(5~500자)"
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
                MODE_META[mode].danger ? "bg-red-500 text-white" : "bg-foreground text-paper-2"
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

function ReportDetail({ rep }: { rep: ModReport }) {
  const stLabel =
    rep.status === "pending" ? "대기" : rep.status === "dismissed" ? "기각" : "처리";
  return (
    <li className="text-[11px] leading-relaxed">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="rounded bg-red-500/10 px-1.5 py-0.5 font-semibold text-red-500">
          {REASON_KO[rep.reason] ?? rep.reason}
        </span>
        <span className="text-zinc-400">{stLabel}</span>
        <span className="text-zinc-400">· {fmtKst(rep.created_at)}</span>
        {rep.contact && <span className="text-zinc-400">· 연락처: {rep.contact}</span>}
      </div>
      {rep.detail && (
        <p className="mt-0.5 whitespace-pre-wrap break-words text-zinc-500">{rep.detail}</p>
      )}
    </li>
  );
}
