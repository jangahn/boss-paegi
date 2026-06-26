"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountMenu } from "@/components/AccountMenu";

/**
 * 전역 네비게이션 — 홈/갤러리/랭킹 자유 이동 + 계정 메뉴(닉네임·로그인·아바타·로그아웃).
 * /play 는 몰입 화면이라 미장착 (게임 종료 보고서에서 이동 제공).
 */
export function AppNav() {
  const pathname = usePathname();

  const links = [
    { href: "/", label: "홈" },
    { href: "/gallery", label: "갤러리" },
    { href: "/leaderboard", label: "랭킹" },
  ];

  return (
    <nav className="sticky top-0 z-40 border-b border-foreground/10 bg-background/85 backdrop-blur-sm">
      <div className="mx-auto flex w-full max-w-2xl items-center justify-between gap-1.5 px-3 py-2.5 sm:px-4">
        <div className="flex items-center gap-0.5 sm:gap-1">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`whitespace-nowrap rounded-full px-2.5 py-1.5 text-sm font-medium transition sm:px-3 ${
                pathname === l.href
                  ? "bg-foreground text-background"
                  : "text-zinc-500 hover:bg-foreground/5 hover:text-foreground"
              }`}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <AccountMenu />
      </div>
    </nav>
  );
}
