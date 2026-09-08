"use client";

import Link from "next/link";
import { FadeImg } from "@/components/FadeImg";
import { shortId, fmtKst } from "@/lib/admin-format";
import type { AdminDoll, DollState } from "@/lib/admin-dolls";
import { useRoleConfig } from "@/components/RoleContentProvider";
import { roleFrom } from "@/lib/config/domains/roles";
import { GENDER_SYMBOL } from "@/lib/gender";

/** 캐릭터 상태 칩 — 회원 상세 캐릭터 카드(DollsList)와 같은 색 규약(숨김 노랑·영구삭제 빨강·공개는 칩 없음). */
export const DOLL_STATE_META: Record<DollState, { label: string; cls: string } | null> = {
  public: null,
  hidden: { label: "숨김", cls: "bg-yellow-500/90 text-black" },
  purged: { label: "영구삭제", cls: "bg-red-500/90 text-white" },
};

export function DollStateChip({ state }: { state: DollState }) {
  const meta = DOLL_STATE_META[state];
  if (!meta) return null;
  return (
    <span className={`shrink-0 whitespace-nowrap rounded-full px-1.5 py-0.5 text-[9px] font-bold ${meta.cls}`}>
      {meta.label}
    </span>
  );
}

/**
 * 캐릭터 목록 행 — 썸네일·현재 롤·성별·상태·회원·생성일. 캐릭터를 가리키는 링크는 캐릭터 상세 한 곳으로(v1.29 규약).
 */
export function DollsTable({ rows }: { rows: AdminDoll[] }) {
  const cfg = useRoleConfig();
  return (
    <ul className="space-y-2">
      {rows.map((d) => (
        <li key={d.id} className="rounded-2xl border border-foreground/10 ui-surface p-3">
          <div className="flex gap-3">
            <Link
              href={`/admin/dolls/${d.id}`}
              className="flex aspect-[3/4] w-16 shrink-0 items-center justify-center overflow-hidden rounded-md border border-foreground/10 bg-foreground/10 text-xl"
              title="캐릭터 상세"
            >
              {d.thumb ? (
                <FadeImg
                  src={d.thumb}
                  placeholder="shimmer"
                  fit="contain"
                  className={`h-full w-full ${d.state === "hidden" ? "opacity-60" : ""}`}
                />
              ) : (
                <span aria-hidden>🗑️</span>
              )}
            </Link>
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Link href={`/admin/dolls/${d.id}`} className="font-semibold underline-offset-2 hover:underline">
                  {roleFrom(d.role, cfg).label} {GENDER_SYMBOL[d.gender]}
                </Link>
                <DollStateChip state={d.state} />
                <span className="shrink-0 text-[11px] text-zinc-400">{fmtKst(d.createdAt)}</span>
              </div>
              <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
                <Link
                  href={`/admin/dolls/${d.id}`}
                  className="rounded-full border border-foreground/15 px-2 py-0.5 font-mono text-zinc-500 transition hover:bg-foreground/10"
                  title="캐릭터 상세"
                >
                  캐릭터 {shortId(d.id)}
                </Link>
                <Link
                  href={`/admin/dolls?ownerId=${d.ownerId}`}
                  className="rounded-full border border-foreground/15 px-2 py-0.5 text-zinc-500 transition hover:bg-foreground/10"
                  title="이 회원의 캐릭터만 필터"
                >
                  회원 {d.ownerName ?? shortId(d.ownerId)}
                </Link>
                <Link href={`/admin/users/${d.ownerId}`} className="text-sky-600 underline-offset-2 hover:underline" title="회원 상세로 이동">
                  회원 →
                </Link>
              </div>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
