"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 「캐릭터」 메뉴의 2차 탭 — 캐릭터 목록(결과, dolls) | 생성 현황(과정, ai_generations).
 * 그룹 레이아웃(app/admin/(characters)/layout.tsx)에 살아 탭 전환 중에도 유지된다(v1.30). 활성 탭은 현재 경로로 판단.
 */
const TABS = [
  { href: "/admin/dolls", label: "캐릭터 목록" },
  { href: "/admin/generations", label: "생성 현황" },
] as const;

export function CharacterTabs() {
  const pathname = usePathname();
  return (
    <nav aria-label="캐릭터 하위 탭" className="flex flex-wrap gap-1">
      {TABS.map((t) => {
        const active = pathname === t.href || pathname.startsWith(`${t.href}/`) || pathname.startsWith(`${t.href}?`);
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
