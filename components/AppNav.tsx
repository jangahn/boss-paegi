"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { AccountMenu } from "@/components/AccountMenu";

/**
 * 전역 네비게이션 — 홈/갤러리/랭킹 자유 이동 + 계정 메뉴(닉네임·로그인·아바타·로그아웃).
 * /play 는 몰입 화면이라 미장착 (게임 종료 보고서에서 이동 제공).
 */
// AppNav 미노출 라우트 — 몰입 게임(play)·인증/동의 플로우(login·signup·consent·reconsent)·
// 최소 공유 랜딩(share·doll). **/admin 도 root 에선 hide** — 어드민은 layout 이 theme-admin(다크)
// 안에서 forceShow 로 직접 렌더(라이트색 누수·double-nav 방지). 그 외(홈·갤러리·랭킹·소식·약관/
// 방침·계정 등)엔 root layout 에서 1회 렌더 → 내비 간 remount 제거; 여기서 라우트별 self-hide.
const NAV_HIDDEN_PREFIXES = ["/play", "/login", "/signup", "/consent", "/reconsent", "/share", "/doll", "/admin"];

// forceShow: 어드민 layout 이 theme-admin(다크) 안에서 직접 렌더할 때 hide 우회.
export function AppNav({ forceShow = false }: { forceShow?: boolean }) {
  const pathname = usePathname();
  if (!forceShow && NAV_HIDDEN_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"))) return null;

  const links = [
    { href: "/", label: "홈" },
    { href: "/gallery", label: "갤러리" },
    { href: "/leaderboard", label: "랭킹" },
    { href: "/news", label: "소식" },
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
                (l.href === "/" ? pathname === "/" : pathname.startsWith(l.href))
                  ? "bg-foreground text-paper-2"
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
