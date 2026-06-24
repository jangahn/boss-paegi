"use client";

import Link from "next/link";
import { ctaFor, type ViewerState } from "@/lib/gallery-cta";
import { useMarketingCopy } from "@/components/MarketingCopyProvider";

// 상태별 후킹 배너 — nonmember=가입 유도(생성권 N개), member-empty=첫 캐릭터 만들기 유도.
// member(캐릭터 보유)는 배너 없음(null). 문구는 마케터 편집(marketing_copy.signupBanner).
export function SignupBanner({ state }: { state: ViewerState }) {
  const banner = useMarketingCopy().signupBanner;
  if (state === "member") return null;
  const copy =
    state === "nonmember"
      ? { title: banner.nonmemberTitle, sub: banner.nonmemberSub }
      : { title: banner.memberEmptyTitle, sub: banner.memberEmptySub };
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
