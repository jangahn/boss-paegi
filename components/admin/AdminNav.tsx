"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 어드민 서브 네비 — 멀티 라우트(/admin · /admin/orders · …) 이동.
 * 라우트가 추가되는 PR 마다 LINKS 에 항목을 더한다(없는 라우트로의 깨진 링크 방지).
 */
const LINKS = [
  { href: "/admin", label: "대시보드" },
  { href: "/admin/orders", label: "주문" },
  { href: "/admin/users", label: "회원" },
  { href: "/admin/ledger", label: "처리내역" },
  { href: "/admin/moderation", label: "신고" },
  { href: "/admin/content", label: "콘텐츠" },
  { href: "/admin/analytics", label: "게임 분석" },
];

export function AdminNav() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-foreground/10 bg-background/60">
      <div className="mx-auto flex w-full max-w-3xl gap-1 overflow-x-auto px-5 py-2">
        {LINKS.map((l) => {
          const active =
            l.href === "/admin" ? pathname === "/admin" : pathname.startsWith(l.href);
          return (
            <Link
              key={l.href}
              href={l.href}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-foreground text-paper-2"
                  : "text-zinc-500 hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              {l.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
