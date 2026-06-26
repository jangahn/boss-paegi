"use client";

import Link from "next/link";
import { Spinner } from "@/components/Spinner";
import type { PendingGeneration } from "@/lib/generation";

// 미완결 생성 — 생성 중 / 고르기 대기 / 중단됨. (app/gallery/page.tsx 에서 분리·이동.)
export function PendingGrid({ pending }: { pending: PendingGeneration[] }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm font-semibold text-zinc-400">진행 중인 생성</p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
        {pending.map((p) => (
          <PendingCard key={p.id} gen={p} />
        ))}
      </div>
    </div>
  );
}

function PendingCard({ gen }: { gen: PendingGeneration }) {
  if (gen.kind === "generating") {
    return (
      <div className="flex aspect-square flex-col items-center justify-center gap-3 rounded-2xl border border-foreground/10 bg-paper-2">
        <Spinner className="h-7 w-7 text-foreground/70" />
        <span className="text-xs font-medium text-zinc-500">
          AI 가 만드는 중…
        </span>
      </div>
    );
  }
  if (gen.kind === "interrupted") {
    return (
      <Link
        href="/generate"
        className="flex aspect-square flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-amber-500/40 bg-amber-500/5 p-3 text-center transition hover:bg-amber-500/10"
      >
        <span className="text-2xl" aria-hidden>
          ⚠️
        </span>
        <span className="text-xs font-medium text-amber-700 dark:text-amber-300">
          생성이 중단됐어요
        </span>
        <span className="text-[11px] text-zinc-500">탭해서 다시 만들기</span>
      </Link>
    );
  }
  // ready — 3장 완성, 고르기 대기
  return (
    <Link
      href={`/generate?resume=${gen.id}`}
      className="group relative flex aspect-square flex-col overflow-hidden rounded-2xl border border-emerald-500/40 bg-paper-2 transition hover:border-emerald-500/70"
    >
      <div className="grid flex-1 grid-cols-3 gap-px bg-foreground/10">
        {gen.candidateUrls.slice(0, 3).map((url, i) => (
          // eslint-disable-next-line @next/next/no-img-element
          <img key={i} src={url} alt="" className="h-full w-full object-cover" />
        ))}
      </div>
      <div className="flex items-center justify-center gap-1 bg-emerald-500/15 py-1.5 text-xs font-semibold text-emerald-700 dark:text-emerald-300">
        고르던 인형 이어서 →
      </div>
    </Link>
  );
}
