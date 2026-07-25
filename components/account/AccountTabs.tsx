"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

/**
 * 마이페이지 2뎁스 탭바 — 회원정보(/account) · 결제내역(/account/payments) · 생성권 내역(/account/credits).
 * 스타일 토큰은 AppNav/AdminNav 와 동일(pill + active bg-foreground) — 일회성 스타일 금지.
 */
const TABS = [
  { href: "/account", label: "회원정보" },
  { href: "/account/payments", label: "결제내역" },
  { href: "/account/credits", label: "생성권 내역" },
];

export function AccountTabs() {
  const pathname = usePathname();
  return (
    <nav className="border-b border-foreground/10 bg-background/60">
      <div className="mx-auto flex w-full max-w-md gap-1 px-5 py-2">
        {TABS.map((t) => {
          const active =
            t.href === "/account" ? pathname === "/account" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              className={`whitespace-nowrap rounded-full px-3 py-1.5 text-sm font-medium transition ${
                active
                  ? "bg-foreground text-paper-2"
                  : "text-zinc-500 hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
