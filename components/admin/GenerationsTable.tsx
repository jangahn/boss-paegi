"use client";

import { useState } from "react";
import Link from "next/link";
import { FadeImg } from "@/components/FadeImg";
import { shortId } from "@/lib/admin-format";
import type { AdminGeneration, AdminGenStatus } from "@/lib/admin-generations";

const STATUS_META: Record<AdminGenStatus, { label: string; cls: string; icon: string }> = {
  requested: { label: "생성요청", cls: "bg-sky-500/15 text-sky-600", icon: "⏳" },
  rejected: { label: "거부(얼굴X)", cls: "bg-orange-500/15 text-orange-600", icon: "🚫" },
  failed: { label: "실패", cls: "bg-red-500/15 text-red-500", icon: "⚠️" },
  unpicked: { label: "선택 전", cls: "bg-amber-500/15 text-amber-600", icon: "🖼️" },
  picked: { label: "선택완료", cls: "bg-emerald-500/15 text-emerald-600", icon: "✅" },
};

const CREDIT_META: Record<AdminGeneration["creditNote"], { label: string; cls: string }> = {
  consumed: { label: "−1 차감", cls: "text-zinc-500" },
  refunded: { label: "차감→환불", cls: "text-emerald-600" },
  none: { label: "미차감", cls: "text-zinc-400" },
};

const FAIL_KO: Record<string, string> = {
  no_face: "얼굴 미검출(no_face)",
  no_credits: "크레딧 부족",
  submit_error: "제출 오류",
  fal_error: "생성 오류(fal)",
  no_requests: "요청 없음",
  timeout: "시간초과(30분)",
  expired: "후보 만료",
};

function timeShort(iso: string): string {
  try {
    return new Date(iso).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" });
  } catch {
    return iso;
  }
}

export function GenerationsTable({ rows }: { rows: AdminGeneration[] }) {
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <GenRowItem key={r.id} row={r} />
      ))}
    </ul>
  );
}

function GenRowItem({ row }: { row: AdminGeneration }) {
  const [open, setOpen] = useState(false);
  const st = STATUS_META[row.adminStatus];
  const credit = CREDIT_META[row.creditNote];
  const thumb = row.candidateThumbs[0] ?? null;

  return (
    <li className="rounded-2xl border border-foreground/10 ui-surface p-3">
      <div className="flex gap-3">
        {/* 대표 썸네일 — done/picked 만 이미지, 그 외 상태 아이콘 */}
        <div className="flex aspect-[3/4] w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-foreground/10 bg-foreground/10 text-xl">
          {thumb ? (
            <FadeImg src={thumb} placeholder="shimmer" fit="contain" className="h-full w-full" />
          ) : (
            <span aria-hidden>{st.icon}</span>
          )}
        </div>

        <div className="min-w-0 flex-1 text-sm">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${st.cls}`}>
              {st.label}
            </span>
            <span className={`text-[11px] ${credit.cls}`}>{credit.label}</span>
            <span className="text-[11px] text-zinc-400">· {timeShort(row.createdAt)}</span>
            <button
              type="button"
              onClick={() => setOpen((v) => !v)}
              className="ml-auto rounded-full border border-foreground/15 px-2 py-0.5 text-[11px] text-zinc-500 transition hover:bg-foreground/10"
            >
              상세 <span className="text-[10px]">{open ? "▴" : "▾"}</span>
            </button>
          </div>

          {/* 클릭 필터: 회원 / 캐릭터 + 회원 상세 이동 */}
          <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
            <Link
              href={`/admin/generations?ownerId=${row.ownerId}`}
              className="rounded-full border border-foreground/15 px-2 py-0.5 text-zinc-500 transition hover:bg-foreground/10"
              title="이 회원의 생성만 필터"
            >
              회원 {row.ownerName ?? shortId(row.ownerId)}
            </Link>
            <Link
              href={`/admin/users/${row.ownerId}`}
              className="text-sky-600 underline-offset-2 hover:underline"
              title="회원 상세로 이동"
            >
              회원 →
            </Link>
            {row.pickedDollId ? (
              <Link
                href={`/admin/generations?dollId=${row.pickedDollId}`}
                className="rounded-full border border-foreground/15 px-2 py-0.5 font-mono text-zinc-500 transition hover:bg-foreground/10"
                title="이 캐릭터 관련만 필터"
              >
                캐릭터 {shortId(row.pickedDollId)}
              </Link>
            ) : (
              <span className="font-mono text-zinc-400">gen {shortId(row.id)}</span>
            )}
            <span className="text-zinc-400">롤 {row.role}</span>
          </div>

          {open && <GenDetail row={row} />}
        </div>
      </div>
    </li>
  );
}

function GenDetail({ row }: { row: AdminGeneration }) {
  return (
    <div className="mt-2 space-y-2 rounded-lg border border-foreground/10 bg-background/40 p-2 text-[11px]">
      {/* 후보 — 선택 전: 3장 / 선택완료: 고른 1장(나머지는 pick 시 삭제) */}
      {row.candidateThumbs.length > 0 ? (
        <div>
          <p className="mb-1 text-zinc-500">
            {row.adminStatus === "picked"
              ? `고른 캐릭터${row.pickedIndex !== null ? ` (후보 #${row.pickedIndex + 1})` : ""} · 나머지 후보는 선택 시 삭제됨`
              : `후보 ${row.candidateThumbs.length}장`}
          </p>
          <div className="flex gap-1.5">
            {row.candidateThumbs.map((u, i) => (
              <div
                key={i}
                className={`relative aspect-[3/4] w-20 overflow-hidden rounded-md border bg-foreground/10 ${
                  row.adminStatus === "picked" || row.pickedIndex === i
                    ? "border-emerald-500/60"
                    : "border-foreground/10"
                }`}
              >
                <FadeImg src={u} placeholder="shimmer" fit="contain" className="h-full w-full" />
                {row.pickedIndex === i && row.adminStatus === "picked" && (
                  <span className="absolute inset-x-0 bottom-0 bg-emerald-500/80 py-0.5 text-center text-[9px] font-bold text-white">
                    선택
                  </span>
                )}
              </div>
            ))}
          </div>
        </div>
      ) : (
        <p className="text-zinc-500">
          {row.adminStatus === "requested"
            ? "생성 진행 중 — 아직 후보 없음."
            : `후보 이미지 없음${row.candidateCount > 0 ? ` (후보 ${row.candidateCount}건 기록·만료/삭제)` : ""}.`}
        </p>
      )}

      {/* 실패 사유 */}
      {(row.adminStatus === "failed" || row.adminStatus === "rejected") && (
        <p className="text-red-500">
          실패 사유: {row.failReason ? (FAIL_KO[row.failReason] ?? row.failReason) : "미기록(0046 적용 전)"}
        </p>
      )}

      {/* 메타 */}
      <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-zinc-400">
        <span>gen id: <span className="font-mono">{row.id}</span></span>
        <span>회원 id: <span className="font-mono">{row.ownerId}</span></span>
        {row.pickedDollId && (
          <span>캐릭터 id: <span className="font-mono">{row.pickedDollId}</span></span>
        )}
        <span>생성: {timeShort(row.createdAt)}</span>
        {row.updatedAt && <span>갱신: {timeShort(row.updatedAt)}</span>}
      </div>
    </div>
  );
}
