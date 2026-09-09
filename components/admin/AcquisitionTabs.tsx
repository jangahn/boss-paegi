"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 「공유·유입」 메뉴의 2차 탭 — 집계(카드) | 원본 이벤트(analytics_events raw, v1.31).
 * 레이아웃(app/admin/acquisition/layout.tsx)에 살아 탭 전환 중에도 유지된다(「캐릭터」 2차 탭과 같은 패턴).
 */
const TABS = [
  { href: "/admin/acquisition", label: "집계", exact: true },
  { href: "/admin/acquisition/events", label: "원본 이벤트", exact: false },
] as const;

export function AcquisitionTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="공유·유입 하위 탭" className="flex flex-wrap gap-1">
      {TABS.map((t) => {
        const active = t.exact ? pathname === t.href : pathname === t.href || pathname.startsWith(`${t.href}/`);
        return (
          <Link
            key={t.href}
            href={t.href}
            aria-current={active ? "page" : undefined}
            className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition ${
              active ? "bg-foreground text-paper-2" : "bg-foreground/5 text-zinc-500 hover:bg-foreground/10"
            }`}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
