"use client";

import Link from "next/link";
import { ctaFor, type ViewerState } from "@/lib/gallery-cta";

// 상태별 후킹 배너 — nonmember=가입 유도(생성권 2개), member-empty=첫 캐릭터 만들기 유도.
// member(캐릭터 보유)는 배너 없음(null).
const COPY: Record<
  Exclude<ViewerState, "member">,
  { title: string; sub: string }
> = {
  nonmember: {
    title: "가입하면 가입기념 생성권 2개를 드려요",
    sub: "내 사진으로 나만의 캐릭터를 만들고 공유·롤 변경까지!",
  },
  "member-empty": {
    title: "나만의 캐릭터를 만들어보세요",
    sub: "기본부장님 말고, 내 사진으로 만든 캐릭터로 플레이!",
  },
};

export function SignupBanner({ state }: { state: ViewerState }) {
  if (state === "member") return null;
  const copy = COPY[state];
  const cta = ctaFor(state);

  return (
    <div className="flex items-center justify-between gap-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-4">
      <div className="min-w-0">
        <p className="font-semibold">{copy.title}</p>
        <p className="mt-0.5 text-xs text-zinc-500">{copy.sub}</p>
      </div>
      <Link
        href={cta.href}
        className="shrink-0 rounded-full bg-foreground px-4 py-2 text-sm font-semibold text-background transition hover:opacity-90"
      >
        {cta.label}
      </Link>
    </div>
  );
}
