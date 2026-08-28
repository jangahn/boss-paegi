import Link from "next/link";
import {
  STAT_WINDOW_TABS,
  statWindowParam,
  type StatWindow,
} from "@/lib/admin-period";

/** 어드민 분석 공통 기간 탭(오늘/7일/30일/전체) — 기존 7/30 pill 스타일 유지.
 *  CJK 는 글자 사이 어디서나 줄바꿈되므로 nowrap+shrink-0 로 pill 내부 꺾임을 금지 —
 *  좁은 화면에선 헤더 행(flex-wrap)이 탭 묶음째 다음 줄로 내린다(iPhone SE 375px 기준). */
export function PeriodTabs({ basePath, current }: { basePath: string; current: StatWindow }) {
  return (
    <div className="flex shrink-0 gap-1 text-xs">
      {STAT_WINDOW_TABS.map((tab) => (
        <Link
          key={tab.label}
          href={`${basePath}?days=${statWindowParam(tab.window)}`}
          className={`whitespace-nowrap rounded-full px-3 py-1.5 font-medium transition ${
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
