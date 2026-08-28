import Link from "next/link";
import {
  STAT_WINDOW_TABS,
  statWindowParam,
  type StatWindow,
} from "@/lib/admin-period";

/** 어드민 분석 공통 기간 탭(오늘/7일/30일/전체) — 기존 7/30 pill 스타일 유지. */
export function PeriodTabs({ basePath, current }: { basePath: string; current: StatWindow }) {
  return (
    <div className="flex gap-1 text-xs">
      {STAT_WINDOW_TABS.map((tab) => (
        <Link
          key={tab.label}
          href={`${basePath}?days=${statWindowParam(tab.window)}`}
          className={`rounded-full px-3 py-1.5 font-medium transition ${
            current === tab.window
              ? "bg-foreground text-paper-2"
              : "text-zinc-500 hover:bg-foreground/5"
          }`}
        >
          {tab.label}
        </Link>
      ))}
    </div>
  );
}
